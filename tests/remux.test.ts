import { execFile } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../src'
import type { RemuxOptions, RemuxProgress, RemuxResult } from '../src'
import { fixture, diskStorage, memoryTarget, packets } from './helpers/media'
import { fragmentedMp4 } from './helpers/mp4Fragments'

test('keeps the submitted segment list when the caller clears its selection during progress', async () => {
  const video = await fixture('video.mp4')
  const inputs = [video, video]
  const target = memoryTarget()
  const result = await concatMedia(inputs, {
    writable: target.writable,
    storage: await diskStorage(),
    onProgress(progress) {
      if (progress.phase === 'remux') {
        inputs.length = 0
      }
    },
  })
  const source = await packets(video, 'video')
  const output = await packets(target.blob(), 'video')

  expect(inputs).toHaveLength(0)
  expect(output).toHaveLength(source.length * 2)
  expect(output.map(packet => packet.data)).toStrictEqual(
    [...source, ...source].map(packet => packet.data),
  )
  expect(result.duration).toBe(4)
})

test('keeps track selection fixed when the caller updates its options during progress', async () => {
  const input = await fixture('progressive.mp4')
  const target = memoryTarget()
  const options: RemuxOptions = {
    tracks: 'all',
    writable: target.writable,
    storage: await diskStorage(),
    onProgress(progress) {
      if (progress.phase === 'remux') {
        options.tracks = 'audio'
      }
    },
  }
  await concatMedia([input, input], options)

  for (const kind of ['video', 'audio'] as const) {
    const source = await packets(input, kind)
    const output = await packets(target.blob(), kind)
    expect(output).toHaveLength(source.length * 2)
    expect(output.map(packet => packet.data)).toStrictEqual(
      [...source, ...source].map(packet => packet.data),
    )
  }
})

test('captures options exposed through prototype accessors', async () => {
  const target = memoryTarget()
  const storage = await diskStorage()
  class Options {
    private outputTarget = target
    private remuxStorage = storage

    public get writable() {
      return this.outputTarget.writable
    }

    public get storage() {
      return this.remuxStorage
    }
  }
  const result = await remuxMedia(await fixture('audio.m4a'), new Options())

  expect(result.bytesProcessed).toBeGreaterThan(0)
  expect(result.mimeType).toBe('audio/mp4')
  expect(target.state.isClosed).toBe(true)
})

test.each([
  'truncated-header',
  'truncated-large-header',
  'invalid-box-size',
  'oversized-mdat',
  'unsafe-large-mdat',
] as const)(
  'rejects %s in fragmented MP4 before touching remux or concat output',
  async variant => {
    const fragmented = await fragmentedMp4({ fragments: 3, indexed: false })
    const original = fragmented.blob()
    let bytes = new Uint8Array(await original.arrayBuffer())
    const lastMoof = fragmented.fragmentOffset(1, 2)
    const mdat = Buffer.from(bytes).indexOf('mdat') - 4
    expect(mdat).toBeGreaterThan(0)
    if (variant === 'truncated-header') {
      bytes = bytes.slice(0, lastMoof + 4)
    } else if (variant === 'truncated-large-header') {
      bytes = bytes.slice(0, lastMoof + 12)
      new DataView(bytes.buffer).setUint32(lastMoof, 1)
    } else if (variant === 'invalid-box-size') {
      new DataView(bytes.buffer).setUint32(lastMoof, 4)
    } else {
      const view = new DataView(bytes.buffer)
      if (variant === 'oversized-mdat') {
        view.setUint32(mdat, bytes.length + 1)
      } else {
        view.setUint32(mdat, 1)
        view.setBigUint64(mdat + 8, 2n ** 53n)
      }
    }
    const malformed = new Blob([bytes])
    for (const inputs of [[malformed], [original, malformed]]) {
      const target = memoryTarget()
      const options = {
        writable: target.writable,
        storage: await diskStorage(),
      }
      await expect(
        inputs.length === 1
          ? remuxMedia(malformed, options)
          : concatMedia(inputs, options),
      ).rejects.toBeInstanceOf(RangeError)
      expect(target.state.writes).toStrictEqual([])
      expect(target.state.isClosed).toBe(false)
      expect(target.state.isAborted).toBe(false)
      expect(target.writable.locked).toBe(false)
    }
  },
)

test.each(['mdat', 'free'] as const)(
  'accepts a terminal size-zero %s box without losing packets',
  async kind => {
    const fragmented = await fragmentedMp4({ fragments: 3, indexed: false })
    const original = fragmented.blob()
    const bytes = new Uint8Array(await original.arrayBuffer())
    const mdat = Buffer.from(bytes).lastIndexOf('mdat') - 4
    expect(mdat).toBeGreaterThan(0)
    let blob: Blob
    if (kind === 'mdat') {
      new DataView(bytes.buffer).setUint32(mdat, 0)
      blob = new Blob([bytes])
    } else {
      blob = new Blob([bytes, Uint8Array.of(0, 0, 0, 0), 'free', 'padding'])
    }
    const target = memoryTarget()
    const result = await remuxMedia(blob, {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const before = await packets(original, 'audio')
    const after = await packets(target.blob(), 'audio')
    expect(after).toHaveLength(9)
    expect(after).toStrictEqual(before)
    expect(result.duration).toBe(0.192)
    expect(target.state.isClosed).toBe(true)
    expect(target.writable.locked).toBe(false)
  },
)

test.each(['stts', 'stsc', 'stco'] as const)(
  'rejects an undersized empty %s initialization table before touching remux or concat output',
  async name => {
    const fragmented = await fragmentedMp4({ fragments: 3, indexed: false })
    const original = fragmented.blob()
    const bytes = Buffer.from(await original.arrayBuffer())
    // Empty regular tables are valid in fragmented initialization metadata, but
    // invalid headers must still reject rather than hide the remaining tables.
    const offset = bytes.indexOf(name)
    expect(offset).toBeGreaterThan(0)
    bytes.writeUInt32BE(4, offset - 4)
    const malformed = new Blob([bytes])

    for (const inputs of [[malformed], [original, malformed]]) {
      const target = memoryTarget()
      const options = {
        writable: target.writable,
        storage: await diskStorage(),
      }
      await expect(
        inputs.length === 1
          ? remuxMedia(malformed, options)
          : concatMedia(inputs, options),
      ).rejects.toBeInstanceOf(RangeError)
      expect(target.state.writes).toStrictEqual([])
      expect(target.state.isClosed).toBe(false)
      expect(target.state.isAborted).toBe(false)
      expect(target.writable.locked).toBe(false)
    }
  },
)

test('rejects backwards fragment timestamps before touching any core output', async () => {
  const fragmented = await fragmentedMp4({ fragments: 3, indexed: false })
  const original = fragmented.blob()
  const bytes = Buffer.from(await original.arrayBuffer())
  const offset = bytes.indexOf('tfdt', fragmented.fragmentOffset(1, 1))
  expect(offset).toBeGreaterThan(0)
  bytes.writeBigUInt64BE(0n, offset + 8)
  const malformed = new Blob([bytes])
  const video = await fixture('video.mp4')

  for (const operation of ['remux', 'concat', 'combine'] as const) {
    const target = memoryTarget()
    const options = {
      writable: target.writable,
      storage: await diskStorage(),
    }
    let job: Promise<RemuxResult>
    if (operation === 'combine') {
      job = combineTracks(video, malformed, options)
    } else if (operation === 'concat') {
      job = concatMedia([original, malformed], options)
    } else {
      job = remuxMedia(malformed, options)
    }
    await expect(job).rejects.toThrow('previous GOP')
    expect(target.state.writes).toStrictEqual([])
    expect(target.state.isClosed).toBe(false)
    expect(target.state.isAborted).toBe(false)
    expect(target.writable.locked).toBe(false)
  }
})

test.each(['flv-first', 'mp4-first'] as const)(
  'concatenates an FLV and its byte-preserving MP4 remux in %s order',
  async order => {
    const flv = await fixture('progressive.flv')
    const remuxed = memoryTarget()
    const summary = await remuxMedia(flv, {
      writable: remuxed.writable,
      storage: await diskStorage(),
    })
    const mp4 = remuxed.blob()
    const video = await packets(flv, 'video')
    const audio = await packets(flv, 'audio')
    expect(video.length).toBeGreaterThan(0)
    expect(audio.length).toBeGreaterThan(0)
    const sourcePackets = [...video, ...audio]
    const start = Math.min(...sourcePackets.map(packet => packet.timestamp))
    const duration =
      Math.max(
        ...sourcePackets.map(packet => packet.timestamp + packet.duration),
      ) - start
    expect(summary.duration).toBeCloseTo(duration, 4)
    const inputs = order === 'flv-first' ? [flv, mp4] : [mp4, flv]
    const target = memoryTarget()
    const result = await concatMedia(inputs, {
      writable: target.writable,
      storage: await diskStorage(),
    })

    for (const [kind, source] of [
      ['video', video],
      ['audio', audio],
    ] as const) {
      const output = await packets(target.blob(), kind)
      expect(output.map(packet => packet.data)).toStrictEqual(
        [...source, ...source].map(packet => packet.data),
      )
      for (const segment of [0, 1]) {
        for (const [index, packet] of source.entries()) {
          const copied = output[segment * source.length + index]!
          expect(copied.timestamp).toBeCloseTo(
            packet.timestamp - start + segment * duration,
            4,
          )
          expect(copied.type).toBe(packet.type)
        }
      }
    }
    expect(result.duration).toBeCloseTo(duration * 2, 4)
    expect(target.state.isClosed).toBe(true)
    expect(target.state.isAborted).toBe(false)
    expect(target.writable.locked).toBe(false)
  },
)

test.each(['stts', 'stsc', 'stss', 'stco', 'tfhd', 'trun'] as const)(
  'rejects an undersized nested %s box before touching remux or concat output',
  async name => {
    const fragmented = await fragmentedMp4({ fragments: 3, indexed: false })
    const isFragmentBox = name === 'tfhd' || name === 'trun'
    const original = isFragmentBox
      ? fragmented.blob()
      : await fixture('video.mp4')
    const bytes = Buffer.from(await original.arrayBuffer())
    const offset = bytes.indexOf(
      name,
      isFragmentBox ? fragmented.fragmentOffset(1, 1) : 0,
    )
    expect(offset).toBeGreaterThan(0)
    bytes.writeUInt32BE(4, offset - 4)
    const malformed = new Blob([bytes])

    for (const inputs of [[malformed], [original, malformed]]) {
      const target = memoryTarget()
      const options = {
        writable: target.writable,
        storage: await diskStorage(),
      }
      await expect(
        inputs.length === 1
          ? remuxMedia(malformed, options)
          : concatMedia(inputs, options),
      ).rejects.toBeInstanceOf(RangeError)
      expect(target.state.writes).toStrictEqual([])
      expect(target.state.isClosed).toBe(false)
      expect(target.state.isAborted).toBe(false)
      expect(target.writable.locked).toBe(false)
    }
  },
)

test('remuxes every regular and fragmented sample in a hybrid MP4', async () => {
  const input = await fixture('hybrid.mp4')
  const target = memoryTarget()
  const result = await remuxMedia(input, {
    writable: target.writable,
    storage: await diskStorage(),
  })
  const source = await packets(input, 'video')
  const output = await packets(target.blob(), 'video')
  expect(source).toHaveLength(75)
  expect(output).toHaveLength(75)
  expect(output.map(packet => packet.data)).toStrictEqual(
    source.map(packet => packet.data),
  )
  const start = Math.min(...source.map(packet => packet.timestamp))
  for (const [index, packet] of output.entries()) {
    expect(packet.timestamp).toBeCloseTo(source[index]!.timestamp - start, 4)
    expect(packet.duration).toBeCloseTo(source[index]!.duration, 4)
  }
  expect(result.duration).toBeCloseTo(3, 4)
})

test.each(['stts-short', 'stts-long', 'stsc-short', 'stsc-long'])(
  'rejects inconsistent MP4 sample counts (%s) before touching output',
  async variant => {
    const bytes = new Uint8Array(
      await (await fixture('video.mp4')).arrayBuffer(),
    )
    const view = new DataView(bytes.buffer)
    const name = variant.startsWith('stts') ? 'stts' : 'stsc'
    const offset = Buffer.from(bytes).indexOf(name)
    expect(offset).toBeGreaterThan(0)
    // The fixture has one timing run; stsc's first row starts at chunk one.
    const field = offset + (name === 'stts' ? 12 : 16)
    view.setUint32(
      field,
      variant.endsWith('short') ? 1 : view.getUint32(field) + 1,
    )
    const target = memoryTarget()
    await expect(
      remuxMedia(new Blob([bytes]), {
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toThrow('sample counts')
    expect(target.state.writes).toStrictEqual([])
    expect(target.state.isClosed).toBe(false)
    expect(target.state.isAborted).toBe(false)
    expect(target.writable.locked).toBe(false)
  },
)

test.each(['regular', 'fragmented'] as const)(
  'rejects truncated %s MP4 payloads before touching output',
  async format => {
    const input =
      format === 'regular'
        ? await fixture('video.mp4')
        : (await fragmentedMp4({ fragments: 2, indexed: false })).blob()
    const truncated = input.slice(0, input.size - 1)
    for (const inputs of [[truncated], [input, truncated]]) {
      const target = memoryTarget()
      await expect(
        concatMedia(inputs, {
          writable: target.writable,
          storage: await diskStorage(),
        }),
      ).rejects.toThrow('sample payload')
      expect(target.state.writes).toStrictEqual([])
      expect(target.state.isClosed).toBe(false)
      expect(target.state.isAborted).toBe(false)
      expect(target.writable.locked).toBe(false)
    }
  },
)

test('rejects video beginning with a dependent frame before touching output', async () => {
  const input = await fixture('leading-delta.mp4')
  const target = memoryTarget()
  await expect(
    remuxMedia(input, {
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toThrow('begin with a keyframe')
  expect(target.state.writes).toStrictEqual([])
  expect(target.writable.locked).toBe(false)
})

test.each(['empty', 'malformed'] as const)(
  'releases the video input when opening %s audio fails',
  async kind => {
    const audio = kind === 'empty' ? new Blob() : new Blob(['invalid media'])
    const controller = new AbortController()
    const target = memoryTarget()
    await expect(
      combineTracks(await fixture('video.mp4'), audio, {
        signal: controller.signal,
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toThrow(
      kind === 'empty' ? 'nonempty Blob' : 'unsupported or unrecognizable',
    )
    const listeners = getEventListeners(controller.signal, 'abort')
    controller.abort()
    expect(listeners).toStrictEqual([])
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  },
)

test('combines real H.264/AAC without changing encoded bytes or B-frame decode order', async () => {
  const video = await fixture('video.mp4')
  const audio = await fixture('audio.m4a')
  const target = memoryTarget()
  const progress: RemuxProgress[] = []
  const result = await combineTracks(video, audio, {
    storage: await diskStorage(),
    writable: target.writable,
    onProgress: event => progress.push(event),
  })
  const beforeVideo = await packets(video, 'video')
  const beforeAudio = await packets(audio, 'audio')
  expect(
    beforeVideo.some(
      (packet, index) =>
        index > 0 &&
        packet.timestamp < (beforeVideo[index - 1]?.timestamp ?? 0),
    ),
  ).toBe(true)
  const start = Math.min(
    ...beforeVideo.map(packet => packet.timestamp),
    ...beforeAudio.map(packet => packet.timestamp),
  )
  for (const [kind, before] of [
    ['video', beforeVideo],
    ['audio', beforeAudio],
  ] as const) {
    const after = await packets(target.blob(), kind)
    expect(after.map(packet => packet.data)).toStrictEqual(
      before.map(packet => packet.data),
    )
    expect(after.map(packet => packet.type)).toStrictEqual(
      before.map(packet => packet.type),
    )
    for (const [index, packet] of after.entries()) {
      expect(packet.timestamp).toBeCloseTo(
        (before[index]?.timestamp ?? 0) - start,
        4,
      )
      expect(packet.duration).toBeCloseTo(before[index]?.duration ?? 0, 4)
    }
  }
  expect(result.mimeType).toBe('video/mp4')
  expect(result.bytesProcessed).toBeGreaterThan(0)
  expect(target.state.isClosed).toBe(true)
  expect(target.writable.locked).toBe(false)
  expect(target.state.writes.every(size => size <= 1024 * 1024)).toBe(true)
  expect(progress.at(-1)?.phase).toBe('finalize')
})

test('extracts an AAC track from progressive MP4 to audio-only fragmented M4A', async () => {
  const blob = await fixture('progressive.mp4')
  const target = memoryTarget()
  const result = await remuxMedia(blob, {
    tracks: 'audio',
    writable: target.writable,
    storage: await diskStorage(),
  })
  const before = await packets(blob, 'audio')
  const after = await packets(target.blob(), 'audio')
  expect(after.map(packet => packet.data)).toStrictEqual(
    before.map(packet => packet.data),
  )
  for (const [index, packet] of after.entries()) {
    expect(packet.timestamp).toBeCloseTo(
      (before[index]?.timestamp ?? 0) - (before[0]?.timestamp ?? 0),
      4,
    )
  }
  await expect(packets(target.blob(), 'video')).resolves.toStrictEqual([])
  expect(result.mimeType).toBe('audio/mp4')
})

test.each(['progressive.mp4', 'progressive.flv', 'long-gop.mp4'])(
  'remuxes and concatenates %s using disk-backed samples',
  async name => {
    const input = await fixture(name)
    const source = await packets(input, 'video')
    const target = memoryTarget()
    const result = await concatMedia([input, input], {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const output = await packets(target.blob(), 'video')
    expect(output).toHaveLength(source.length * 2)
    expect(output.map(packet => packet.data)).toStrictEqual(
      [...source, ...source].map(packet => packet.data),
    )
    const shift =
      (output[source.length]?.timestamp ?? 0) - (output[0]?.timestamp ?? 0)
    expect(shift).toBeGreaterThan(0)
    for (let index = 0; index < source.length; index++) {
      expect(
        (output[index + source.length]?.timestamp ?? 0) -
          (output[index]?.timestamp ?? 0),
      ).toBeCloseTo(shift, 4)
    }
    expect(result.duration).toBeGreaterThan(0)
    // Exercise paged fragmented-input reading by remuxing our own output again.
    const repeated = memoryTarget()
    await remuxMedia(target.blob(), {
      writable: repeated.writable,
      storage: await diskStorage(),
    })
    expect(
      (await packets(repeated.blob(), 'video')).map(packet => packet.data),
    ).toStrictEqual(output.map(packet => packet.data))
  },
)

test('rejects incompatible segments before writing any output', async () => {
  const target = memoryTarget()
  await expect(
    concatMedia([await fixture('video.mp4'), await fixture('audio.m4a')], {
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toThrow('Incompatible')
  expect(target.state.writes).toStrictEqual([])
  expect(target.writable.locked).toBe(false)
})

test('rejects empty/truncated FLV and invalid track selection', async () => {
  const storage = await diskStorage()
  await expect(
    concatMedia([], { storage, writable: memoryTarget().writable }),
  ).rejects.toThrow('At least one')
  await expect(
    remuxMedia(new Blob(), { storage, writable: memoryTarget().writable }),
  ).rejects.toThrow('nonempty Blob')
  const flv = await fixture('progressive.flv')
  await expect(
    remuxMedia(flv.slice(0, flv.size - 1), {
      storage,
      writable: memoryTarget().writable,
    }),
  ).rejects.toThrow('Truncated FLV')
  await expect(
    remuxMedia(await fixture('audio.m4a'), {
      tracks: 'video',
      storage,
      writable: memoryTarget().writable,
    }),
  ).rejects.toThrow('no selected')
})

test('preserves the abort reason and aborts/unlocks a partially written output', async () => {
  const controller = new AbortController()
  const reason = new Error('test cancellation')
  const target = memoryTarget()
  await expect(
    remuxMedia(await fixture('video.mp4'), {
      writable: target.writable,
      storage: await diskStorage(),
      signal: controller.signal,
      onProgress(progress) {
        if (progress.phase === 'remux') {
          controller.abort(reason)
        }
      },
    }),
  ).rejects.toBe(reason)
  expect(target.state.isAborted).toBe(true)
  expect(target.state.isClosed).toBe(false)
  expect(target.writable.locked).toBe(false)
})

test('propagates output I/O failures and releases the stream lock', async () => {
  const failure = new Error('disk full')
  const writable = new WritableStream({
    write() {
      throw failure
    },
  })
  await expect(
    remuxMedia(await fixture('video.mp4'), {
      writable,
      storage: await diskStorage(),
    }),
  ).rejects.toBe(failure)
  expect(writable.locked).toBe(false)
})

test('produces files independently accepted and decoded by FFmpeg when available', async context => {
  const exec = promisify(execFile)
  try {
    await exec('ffmpeg', ['-version'])
  } catch {
    context.skip()
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'media-remux-decode-'))
  try {
    for (const name of [
      'progressive.mp4',
      'progressive.flv',
      'vfr-bframes.mp4',
      'subtitle-first.mp4',
    ]) {
      const target = memoryTarget()
      const input = await fixture(name)
      await concatMedia([input, input], {
        writable: target.writable,
        storage: await diskStorage(),
      })
      const path = join(directory, `${name}.mp4`)
      await writeFile(path, new Uint8Array(await target.blob().arrayBuffer()))
      const { stderr } = await exec('ffmpeg', [
        '-v',
        'error',
        '-xerror',
        '-i',
        path,
        '-f',
        'null',
        '-',
      ])
      expect(stderr).toBe('')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
