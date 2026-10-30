import { expect, test } from 'vitest'
import { remuxMedia } from '../src'
import { diskStorage, fixture, memoryTarget, packets } from './helpers/media'
import { indexedMp4 } from './helpers/mp4Index'

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
  'rejects video duration $duration at timescale $timescale instead of wrapping uint32',
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
    expect(target.state.isAborted).toBe(true)
    expect(target.state.isClosed).toBe(false)
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
  { name: 'positive', offsets: [2 ** 30 + 4096, 0, 0] },
  { name: 'negative', offsets: [2 ** 30 - 1, 2 ** 31 - 2 - 1024, -2048] },
])(
  'rejects $name composition offsets that overflow signed output trun fields',
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
    expect(target.state.isAborted).toBe(true)
    expect(target.state.isClosed).toBe(false)
    expect(target.writable.locked).toBe(false)
  },
)

test.each([
  { name: 'maximum', offsets: [2 ** 31 - 1 + 1024, 0, 0], version: 0 },
  {
    name: 'minimum',
    offsets: [715_827_882, 1_431_655_765 - 1024, 2 ** 31 - 2048, -3072],
    version: 1,
  },
] as const)(
  'preserves the signed composition offset $name boundary',
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
