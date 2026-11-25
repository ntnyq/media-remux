import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test, expect } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../../src'
import type { RemuxResult } from '../../src'
import { diskStorage, fixture, memoryTarget, packets } from '../helpers/media'

test.each([
  {
    mode: 'shared timeline',
    timeline: undefined,
    videoStart: 1 / 6,
    audioStart: 0,
  },
  {
    mode: 'aligned starts',
    timeline: 'align-starts',
    videoStart: 0,
    audioStart: 0,
  },
  {
    mode: 'manual offsets',
    timeline: { videoOffset: -1 / 6, audioOffset: 0.25 },
    videoStart: 0,
    audioStart: 0.25,
  },
] as const)(
  'combines segmented TS video and fragmented MP4 audio with $mode',
  async ({ timeline, videoStart, audioStart }) => {
    const video = await fixture('continuous-av.mpegts')
    const audio = await fixture('subtitle-first.mp4')
    const target = memoryTarget()
    const options = {
      storage: await diskStorage(),
      writable: target.writable,
      ...(timeline === undefined ? {} : { timeline }),
    }
    const result = await combineTracks(
      { blob: video, segmentOffsets: [0, 5076] },
      audio,
      options,
    )
    let end = 0

    for (const [input, kind, expectedStart] of [
      [video, 'video', videoStart],
      [audio, 'audio', audioStart],
    ] as const) {
      const source = await packets(input, kind)
      const output = await packets(target.blob(), kind)
      const start = Math.min(...source.map(packet => packet.timestamp))

      expect(output).toHaveLength(source.length)

      for (const [index, packet] of output.entries()) {
        const original = source[index]!
        const timestamp = original.timestamp - start + expectedStart

        expect(packet.timestamp).toBeCloseTo(timestamp, 4)
        expect(packet.decodeDuration).toBeCloseTo(original.decodeDuration!, 4)
        end = Math.max(end, timestamp + original.duration)
      }
    }

    expect(result.duration).toBeCloseTo(end, 4)
  },
)

test('shifts audio PTS and inferred DTS together in the MP4 written by combine', async context => {
  const exec = promisify(execFile)

  try {
    await exec('ffprobe', ['-version'])
  } catch {
    context.skip()

    return
  }

  const video = await fixture('continuous-av.mpegts')
  const audio = await fixture('subtitle-first.mp4')
  const target = memoryTarget()

  await combineTracks(video, audio, {
    storage: await diskStorage(),
    writable: target.writable,
    timeline: { audioOffset: 0.25 },
  })
  const directory = await mkdtemp(join(tmpdir(), 'media-remux-combine-timing-'))

  try {
    const path = join(directory, 'output.mp4')

    await writeFile(path, new Uint8Array(await target.blob().arrayBuffer()))
    const { stdout } = await exec('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-read_intervals',
      '%+#1',
      '-show_entries',
      'packet=pts_time,dts_time',
      '-of',
      'csv=p=0',
      path,
    ])
    const [pts, dts] = stdout.trim().split(',').map(Number)
    const expected = 0.25 - 1 / 6

    expect(pts).toBeCloseTo(expected, 5)
    expect(dts).toBeCloseTo(expected, 5)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.each(['remux', 'concat', 'combine'] as const)(
  'preserves VFR B-frame presentation and decode timing through %s and repeated remux',
  async operation => {
    const input = await fixture('vfr-bframes.mp4')
    const source = await packets(input, 'video')
    const start = Math.min(...source.map(packet => packet.timestamp))
    const duration =
      Math.max(...source.map(packet => packet.timestamp + packet.duration)) -
      start

    expect(source).toHaveLength(7)
    expect(new Set(source.map(packet => packet.duration)).size).toBeGreaterThan(
      1,
    )
    expect(
      source.some(
        (packet, index) =>
          index > 0 && packet.timestamp < source[index - 1]!.timestamp,
      ),
    ).toBe(true)
    const target = memoryTarget()
    const options = { storage: await diskStorage(), writable: target.writable }
    let result: RemuxResult

    if (operation === 'concat') {
      result = await concatMedia([input, input], options)
    } else if (operation === 'combine') {
      result = await combineTracks(input, await fixture('audio.m4a'), options)
    } else {
      result = await remuxMedia(input, options)
    }

    const copies = operation === 'concat' ? 2 : 1
    // Combining preserves the shared A/V offset rather than normalizing video alone.
    const timelineStart = operation === 'combine' ? Math.min(start, 0) : start
    const repeated = memoryTarget()
    const repeatedResult = await remuxMedia(target.blob(), {
      storage: await diskStorage(),
      writable: repeated.writable,
    })

    expect(repeatedResult.duration).toBeCloseTo(result.duration, 4)

    for (const output of [target.blob(), repeated.blob()]) {
      const actual = await packets(output, 'video')

      expect(actual).toHaveLength(source.length * copies)

      for (const [index, packet] of actual.entries()) {
        const original = source[index % source.length]!
        const segment = Math.floor(index / source.length)

        expect(packet.data).toStrictEqual(original.data)
        expect(packet.type).toBe(original.type)
        expect(packet.timestamp).toBeCloseTo(
          original.timestamp - timelineStart + segment * duration,
          4,
        )
        expect(packet.duration).toBeCloseTo(original.duration, 4)
        expect(packet.decodeDuration).toBeCloseTo(original.decodeDuration!, 4)
      }

      expect(
        Math.max(...actual.map(packet => packet.timestamp + packet.duration)),
      ).toBeCloseTo(result.duration, 4)
    }
  },
)

test('preserves VFR decode deltas and absolute PTS independently read by FFprobe', async context => {
  const exec = promisify(execFile)

  try {
    await exec('ffprobe', ['-version'])
  } catch {
    context.skip()

    return
  }

  const directory = await mkdtemp(join(tmpdir(), 'media-remux-timing-'))

  try {
    const input = await fixture('vfr-bframes.mp4')
    const target = memoryTarget()

    await remuxMedia(input, {
      storage: await diskStorage(),
      writable: target.writable,
    })
    const timings: number[][][] = []

    for (const [index, blob] of [input, target.blob()].entries()) {
      const path = join(directory, `${index}.mp4`)

      await writeFile(path, new Uint8Array(await blob.arrayBuffer()))
      const { stdout } = await exec('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=pts_time,dts_time',
        '-of',
        'csv=p=0',
        path,
      ])

      timings.push(
        stdout
          .trim()
          .split('\n')
          .map(line => line.split(',').map(Number)),
      )
    }

    const [source, output] = timings

    expect(source).toHaveLength(7)
    expect(output).toHaveLength(source!.length)
    const sourceStart = Math.min(...source!.map(row => row[0]!))

    // FFprobe can report presentation intervals for MP4 and decode durations
    // for fMP4. Compare the decode timestamps directly.
    for (const [index, row] of output!.entries()) {
      expect(row[0]).toBeCloseTo(source![index]![0]! - sourceStart, 5)
      expect(row[1]! - output![0]![1]!).toBeCloseTo(
        source![index]![1]! - source![0]![1]!,
        5,
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.for(['video.mp4', 'vfr-bframes.mp4', 'vfr-bframes.flv'])(
  'preserves absolute A/V timestamps from %s as read by FFprobe',
  async (name, context) => {
    const exec = promisify(execFile)

    try {
      await exec('ffprobe', ['-version'])
    } catch {
      context.skip()

      return
    }

    const video = await fixture(name)
    const audio = await fixture('audio.m4a')
    const sources = [
      await packets(video, 'video'),
      await packets(audio, 'audio', { applyAudioEdit: true }),
    ]
    const start = Math.min(0, ...sources[0]!.map(packet => packet.timestamp))
    const target = memoryTarget()
    const result = await combineTracks(video, audio, {
      storage: await diskStorage(),
      writable: target.writable,
    })
    const repeated = memoryTarget()

    await remuxMedia(target.blob(), {
      storage: await diskStorage(),
      writable: repeated.writable,
    })
    const directory = await mkdtemp(join(tmpdir(), 'media-remux-av-timing-'))

    try {
      for (const [index, blob] of [target.blob(), repeated.blob()].entries()) {
        const path = join(directory, `${index}.mp4`)

        await writeFile(path, new Uint8Array(await blob.arrayBuffer()))

        for (const [track, selector] of ['v:0', 'a:0'].entries()) {
          const { stdout } = await exec('ffprobe', [
            '-v',
            'error',
            '-select_streams',
            selector,
            '-show_entries',
            'packet=pts_time',
            '-of',
            'csv=p=0',
            path,
          ])
          const actual = stdout
            .trim()
            .split('\n')
            .map(line => Number(line.split(',')[0]))

          expect(actual).toHaveLength(sources[track]!.length)

          for (const [packet, timestamp] of actual.entries()) {
            expect(timestamp).toBeCloseTo(
              sources[track]![packet]!.timestamp - start,
              4,
            )
          }
        }

        const { stdout } = await exec('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          path,
        ])

        expect(Number(stdout.trim())).toBeCloseTo(result.duration, 4)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test.each([
  { names: ['vfr-bframes.flv'] },
  { names: ['vfr-bframes.flv', 'vfr-bframes.flv'] },
  { names: ['vfr-bframes.mp4', 'vfr-bframes.flv'] },
  { names: ['vfr-bframes.flv', 'vfr-bframes.mp4'] },
])(
  'preserves VFR FLV segment boundaries through repeated remux: $names',
  async ({ names }) => {
    const inputs = await Promise.all(names.map(name => fixture(name)))
    const sources = await Promise.all(
      inputs.map(input => packets(input, 'video')),
    )
    const expected: { timestamp: number; data: Uint8Array }[] = []
    let duration = 0

    for (const source of sources) {
      const start = Math.min(...source.map(packet => packet.timestamp))

      for (const packet of source) {
        expected.push({
          timestamp: packet.timestamp - start + duration,
          data: packet.data,
        })
      }

      duration +=
        Math.max(...source.map(packet => packet.timestamp + packet.duration)) -
        start
    }

    const target = memoryTarget()
    const result = await concatMedia(inputs, {
      storage: await diskStorage(),
      writable: target.writable,
    })

    expect(result.duration).toBeCloseTo(duration, 4)
    const repeated = memoryTarget()
    const repeatedResult = await remuxMedia(target.blob(), {
      storage: await diskStorage(),
      writable: repeated.writable,
    })

    expect(repeatedResult.duration).toBeCloseTo(duration, 4)

    for (const output of [target.blob(), repeated.blob()]) {
      const actual = await packets(output, 'video')

      expect(actual).toHaveLength(expected.length)

      for (const [index, packet] of actual.entries()) {
        expect(packet.timestamp).toBeCloseTo(expected[index]!.timestamp, 4)
        expect(packet.data).toStrictEqual(expected[index]!.data)
      }

      expect(
        Math.max(...actual.map(packet => packet.timestamp + packet.duration)),
      ).toBeCloseTo(duration, 4)
    }
  },
)

test('starts H.264 MP4 at the first keyframe after leading dependent frames', async () => {
  const input = await fixture('leading-delta.mp4')
  const target = memoryTarget()
  const before = await packets(input, 'video')
  const firstKeyframe = before.findIndex(packet => packet.type === 'key')

  expect(firstKeyframe).toBeGreaterThan(0)
  await remuxMedia(input, {
    writable: target.writable,
    storage: await diskStorage(),
  })

  const after = await packets(target.blob(), 'video')

  expect(after[0]?.type).toBe('key')
  expect(after[0]?.timestamp).toBe(0)
  expect(after.map(packet => packet.data)).toStrictEqual(
    before.slice(firstKeyframe).map(packet => packet.data),
  )
})

test('aligns independent audio to the retained H.264 keyframe', async () => {
  const video = await fixture('leading-delta.mp4')
  const audio = await fixture('audio-edited-head.m4a')
  const target = memoryTarget()

  await combineTracks(video, audio, {
    storage: await diskStorage(),
    writable: target.writable,
    timeline: 'align-starts',
  })

  const outputVideo = await packets(target.blob(), 'video')
  const outputAudio = await packets(target.blob(), 'audio', {
    applyAudioEdit: true,
  })
  const playableAudio = await packets(audio, 'audio', { applyAudioEdit: true })

  expect(outputVideo[0]?.type).toBe('key')
  expect(outputVideo[0]?.timestamp).toBe(0)
  expect(outputAudio.map(packet => packet.data)).toStrictEqual(
    playableAudio.map(packet => packet.data),
  )
  expect(outputAudio[0]?.timestamp).toBeCloseTo(playableAudio[0]!.timestamp, 4)
})

test('trims H.264 and AAC on the same presentation timeline', async () => {
  const input = await fixture('leading-delta-av.mp4')
  const target = memoryTarget()
  const video = await packets(input, 'video')
  const audio = await packets(input, 'audio')
  const firstKeyframe = video.findIndex(packet => packet.type === 'key')
  const cutoff = video[firstKeyframe]?.timestamp ?? Infinity
  const retainedVideo = video.slice(firstKeyframe)
  const retainedAudio = audio.filter(packet => packet.timestamp >= cutoff)

  expect(firstKeyframe).toBeGreaterThan(0)
  expect(retainedAudio.length).toBeGreaterThan(0)
  expect(retainedAudio.length).toBeLessThan(audio.length)

  const result = await remuxMedia(input, {
    writable: target.writable,
    storage: await diskStorage(),
  })

  let expectedBytes = 0
  let end = 0

  for (const [kind, retained] of [
    ['video', retainedVideo],
    ['audio', retainedAudio],
  ] as const) {
    const actual = await packets(target.blob(), kind)

    expect(actual.map(packet => packet.data)).toStrictEqual(
      retained.map(packet => packet.data),
    )

    for (const [index, packet] of retained.entries()) {
      expect(actual[index]?.timestamp).toBeCloseTo(packet.timestamp - cutoff, 4)
      expect(actual[index]?.duration).toBeCloseTo(packet.duration, 4)
      expectedBytes += packet.data.byteLength
      end = Math.max(end, packet.timestamp + packet.duration)
    }
  }

  expect(result.bytesProcessed).toBe(expectedBytes)
  expect(result.duration).toBeCloseTo(end - cutoff, 5)
})

test('rejects a cut MP3 whose first retained frame depends on discarded packets', async () => {
  const target = memoryTarget()

  await expect(
    remuxMedia(await fixture('leading-delta-mp3.mp4'), {
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

test('rejects a leading-delta MP4 with no decodable sync sample before writing', async () => {
  const input = await fixture('leading-delta.mp4')
  const bytes = Buffer.from(await input.arrayBuffer())
  const stss = bytes.indexOf('stss')

  expect(stss).toBeGreaterThan(0)
  expect(bytes.readUInt32BE(stss + 8)).toBe(1)
  // Point the only sync sample entry at a dependent frame.
  bytes.writeUInt32BE(2, stss + 12)
  const target = memoryTarget()

  await expect(
    remuxMedia(new Blob([bytes]), {
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toThrow('decodable keyframe')
  expect(target.state.writes).toStrictEqual([])
  expect(target.writable.locked).toBe(false)
})
