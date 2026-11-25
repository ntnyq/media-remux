import { expect, test, vi } from 'vitest'
import { concatMedia, remuxMedia } from '../../src'
import { createDecodeTimeline } from '../../src/core/decodeTimeline'
import { inspectTracks } from '../../src/core/mediaTracks'
import type { OutputSegment, VideoPacketTrack } from '../../src/types'
import {
  GLOBAL_TIMESCALE,
  MAX_MP4_UINT32,
} from '../../src/vendor/mediabunny/src/isobmff/isobmff-muxer'
import { EncodedPacket } from '../../src/vendor/mediabunny/src/packet'
import { diskStorage, fixture, memoryTarget, packets } from '../helpers/media'
import { indexedMp4 } from '../helpers/mp4Index'

test('plans decode lead before writing an earlier segment with no reordering', async () => {
  const first = (
    await indexedMp4({ samples: 3, keyInterval: 3, compositionOffsets: [0] })
  ).blob()
  const second = (
    await indexedMp4({
      samples: 3,
      keyInterval: 3,
      cttsVersion: 1,
      compositionOffsets: [0, 1024, -1024],
    })
  ).blob()
  const target = memoryTarget()
  const result = await concatMedia([first, second], {
    writable: target.writable,
    storage: await diskStorage(),
  })
  const bytes = Buffer.from(await target.blob().arrayBuffer())
  const edit = bytes.indexOf('elst')

  expect(edit).toBeGreaterThan(0)
  expect(bytes[edit + 4]).toBe(1)
  // The later B-frame needs decode lead even though the first segment did not.
  expect(bytes.readBigInt64BE(edit + 20)).toBeGreaterThanOrEqual(1024n)
  const actual = await packets(target.blob(), 'audio')
  const expected = [0, 1024, 2048, 3072, 5120, 4096]

  expect(actual).toHaveLength(expected.length)

  for (const [index, packet] of actual.entries()) {
    expect(packet.timestamp).toBeCloseTo(expected[index]! / 48_000, 8)
  }

  expect(result.duration).toBeCloseTo(6144 / 48_000, 8)
})

test.each([2, 16])(
  'can remux %s concatenated fractional-rate clips with AAC at a different timescale',
  async count => {
    const input = await fixture('fractional-av.mp4')
    const target = memoryTarget()
    const result = await concatMedia(
      Array.from({ length: count }, () => input),
      {
        writable: target.writable,
        storage: await diskStorage(),
      },
    )

    // With 16 clips the first output page is flushed before moov is patched.
    expect(target.state.writes[0] === 1024 * 1024).toBe(count === 16)

    const repeated = memoryTarget()
    const repeatedResult = await remuxMedia(target.blob(), {
      writable: repeated.writable,
      storage: await diskStorage(),
    })

    expect(repeatedResult.bytesProcessed).toBe(result.bytesProcessed)
    expect(repeatedResult.duration).toBeCloseTo(result.duration, 4)
    expect(repeated.state.isClosed).toBe(true)
  },
)

test('uses planned decode timing without sorting the long GOP', async () => {
  const input = await fixture('long-gop.mp4')
  const storage = await diskStorage()
  const sort = vi.spyOn(storage.fragmentSamples, 'sort')
  const sorted = vi.spyOn(storage.fragmentSamples, 'sorted')
  const target = memoryTarget()

  await remuxMedia(input, { storage, writable: target.writable })
  expect(sort).not.toHaveBeenCalled()
  expect(sorted).not.toHaveBeenCalled()
  await expect(packets(target.blob(), 'video')).resolves.toHaveLength(
    (await packets(input, 'video')).length,
  )
})

test('keeps fractional decode ticks aligned across fragments and segment boundaries', async () => {
  const count = 300
  const indexed = await indexedMp4({
    samples: count,
    keyInterval: 100,
    compositionOffsets: [0],
  })
  const bytes = Buffer.from(await indexed.blob().arrayBuffer())
  const mdhd = bytes.indexOf('mdhd')

  expect(mdhd).toBeGreaterThan(0)
  // Input deltas become 1024 * 48000 / 44100 output ticks, requiring a carried remainder.
  bytes.writeUInt32BE(44_100, mdhd + 16)
  const input = new Blob([bytes])
  const target = memoryTarget()
  const result = await concatMedia([input, input, input], {
    writable: target.writable,
    storage: await diskStorage(),
  })
  const actual = await packets(target.blob(), 'audio')

  expect(Buffer.from(await target.blob().arrayBuffer()).includes('elst')).toBe(
    false,
  )
  expect(actual).toHaveLength(count * 3)

  for (const [index, packet] of actual.entries()) {
    expect(
      Math.abs(packet.timestamp - (index * 1024) / 44_100),
    ).toBeLessThanOrEqual(0.51 / 48_000)
  }

  expect(result.duration).toBeCloseTo((count * 3 * 1024) / 44_100, 8)
})

/**
 * Gives a real single-frame fragmented MP4 a caller-selected decode duration.
 *
 * @param duration - Duration in the input's unsigned 32-bit track units.
 * @param timescale - Input track units per second; output video uses 57600.
 * @returns A complete input whose payload is unchanged and timing is representable.
 */
async function singleFrame(duration: number, timescale: number): Promise<Blob> {
  const target = memoryTarget()

  await remuxMedia(await fixture('bt709-full-range.flv'), {
    writable: target.writable,
    storage: await diskStorage(),
  })
  const bytes = Buffer.from(await target.blob().arrayBuffer())
  const mdhd = bytes.indexOf('mdhd')
  const tfhd = bytes.indexOf('tfhd')

  expect(mdhd).toBeGreaterThan(0)
  expect(tfhd).toBeGreaterThan(0)
  expect(bytes.readUInt32BE(tfhd + 4)).toBe(0x02_00_38)
  bytes.writeUInt32BE(timescale, mdhd + (bytes[mdhd + 4] === 1 ? 24 : 16))
  bytes.writeUInt32BE(duration, tfhd + 12)

  return new Blob([bytes])
}

test.each([
  { duration: 0x80_00_00_00, timescale: 28_800 },
  { duration: 2_000_000_000, timescale: 16_384 },
])(
  'rejects video duration $duration at timescale $timescale before writing instead of wrapping uint32',
  async ({ duration, timescale }) => {
    const input = await singleFrame(duration, timescale)
    const source = await packets(input, 'video')

    expect(source).toHaveLength(1)
    expect(source[0]!.duration).toBe(duration / timescale)
    const target = memoryTarget()

    await expect(
      remuxMedia(input, {
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toThrow(/sample duration.*32-bit/iu)
    expect(target.state).toStrictEqual({
      isAborted: false,
      isClosed: false,
      writes: [],
    })
    expect(target.writable.locked).toBe(false)
  },
)

test.each([
  { duration: 0xff_ff_ff_ff, timescale: 57_600 },
  { duration: 0x7f_ff_ff_ff, timescale: 28_800 },
])(
  'preserves representable video duration $duration at timescale $timescale',
  async ({ duration, timescale }) => {
    const input = await singleFrame(duration, timescale)
    const target = memoryTarget()
    const result = await remuxMedia(input, {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const output = await packets(target.blob(), 'video')

    expect(output).toHaveLength(1)
    expect(output[0]!.duration).toBeCloseTo(duration / timescale, 5)
    expect(result.duration).toBeCloseTo(output[0]!.duration, 5)
    expect(target.state.isClosed).toBe(true)
  },
)

test.each([
  { name: 'positive', offsets: [2 ** 31 - 1, 0, -2048] },
  { name: 'negative', offsets: [2 ** 30 - 1, 2 ** 31 - 2 - 1024, -2048] },
])(
  'rejects $name source composition offsets that overflow unsigned output trun fields before writing',
  async ({ offsets }) => {
    const indexed = await indexedMp4({
      samples: 3,
      keyInterval: 3,
      cttsVersion: 1,
      compositionOffsets: offsets,
    })
    const bytes = Buffer.from(await indexed.blob().arrayBuffer())
    const mdhd = bytes.indexOf('mdhd')

    expect(mdhd).toBeGreaterThan(0)
    // AAC still decodes at 48 kHz, so output timing doubles the input track units.
    bytes.writeUInt32BE(24_000, mdhd + 16)
    const target = memoryTarget()

    await expect(
      remuxMedia(new Blob([bytes]), {
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toThrow(/composition offset.*32-bit/iu)
    expect(target.state).toStrictEqual({
      isAborted: false,
      isClosed: false,
      writes: [],
    })
    expect(target.writable.locked).toBe(false)
  },
)

test.each([
  { name: 'unsigned maximum', offsets: [2 ** 32 - 1, 0, 0], version: 0 },
  { name: 'maximum', offsets: [2 ** 31 - 1 + 1024, 0, 0], version: 0 },
  {
    name: 'minimum',
    offsets: [715_827_882, 1_431_655_765 - 1024, 2 ** 31 - 2048, -3072],
    version: 1,
  },
] as const)(
  'preserves the source composition offset $name boundary',
  async ({ offsets, version }) => {
    const indexed = await indexedMp4({
      samples: offsets.length,
      keyInterval: offsets.length,
      cttsVersion: version,
      compositionOffsets: offsets,
    })
    const input = indexed.blob()
    const source = await packets(input, 'audio')
    const start = Math.min(...source.map(packet => packet.timestamp))
    const target = memoryTarget()

    await remuxMedia(input, {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const output = await packets(target.blob(), 'audio')

    expect(output).toHaveLength(source.length)

    for (const [index, packet] of output.entries()) {
      expect(packet.timestamp).toBeCloseTo(source[index]!.timestamp - start, 5)
      expect(packet.data).toStrictEqual(source[index]!.data)
    }
  },
)

/**
 * Creates a repeatable video track with presentation and decode timing in output ticks.
 *
 * @param codec - Output codec family.
 * @param samples - Presentation timestamp, presentation duration, and decode duration.
 * @returns A track for timeline preflight.
 */
function timedVideoTrack(
  codec: 'avc' | 'av1',
  samples: readonly (readonly [number, number, number])[],
): VideoPacketTrack {
  return {
    kind: 'video',
    codec,
    config: { codec },
    async *packets() {
      for (const [timestamp, duration, decodeDuration] of samples) {
        yield new EncodedPacket(
          Uint8Array.of(1),
          'key',
          timestamp / GLOBAL_TIMESCALE,
          duration / GLOBAL_TIMESCALE,
          undefined,
          undefined,
          { decodeDuration: decodeDuration / GLOBAL_TIMESCALE },
        )
      }
    },
  }
}

test('checks the composition offset of earlier packets against the final decode origin', async () => {
  const first = timedVideoTrack('avc', [
    [0, 1, 1],
    [MAX_MP4_UINT32 + 1, 1, MAX_MP4_UINT32],
    [MAX_MP4_UINT32 + 2, 1, 3],
  ])
  const second = timedVideoTrack('avc', [[0, 1, 1]])
  const timeline = createDecodeTimeline([first])
  const firstPlan = await inspectTracks([first], undefined, timeline)
  const firstSegment = { tracks: [first], plan: firstPlan, isLast: true }

  await expect(
    timeline.validateSampleTiming(async function* () {
      yield firstSegment
    }),
  ).resolves.toBeUndefined()

  const secondPlan = await inspectTracks([second], undefined, timeline)

  // The second segment moves the decode origin one tick earlier.
  await expect(
    timeline.validateSampleTiming(async function* () {
      yield { ...firstSegment, isLast: false }
      yield { tracks: [second], plan: secondPlan, isLast: true }
    }),
  ).rejects.toThrow(/composition offset.*32-bit/iu)
})

test.each([
  { startTicks: 0.375, overflows: true },
  { startTicks: 0.75, overflows: false },
])(
  'checks AV1 sample duration with both endpoints rounded at a start of $startTicks ticks',
  async ({ startTicks, overflows }) => {
    const durationTicks = MAX_MP4_UINT32 + 0.25
    const track = timedVideoTrack('av1', [
      [startTicks, durationTicks, durationTicks],
    ])
    const timeline = createDecodeTimeline([track])
    const packet = (await track.packets(true).next()).value!

    timeline.addPacket(0, packet)

    const plan = {
      start: 0,
      duration: (startTicks + durationTicks) / GLOBAL_TIMESCALE,
    }

    timeline.finishSegment(plan, 0)

    const validation = timeline.validateSampleTiming(
      async function* (): AsyncGenerator<OutputSegment, void> {
        yield { tracks: [track], plan, isLast: true }
      },
    )

    await expect(validation.catch((error: unknown) => error)).resolves.toEqual(
      overflows
        ? new RangeError(
            'MP4 sample duration exceeds the unsigned 32-bit field range.',
          )
        : undefined,
    )
  },
)
