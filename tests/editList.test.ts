import { expect, test } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../src'
import type { RemuxResult } from '../src'
import { openMediaInput } from '../src/core/input/mediaInput'
import { diskStorage, fixture, memoryTarget, packets } from './helpers/media'

test.each(['remux', 'combine'] as const)(
  'can %s AAC when a discarded video track has an unsupported dwell edit',
  async operation => {
    const input = await editedMedia([{ mediaRate: 0 }], 0, 'progressive.mp4')
    const target = memoryTarget()
    const options = { writable: target.writable, storage: await diskStorage() }

    await (operation === 'remux'
      ? remuxMedia(input, { ...options, tracks: 'audio' })
      : combineTracks(await fixture('video.mp4'), input, options))

    const source = await packets(await fixture('progressive.mp4'), 'audio', {
      applyAudioEdit: true,
    })
    const actual = await packets(target.blob(), 'audio')

    expect(actual.map(packet => packet.data)).toStrictEqual(
      source.map(packet => packet.data),
    )
  },
)

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
      edit.duration === undefined
        ? duration
        : Math.round(edit.duration * timescale)
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
      (edit.duration === undefined
        ? duration
        : Math.round(edit.duration * timescale)),
    0,
  )

  moov.writeUInt32BE(totalDuration, moov.indexOf('mvhd') + 20)
  moov.writeUInt32BE(totalDuration, moov.indexOf('tkhd') + 24)
  original.write('free', moovStart + 4, 'ascii')

  return new Blob([original, moov])
}

/**
 * Adds a media edit to a real fragmented track, preserving relative payload offsets.
 *
 * @param duration - Media edit duration in seconds; zero is open-ended.
 * @param version - Edit list field width: 32-bit for v0 or 64-bit for v1.
 * @param startShift - Extra media ticks to add to the original edit start.
 * @param sourceName - Fixture used to generate the fragmented track.
 * @returns Edited input and the unedited fragmented output for packet comparisons.
 */
async function fragmentedEditedMedia(
  duration: number,
  version: 0 | 1,
  startShift = 0,
  sourceName = 'video.mp4',
) {
  const target = memoryTarget()

  await remuxMedia(await fixture(sourceName), {
    writable: target.writable,
    storage: await diskStorage(),
  })
  const original = Buffer.from(await target.blob().arrayBuffer())
  const moovStart = original.indexOf('moov') - 4
  const trakStart = original.indexOf('trak') - 4
  const originalElst = original.indexOf('elst')
  const hasEdit = originalElst >= 0
  const edtsStartOriginal = original.indexOf(hasEdit ? 'edts' : 'mdia') - 4

  expect(edtsStartOriginal).toBeGreaterThan(trakStart)
  const originalEditSize = hasEdit
    ? original.readUInt32BE(edtsStartOriginal)
    : 0

  expect(hasEdit ? original[originalElst + 4] : 1).toBe(1)

  const mediaTime =
    (hasEdit ? Number(original.readBigInt64BE(originalElst + 20)) : 0) +
    startShift
  const mvhd = original.indexOf('mvhd')
  const movieTimescale = original.readUInt32BE(
    mvhd + (original[mvhd + 4] === 1 ? 24 : 16),
  )
  const edited = Buffer.from(
    await (await editedMedia([{ duration, mediaTime }], version)).arrayBuffer(),
  )
  const edtsStart = edited.lastIndexOf('edts') - 4

  expect(edtsStart).toBeGreaterThan(0)
  const edts = edited.subarray(
    edtsStart,
    edtsStart + edited.readUInt32BE(edtsStart),
  )
  const elst = edts.indexOf('elst')

  const editDuration = Math.round(duration * movieTimescale)

  if (version === 1) {
    edts.writeBigUInt64BE(BigInt(editDuration), elst + 12)
  } else {
    edts.writeUInt32BE(editDuration, elst + 12)
  }

  // Fragment payloads use moof-relative offsets and move with their moofs.
  // Discard the optional TFRA index, whose absolute offsets would be stale.
  const bytes = Buffer.concat([
    original.subarray(0, edtsStartOriginal),
    edts,
    original.subarray(edtsStartOriginal + originalEditSize),
  ])

  for (const offset of [moovStart, trakStart]) {
    bytes.writeUInt32BE(
      bytes.readUInt32BE(offset) + edts.length - originalEditSize,
      offset,
    )
  }

  const mfra = bytes.lastIndexOf('mfra')

  expect(mfra).toBeGreaterThan(0)
  bytes.write('free', mfra, 'ascii')

  return { input: new Blob([bytes]), original: target.blob() }
}

test.each([0, 1] as const)(
  'preserves a v%s partial video tail edit and A/V offset across concatenation',
  async version => {
    const videoDelay = 0.067
    const videoDuration = 1.999
    const original = await fixture('progressive.mp4')
    const audio = await packets(original, 'audio', { applyAudioEdit: true })
    const segmentDuration = videoDelay + videoDuration
    const input = await editedMedia(
      [{ mediaTime: -1, duration: videoDelay }, { duration: videoDuration }],
      version,
      'progressive.mp4',
    )
    const target = memoryTarget()
    const result = await concatMedia([input, input], {
      tracks: 'video-with-optional-audio',
      writable: target.writable,
      storage: await diskStorage(),
    })

    expect(result.duration).toBeCloseTo(2 * segmentDuration, 4)

    const video = await packets(original, 'video')
    const videoOutput = await packets(target.blob(), 'video')
    const audioOutput = await packets(target.blob(), 'audio')

    for (const [source, output, delay] of [
      [video, videoOutput, videoDelay],
      [audio, audioOutput, 0],
    ] as const) {
      const expected = [...source, ...source]

      expect(output.map(packet => packet.data)).toStrictEqual(
        expected.map(packet => packet.data),
      )

      for (const [index, packet] of output.entries()) {
        expect(packet.timestamp).toBeCloseTo(
          expected[index]!.timestamp +
            delay +
            (index < source.length ? 0 : segmentDuration),
          4,
        )
      }
    }

    const lastFrame = videoOutput[video.length - 1]!

    expect(lastFrame.timestamp + lastFrame.duration).toBeCloseTo(
      segmentDuration,
      4,
    )
  },
)

test.each([0, 1] as const)(
  'preserves AAC packets when a v%s edit trims the final audio sample',
  async version => {
    const input = await editedMedia([{ duration: 1.796 }], version, 'audio.m4a')
    const original = await packets(await fixture('audio.m4a'), 'audio', {
      applyAudioEdit: true,
    })
    const target = memoryTarget()
    const result = await concatMedia([input, input], {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const output = await packets(target.blob(), 'audio')

    expect(output.map(packet => packet.data)).toStrictEqual(
      [...original, ...original].map(packet => packet.data),
    )
    const segmentDuration = 1.796

    expect(output[original.length - 1]?.duration).toBeCloseTo(0.004, 5)
    expect(output[original.length]?.timestamp).toBeCloseTo(segmentDuration, 5)
    expect(output.at(-1)?.duration).toBeCloseTo(0.004, 5)
    expect(result.duration).toBeCloseTo(2 * segmentDuration, 5)
  },
)

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
      { edits: [{ duration: 1.95 }], error: /media edit trims/u },
      {
        edits: [{ mediaTime: -1, duration: 0.75 }, { duration: 0.5 }],
        error: /media edit trims/u,
      },
      {
        edits: [{ mediaTime: 13_312, duration: 1 }],
        error: /trims video/u,
      },
      {
        // The first frame starts at 1024 and ends at 1536 on the 12288 Hz clock.
        edits: [{ mediaTime: 1280, duration: 1.979 }],
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
    const audioPackets = await packets(audio, 'audio', { applyAudioEdit: true })
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
          source[index]!.timestamp + shift,
          4,
        )
      }
    }

    expect(result.duration).toBeCloseTo(end, 4)
    expect(target.state.isClosed).toBe(true)
    expect(target.writable.locked).toBe(false)
  },
)

test.each([0, 1] as const)(
  'preserves only the selected prefix of AAC packets for a v%s tail trim',
  async version => {
    const input = await editedMedia([{ duration: 0.5 }], version, 'audio.m4a')
    const original = await packets(await fixture('audio.m4a'), 'audio', {
      applyAudioEdit: true,
    })
    const target = memoryTarget()
    const result = await remuxMedia(input, {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const output = await packets(target.blob(), 'audio')
    const retained = original.filter(packet => packet.timestamp < 0.5)

    expect(output.map(packet => packet.data)).toStrictEqual(
      retained.map(packet => packet.data),
    )
    expect(output.at(-1)?.duration).toBeCloseTo(
      0.5 - retained.at(-1)!.timestamp,
      5,
    )
    expect(result.duration).toBeCloseTo(0.5, 5)
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

    const source = await packets(await fixture('progressive.mp4'), 'audio', {
      applyAudioEdit: true,
    })
    const output = await packets(target.blob(), 'audio')

    expect(output.map(packet => packet.data)).toStrictEqual(
      source.map(packet => packet.data),
    )
    expect(output[0]!.timestamp).toBeCloseTo(source[0]!.timestamp, 5)
    expect(target.state.isClosed).toBe(true)
  },
)

test('hides a multi-packet AAC head edit and preserves it across repeated remux', async () => {
  const input = await fixture('audio-edited-head.m4a')
  const source = await packets(input, 'audio')
  const crossing = source.findIndex(
    packet => packet.timestamp + packet.duration > 0,
  )

  expect(crossing).toBeGreaterThan(2)
  expect(source[crossing]!.timestamp).toBeLessThan(0)
  let media = input

  for (let pass = 0; pass < 2; pass++) {
    const target = memoryTarget()
    const result = await remuxMedia(media, {
      writable: target.writable,
      storage: await diskStorage(),
    })

    expect(result.duration).toBeCloseTo(1, 5)
    media = target.blob()
    const output = await packets(media, 'audio')

    expect(output.map(packet => packet.data)).toStrictEqual(
      source.slice(crossing).map(packet => packet.data),
    )
    expect(output[0]!.timestamp).toBeCloseTo(source[crossing]!.timestamp, 5)
  }
})

test('rejects a partial AAC head edit at a later copy splice before writing', async () => {
  const input = await fixture('audio-edited-head.m4a')
  const target = memoryTarget()

  await expect(
    concatMedia([input, input], {
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_MEDIA_FEATURE',
    message: expect.stringContaining('normalizeAudio'),
  })
  expect(target.state.writes).toStrictEqual([])
  expect(target.writable.locked).toBe(false)
})

test('preserves a delayed partial AAC head edit when combining with video', async () => {
  const delay = 0.25
  const audio = await editedMedia(
    [
      { mediaTime: -1, duration: delay },
      { mediaTime: 25_024, duration: 1 },
    ],
    1,
    'audio.m4a',
  )
  const video = await fixture('video.mp4')
  const retained = await packets(audio, 'audio', { applyAudioEdit: true })
  const target = memoryTarget()

  expect(retained[0]!.timestamp).toBeLessThan(delay)
  await combineTracks(video, audio, {
    writable: target.writable,
    storage: await diskStorage(),
  })

  const output = target.blob()
  const media = await openMediaInput(output)

  try {
    expect(
      media.tracks.find(track => track.kind === 'audio')?.audioEditStart,
    ).toBeCloseTo(delay, 5)
  } finally {
    media.dispose()
  }

  const actual = await packets(output, 'audio')

  expect(actual.map(packet => packet.data)).toStrictEqual(
    retained.map(packet => packet.data),
  )
  expect(actual[0]!.timestamp).toBeCloseTo(retained[0]!.timestamp, 5)
})

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
    for (const duration of [0.5, 1.95]) {
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
  'applies a v%s tail edit to fragmented AAC without changing retained packets',
  async version => {
    const { input, original } = await fragmentedEditedMedia(
      0.5,
      version,
      0,
      'audio.m4a',
    )
    const target = memoryTarget()
    const result = await remuxMedia(input, {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const source = await packets(original, 'audio')
    const retained = source.filter(packet => packet.timestamp < 0.5)
    const output = await packets(target.blob(), 'audio')

    expect(output.map(packet => packet.data)).toStrictEqual(
      retained.map(packet => packet.data),
    )
    expect(output.at(-1)?.duration).toBeCloseTo(
      0.5 - retained.at(-1)!.timestamp,
      5,
    )
    expect(result.duration).toBeCloseTo(0.5, 5)
  },
)

test.each([0, 1] as const)(
  'preserves a v%s partial video tail edit in fragmented MP4',
  async version => {
    const end = 1.99
    const { input, original } = await fragmentedEditedMedia(end, version)
    const target = memoryTarget()
    const result = await remuxMedia(input, {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const source = await packets(original, 'video')
    const output = await packets(target.blob(), 'video')

    expect(
      output.map(({ data, timestamp }) => ({ data, timestamp })),
    ).toStrictEqual(source.map(({ data, timestamp }) => ({ data, timestamp })))
    expect(result.duration).toBeCloseTo(end, 4)
    expect(output.at(-1)!.timestamp + output.at(-1)!.duration).toBeCloseTo(
      end,
      4,
    )
  },
)

test('keeps decode order when the edited final video frame is decoded early', async () => {
  const end = 4.099
  const { input, original } = await fragmentedEditedMedia(
    end,
    1,
    0,
    'vfr-bframes.mp4',
  )
  const target = memoryTarget()
  const result = await remuxMedia(input, {
    writable: target.writable,
    storage: await diskStorage(),
  })
  const source = await packets(original, 'video')
  const output = await packets(target.blob(), 'video')

  expect(
    output.map(({ data, timestamp }) => ({ data, timestamp })),
  ).toStrictEqual(source.map(({ data, timestamp }) => ({ data, timestamp })))
  const lastPresented = output.toSorted(
    (left, right) => right.timestamp - left.timestamp,
  )[0]!

  expect(lastPresented.timestamp).toBeGreaterThan(output.at(-1)!.timestamp)
  expect(lastPresented.timestamp + lastPresented.duration).toBeCloseTo(end, 4)
  expect(result.duration).toBeCloseTo(end, 4)
})

test.each([0, 1] as const)(
  'rejects a v%s edit starting partway through the first fragmented video frame',
  async version => {
    const { input } = await fragmentedEditedMedia(1.98, version, 1152)
    const target = memoryTarget()

    await expect(
      remuxMedia(input, {
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toThrow(/trims video/u)

    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
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
