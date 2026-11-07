import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test, expect } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../src'
import type { RemuxResult } from '../src'
import { diskStorage, fixture, memoryTarget, packets } from './helpers/media'

test.each(['remux', 'concat', 'combine'] as const)(
  'preserves VFR B-frame presentation timing through %s and repeated remux',
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
    const timelineStart =
      operation === 'combine'
        ? Math.min(
            start,
            ...(await packets(await fixture('audio.m4a'), 'audio')).map(
              packet => packet.timestamp,
            ),
          )
        : start
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
      }
      expect(
        Math.max(...actual.map(packet => packet.timestamp + packet.duration)),
      ).toBeCloseTo(result.duration, 4)
    }
  },
)

test('extracts unchanged AAC payloads after a subtitle traf with an implicit data base', async () => {
  const input = await fixture('subtitle-first.mp4')
  const expected = await packets(await fixture('audio.m4a'), 'audio')
  const parsed = await packets(input, 'audio')
  expect(parsed.map(packet => packet.data)).toStrictEqual(
    expected.map(packet => packet.data),
  )
  const target = memoryTarget()
  const result = await remuxMedia(input, {
    tracks: 'audio',
    storage: await diskStorage(),
    writable: target.writable,
  })
  const actual = await packets(target.blob(), 'audio')
  expect(actual.map(packet => packet.data)).toStrictEqual(
    expected.map(packet => packet.data),
  )
  expect(actual).toHaveLength(expected.length)
  expect(result.mimeType).toBe('audio/mp4')
  expect(target.state.isClosed).toBe(true)
})

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
        'packet=pts_time,dts_time,duration_time',
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
    for (const [index, row] of output!.entries()) {
      expect(row[0]).toBeCloseTo(source![index]![0]! - sourceStart, 5)
      expect(row[1]! - output![0]![1]!).toBeCloseTo(
        source![index]![1]! - source![0]![1]!,
        5,
      )
      expect(row[2]).toBeCloseTo(source![index]![2]!, 5)
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
      await packets(audio, 'audio'),
    ]
    const start = Math.min(...sources.flat().map(packet => packet.timestamp))
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
