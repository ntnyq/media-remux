import { expect, test } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../src'
import type { RemuxResult } from '../src'
import { diskStorage, fixture, memoryTarget, packets } from './helpers/media'

interface Edit {
  duration?: number
  mediaTime?: number
  mediaRate?: number
}

/**
 * Replaces a fixture's first track edit list while keeping sample offsets valid.
 * The original moov becomes padding and the modified moov is appended at EOF.
 *
 * @param edits - Entries whose duration is in seconds and mediaTime is in track
 * units. Omitted fields retain the fixture's original entry values.
 * @param version - Edit list field width: 32-bit for v0 or 64-bit for v1.
 * @param sourceName - Source fixture filename; defaults to video.mp4.
 * @returns A real MP4 with the requested playback mapping.
 */
async function editedMedia(
  edits: readonly Edit[],
  version: 0 | 1,
  sourceName = 'video.mp4',
) {
  const original = Buffer.from(await (await fixture(sourceName)).arrayBuffer())
  const moovStart = original.indexOf('moov') - 4
  const editStart = original.indexOf('elst') - 4
  const movieHeader = original.indexOf('mvhd')
  expect(moovStart).toBeGreaterThan(0)
  expect(editStart).toBeGreaterThan(moovStart)
  expect(original[editStart + 8]).toBe(0)
  expect(original.readUInt32BE(editStart + 12)).toBe(1)

  const timescale = original.readUInt32BE(movieHeader + 16)
  const duration = original.readUInt32BE(editStart + 16)
  const mediaTime = original.readInt32BE(editStart + 20)
  const entrySize = version === 1 ? 20 : 12
  const editList = Buffer.alloc(16 + entrySize * edits.length)
  editList.writeUInt32BE(editList.length)
  editList.write('elst', 4, 'ascii')
  editList[8] = version
  editList.writeUInt32BE(edits.length, 12)

  for (const [index, edit] of edits.entries()) {
    const offset = 16 + index * entrySize
    const segmentDuration =
      edit.duration === undefined ? duration : edit.duration * timescale
    const start = edit.mediaTime ?? mediaTime
    if (version === 1) {
      editList.writeBigUInt64BE(BigInt(segmentDuration), offset)
      editList.writeBigInt64BE(BigInt(start), offset + 8)
    } else {
      editList.writeUInt32BE(segmentDuration, offset)
      editList.writeInt32BE(start, offset + 4)
    }
    editList.writeInt32BE(
      (edit.mediaRate ?? 1) * 65_536,
      offset + entrySize - 4,
    )
  }

  const originalSize = original.readUInt32BE(editStart)
  const moov = Buffer.concat([
    original.subarray(moovStart, editStart),
    editList,
    original.subarray(
      editStart + originalSize,
      moovStart + original.readUInt32BE(moovStart),
    ),
  ])
  for (const name of ['moov', 'trak', 'edts']) {
    const offset = moov.indexOf(name) - 4
    moov.writeUInt32BE(
      moov.readUInt32BE(offset) + editList.length - originalSize,
      offset,
    )
  }
  const totalDuration = edits.reduce(
    (total, edit) =>
      total +
      (edit.duration === undefined ? duration : edit.duration * timescale),
    0,
  )
  moov.writeUInt32BE(totalDuration, moov.indexOf('mvhd') + 20)
  moov.writeUInt32BE(totalDuration, moov.indexOf('tkhd') + 24)
  original.write('free', moovStart + 4, 'ascii')

  return new Blob([original, moov])
}

/**
 * Adds a media edit to a real fragmented video, preserving relative payload offsets.
 *
 * @param duration - Media edit duration in seconds; zero is open-ended.
 * @param version - Edit list field width: 32-bit for v0 or 64-bit for v1.
 * @returns Edited input and the unedited fragmented video for packet comparisons.
 */
async function fragmentedEditedMedia(duration: number, version: 0 | 1) {
  const target = memoryTarget()
  await remuxMedia(await fixture('video.mp4'), {
    writable: target.writable,
    storage: await diskStorage(),
  })
  const original = Buffer.from(await target.blob().arrayBuffer())
  const moovStart = original.indexOf('moov') - 4
  const trakStart = original.indexOf('trak') - 4
  const trakEnd = trakStart + original.readUInt32BE(trakStart)
  const mvhd = original.indexOf('mvhd')
  const movieTimescale = original.readUInt32BE(
    mvhd + (original[mvhd + 4] === 1 ? 24 : 16),
  )
  const edited = Buffer.from(
    await (
      await editedMedia([{ duration, mediaTime: 0 }], version)
    ).arrayBuffer(),
  )
  const edtsStart = edited.lastIndexOf('edts') - 4
  expect(edtsStart).toBeGreaterThan(0)
  const edts = edited.subarray(
    edtsStart,
    edtsStart + edited.readUInt32BE(edtsStart),
  )
  const elst = edts.indexOf('elst')
  if (version === 1) {
    edts.writeBigUInt64BE(BigInt(duration * movieTimescale), elst + 12)
  } else {
    edts.writeUInt32BE(duration * movieTimescale, elst + 12)
  }
  // Fragment payloads use moof-relative offsets and move with their moofs.
  // Discard the optional TFRA index, whose absolute offsets would be stale.
  const bytes = Buffer.concat([
    original.subarray(0, trakEnd),
    edts,
    original.subarray(trakEnd),
  ])
  for (const offset of [moovStart, trakStart]) {
    bytes.writeUInt32BE(bytes.readUInt32BE(offset) + edts.length, offset)
  }
  const mfra = bytes.lastIndexOf('mfra')
  expect(mfra).toBeGreaterThan(0)
  bytes.write('free', mfra, 'ascii')

  return { input: new Blob([bytes]), original: target.blob() }
}

test.each([0, 1] as const)(
  'rejects unsupported v%s edit lists before touching any core output',
  async version => {
    const original = await fixture('video.mp4')
    const audio = await fixture('audio.m4a')
    const cases = [
      { edits: [{}, {}], error: /multiple edits/u },
      { edits: [{}, { mediaTime: -1 }], error: /multiple edits/u },
      { edits: [{ mediaRate: 0 }], error: /media rate must be 1/u },
      {
        edits: [{ mediaRate: 0.5, duration: 4 }],
        error: /media rate must be 1/u,
      },
      {
        edits: [{ mediaRate: 2, duration: 1 }],
        error: /media rate must be 1/u,
      },
      { edits: [{ duration: 0.5 }], error: /media edit trims/u },
      { edits: [{ duration: 1.99 }], error: /media edit trims/u },
      {
        edits: [{ mediaTime: -1, duration: 0.75 }, { duration: 0.5 }],
        error: /media edit trims/u,
      },
      {
        edits: [{ mediaTime: 13_312, duration: 1 }],
        error: /trims video/u,
      },
      {
        edits: [{ mediaTime: -1, duration: 2 }],
        error: /no media edit/u,
      },
    ] satisfies { edits: Edit[]; error: RegExp }[]

    for (const { edits, error } of cases) {
      const input = await editedMedia(edits, version)
      for (const operation of ['remux', 'concat', 'combine'] as const) {
        const target = memoryTarget()
        const options = {
          writable: target.writable,
          storage: await diskStorage(),
        }
        let job: Promise<RemuxResult>
        if (operation === 'combine') {
          job = combineTracks(input, audio, options)
        } else if (operation === 'concat') {
          job = concatMedia([original, input], options)
        } else {
          job = remuxMedia(input, options)
        }
        await expect(job).rejects.toThrow(error)
        expect(target.state.writes).toStrictEqual([])
        expect(target.state.isClosed).toBe(false)
        expect(target.state.isAborted).toBe(false)
        expect(target.writable.locked).toBe(false)
      }
    }
  },
)

test.each([0, 1] as const)(
  'preserves v%s leading empty edits and a single unit-rate media edit',
  async version => {
    const delay = 0.75
    const input = await editedMedia(
      [{ mediaTime: -1, duration: 0.25 }, { mediaTime: -1, duration: 0.5 }, {}],
      version,
    )
    const audio = await fixture('audio.m4a')
    const videoPackets = await packets(await fixture('video.mp4'), 'video')
    const audioPackets = await packets(audio, 'audio')
    const start = Math.min(
      ...videoPackets.map(packet => packet.timestamp + delay),
      ...audioPackets.map(packet => packet.timestamp),
    )
    const end = Math.max(
      ...videoPackets.map(packet => packet.timestamp + delay + packet.duration),
      ...audioPackets.map(packet => packet.timestamp + packet.duration),
    )
    const target = memoryTarget()
    const result = await combineTracks(input, audio, {
      writable: target.writable,
      storage: await diskStorage(),
    })

    for (const [kind, source, shift] of [
      ['video', videoPackets, delay],
      ['audio', audioPackets, 0],
    ] as const) {
      const output = await packets(target.blob(), kind)
      expect(output.map(packet => packet.data)).toStrictEqual(
        source.map(packet => packet.data),
      )
      for (const [index, packet] of output.entries()) {
        expect(packet.timestamp).toBeCloseTo(
          source[index]!.timestamp + shift - start,
          4,
        )
      }
    }
    expect(result.duration).toBeCloseTo(end - start, 4)
    expect(target.state.isClosed).toBe(true)
    expect(target.writable.locked).toBe(false)
  },
)

test.each([0, 1] as const)(
  'rejects v%s AAC tail trimming during preflight',
  async version => {
    const input = await editedMedia([{ duration: 0.5 }], version, 'audio.m4a')
    const target = memoryTarget()

    await expect(
      remuxMedia(input, {
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toThrow(/media edit trims/u)
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  },
)

test.each([0, 1] as const)(
  'discards a v%s trimmed video track when only audio is selected',
  async version => {
    const input = await editedMedia(
      [{ duration: 0.5 }],
      version,
      'progressive.mp4',
    )
    const target = memoryTarget()
    await remuxMedia(input, {
      tracks: 'audio',
      writable: target.writable,
      storage: await diskStorage(),
    })

    const source = await packets(await fixture('progressive.mp4'), 'audio')
    const output = await packets(target.blob(), 'audio')
    expect(output.map(packet => packet.data)).toStrictEqual(
      source.map(packet => packet.data),
    )
    expect(output[0]!.timestamp).toBe(0)
    expect(target.state.isClosed).toBe(true)
  },
)

test.each([0, 1] as const)(
  'preserves a v%s zero-duration media edit as an open-ended offset',
  async version => {
    const input = await editedMedia([{ duration: 0 }], version)
    const target = memoryTarget()
    const result = await remuxMedia(input, {
      writable: target.writable,
      storage: await diskStorage(),
    })

    const source = await packets(await fixture('video.mp4'), 'video')
    const output = await packets(target.blob(), 'video')
    expect(output).toStrictEqual(source)
    expect(result.duration).toBe(2)
    expect(target.state.isClosed).toBe(true)
  },
)

test.each([0, 1] as const)(
  'rejects v%s tail edits in fragmented MP4 before writing output',
  async version => {
    for (const duration of [0.5, 1.99]) {
      const { input } = await fragmentedEditedMedia(duration, version)
      const output = memoryTarget()

      await expect(
        remuxMedia(input, {
          writable: output.writable,
          storage: await diskStorage(),
        }),
      ).rejects.toThrow(/media edit trims/u)
      expect(output.state.writes).toStrictEqual([])
      expect(output.state.isClosed).toBe(false)
      expect(output.state.isAborted).toBe(false)
      expect(output.writable.locked).toBe(false)
    }
  },
)

test.each([0, 1] as const)(
  'preserves v%s full-duration and open-ended edits in fragmented MP4',
  async version => {
    for (const duration of [0, 2]) {
      const { input, original } = await fragmentedEditedMedia(duration, version)
      const target = memoryTarget()
      const result = await remuxMedia(input, {
        writable: target.writable,
        storage: await diskStorage(),
      })
      const source = await packets(original, 'video')
      const output = await packets(target.blob(), 'video')

      expect(result.duration).toBe(2)
      expect(output).toStrictEqual(source)
      expect(target.state.isClosed).toBe(true)
      expect(target.writable.locked).toBe(false)
    }
  },
)

test.each([0, 1] as const)(
  'allows v%s edit duration rounding to the movie timescale',
  async version => {
    const bytes = Buffer.from(
      await (await editedMedia([{}], version)).arrayBuffer(),
    )
    const mdhd = bytes.lastIndexOf('mdhd')
    expect(mdhd).toBeGreaterThan(0)
    // Lowering the media timescale by one extends the track by less than half
    // a movie tick. Its two-second edit still represents the rounded endpoint.
    bytes.writeUInt32BE(bytes.readUInt32BE(mdhd + 16) - 1, mdhd + 16)
    const input = new Blob([bytes])
    const target = memoryTarget()
    const result = await remuxMedia(input, {
      writable: target.writable,
      storage: await diskStorage(),
    })

    expect(result.duration).toBeGreaterThan(2)
    expect(result.duration).toBeLessThan(2.0005)
    expect(
      (await packets(target.blob(), 'video')).map(packet => packet.data),
    ).toStrictEqual((await packets(input, 'video')).map(packet => packet.data))
    expect(target.state.isClosed).toBe(true)
  },
)
