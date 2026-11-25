import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { combineTracks, concatMedia, isRemuxError, remuxMedia } from '../../src'
import type { RemuxOptions, RemuxProgress } from '../../src'
import { openMediaInput } from '../../src/core/input/openMediaInput'
import { diskStorage, fixture, memoryTarget, packets } from '../helpers/media'

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
    const source = await packets(input, kind, { applyAudioEdit: true })
    const output = await packets(target.blob(), kind)

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
  ['progressive.flv', 'flv-first'],
  ['progressive.flv', 'mp4-first'],
  ['progressive-mp3.flv', 'flv-first'],
  ['progressive-mp3.flv', 'mp4-first'],
])(
  'concatenates %s and its byte-preserving MP4 remux in %s order',
  async (name, order) => {
    const flv = await fixture(name)
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
  const beforeAudio = await packets(audio, 'audio', { applyAudioEdit: true })

  expect(
    beforeVideo.some(
      (packet, index) =>
        index > 0 &&
        packet.timestamp < (beforeVideo[index - 1]?.timestamp ?? 0),
    ),
  ).toBe(true)

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
      expect(packet.timestamp).toBeCloseTo(before[index]!.timestamp, 4)
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
  const before = await packets(blob, 'audio', { applyAudioEdit: true })
  const after = await packets(target.blob(), 'audio')

  expect(after.map(packet => packet.data)).toStrictEqual(
    before.map(packet => packet.data),
  )

  for (const [index, packet] of after.entries()) {
    expect(packet.timestamp).toBeCloseTo(before[index]!.timestamp, 4)
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
  ).rejects.toMatchObject({ code: 'INCOMPATIBLE_SEGMENTS' })
  expect(target.state.writes).toStrictEqual([])
  expect(target.writable.locked).toBe(false)
})

test.each(['progressive.mp4', 'progressive.flv', 'video.mp4'] as const)(
  'requires video and copies available tracks from %s',
  async name => {
    const input = await fixture(name)
    const target = memoryTarget()
    const result = await remuxMedia(input, {
      tracks: 'video-with-optional-audio',
      writable: target.writable,
      storage: await diskStorage(),
    })

    expect(result.mimeType).toBe('video/mp4')

    for (const kind of ['video', 'audio'] as const) {
      const source = await packets(input, kind, { applyAudioEdit: true })
      const output = await packets(target.blob(), kind)

      expect(output.map(packet => packet.data)).toStrictEqual(
        source.map(packet => packet.data),
      )
    }
  },
)

test.each([
  ['video-with-optional-audio', 44_100],
  ['first-video-with-optional-audio', 48_000],
] as const)(
  'uses %s to select the requested audio track',
  async (tracks, sampleRate) => {
    const input = await fixture('progressive-two-audio.mp4')
    const target = memoryTarget()

    await concatMedia([input, input], {
      tracks,
      writable: target.writable,
      storage: await diskStorage(),
    })

    const output = await openMediaInput(target.blob())

    try {
      expect(
        output.tracks.find(track => track.kind === 'audio')?.config,
      ).toMatchObject({ sampleRate })
    } finally {
      output.dispose()
    }
  },
)

test.each([
  'video-with-optional-audio',
  'first-video-with-optional-audio',
] as const)(
  'requires video in every segment before writing with %s',
  async tracks => {
    const audio = await fixture('audio.m4a')
    const video = await fixture('video.mp4')
    const target = memoryTarget()
    const options: RemuxOptions = {
      tracks,
      writable: target.writable,
      storage: await diskStorage(),
    }

    await expect(remuxMedia(audio, options)).rejects.toSatisfy(
      (error: unknown) =>
        isRemuxError(error) && error.code === 'MISSING_REQUIRED_TRACK',
    )
    await expect(concatMedia([video, audio], options)).rejects.toMatchObject({
      code: 'MISSING_REQUIRED_TRACK',
    })
    await expect(
      concatMedia([video, await fixture('progressive.mp4')], options),
    ).rejects.toMatchObject({
      code: 'INCOMPATIBLE_SEGMENTS',
    })
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  },
)

test('rejects an AAC sample-rate change in copy mode before writing', async () => {
  const inputs = await Promise.all([
    fixture('progressive.mp4'),
    fixture('progressive-two-audio.mp4'),
  ])
  const target = memoryTarget()

  await expect(
    concatMedia(inputs, {
      tracks: 'video-with-optional-audio',
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toMatchObject({ code: 'INCOMPATIBLE_SEGMENTS' })
  expect(target.state.writes).toStrictEqual([])
  expect(target.writable.locked).toBe(false)
})

test('reports an unrecognized container with a stable code', async () => {
  await expect(
    remuxMedia(new Blob(['unrecognized file']), {
      storage: await diskStorage(),
      writable: memoryTarget().writable,
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTAINER' })
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
    remuxMedia(flv, {
      tracks: '' as 'all',
      storage,
      writable: memoryTarget().writable,
    }),
  ).rejects.toThrow('Unsupported media track selection')
  await expect(
    remuxMedia(flv.slice(0, flv.size - 1), {
      storage,
      writable: memoryTarget().writable,
    }),
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: 'Truncated FLV file.',
  })
  await expect(
    remuxMedia(await fixture('audio.m4a'), {
      tracks: 'video',
      storage,
      writable: memoryTarget().writable,
    }),
  ).rejects.toThrow('no selected')
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
      'progressive-mp3.flv',
      'progressive-ac3.mp4',
      'progressive.mkv',
      'continuous-av.mpegts',
      'vfr-bframes.mp4',
      'subtitle-first.mp4',
      'hevc-hvc1.mp4',
      'hevc-hev1.mp4',
      'av1-main10.mp4',
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
