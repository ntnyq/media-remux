import assert from 'node:assert/strict'
import { expect, test } from 'vitest'
import { remuxMedia } from '../src'
import {
  deserializeAvcDecoderConfigurationRecord,
  parseAvcSps,
  serializeAvcDecoderConfigurationRecord,
} from '../src/vendor/mediabunny/src/codec-data'
import { Input } from '../src/vendor/mediabunny/src/input'
import { MP4 } from '../src/vendor/mediabunny/src/input-format'
import { BlobSource } from '../src/vendor/mediabunny/src/source'
import { StreamTarget } from '../src/vendor/mediabunny/src/target'
import type { StreamTargetChunk } from '../src/vendor/mediabunny/src/target'
import { Writer } from '../src/vendor/mediabunny/src/writer'
import { diskStorage, fixture, memoryTarget, packets } from './helpers/media'

const high444Sps = '67f4000a919b28c4d87370101014000003000400000300c03c489658'

/**
 * Reads ordinary sibling boxes from the small remux output.
 *
 * @param bytes - Complete MP4 boxes.
 * @param type - Box FourCC to select.
 * @returns Payloads of matching boxes in file order.
 */
function boxPayloads(bytes: Buffer, type: string) {
  const payloads: Buffer[] = []

  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset)

    assert.ok(size >= 8 && offset + size <= bytes.length)

    if (bytes.toString('ascii', offset + 4, offset + 8) === type) {
      payloads.push(bytes.subarray(offset + 8, offset + size))
    }

    offset += size
  }

  return payloads
}

test.each(['free', 'skip', 'wide'])(
  'remuxes MP4 with %s padding and no ftyp without moving sample offsets',
  async padding => {
    const input = await fixture('video.mp4')
    const bytes = Buffer.from(await input.arrayBuffer())

    expect(bytes.toString('ascii', 4, 8)).toBe('ftyp')
    bytes.write(padding, 4, 'ascii')

    const target = memoryTarget()

    await remuxMedia(new Blob([bytes]), {
      storage: await diskStorage(),
      writable: target.writable,
    })
    expect(
      (await packets(target.blob(), 'video')).map(packet => packet.data),
    ).toStrictEqual((await packets(input, 'video')).map(packet => packet.data))
  },
)

test.each([
  ['isom', true],
  ['qt  ', false],
] as const)(
  'checks the %s brand in a 64-bit ftyp box',
  async (brand, accepted) => {
    const bytes = Buffer.alloc(24)

    bytes.writeUInt32BE(1)
    bytes.write('ftyp', 4, 'ascii')
    bytes.writeBigUInt64BE(BigInt(bytes.length), 8)
    bytes.write(brand, 16, 'ascii')
    const input = new Input({
      formats: [MP4],
      source: new BlobSource(new Blob([bytes])),
    })

    try {
      await expect(input.canRead()).resolves.toBe(accepted)
    } finally {
      input.dispose()
    }
  },
)

test.each([134, 135, 138, 139, 144])(
  'reads the common high-profile SPS fields for AVC profile %i',
  profileIdc => {
    // Use the shared SPS syntax preceding VUI, with x264's High 4:4:4
    // dimensions, 4:3 sample aspect ratio, and full-range BT.709 metadata.
    const sps = Buffer.from(high444Sps, 'hex')

    sps[1] = profileIdc
    expect(parseAvcSps(sps)).toMatchObject({
      chromaFormatIdc: 3,
      displayWidth: 96,
      displayHeight: 64,
      pixelAspectRatio: { num: 4, den: 3 },
      fullRangeFlag: 1,
      colourPrimaries: 1,
      transferCharacteristics: 1,
      matrixCoefficients: 1,
    })
  },
)

test('round-trips the High 4:4:4 Predictive AVC configuration extension', () => {
  const sps = Buffer.from(high444Sps, 'hex')
  const pps = Buffer.from('68ebe3c44844', 'hex')
  const description = Buffer.concat([
    Buffer.from([1, 244, 0, 10, 255, 225, 0, sps.length]),
    sps,
    Buffer.from([1, 0, pps.length]),
    pps,
    Buffer.from([255, 248, 248, 0]),
  ])
  const record = deserializeAvcDecoderConfigurationRecord(description)

  expect(record).toMatchObject({
    chromaFormat: 3,
    bitDepthLumaMinus8: 0,
    bitDepthChromaMinus8: 0,
    sequenceParameterSetExt: [],
  })
  assert.ok(record)
  expect(
    Buffer.from(serializeAvcDecoderConfigurationRecord(record)),
  ).toStrictEqual(description)
})

test('signals one packet of AAC seek pre-roll in each applicable fragment', async () => {
  const input = await fixture('fractional-av.mp4')
  const target = memoryTarget()

  await remuxMedia(input, {
    tracks: 'audio',
    storage: await diskStorage(),
    writable: target.writable,
  })
  const output = target.blob()
  const moofs = boxPayloads(Buffer.from(await output.arrayBuffer()), 'moof')

  expect(moofs.length).toBeGreaterThan(1)

  for (const [index, moof] of moofs.entries()) {
    const [traf] = boxPayloads(moof, 'traf')

    assert.ok(traf)
    const [run] = boxPayloads(traf, 'trun')
    const [description] = boxPayloads(traf, 'sgpd')
    const [mapping] = boxPayloads(traf, 'sbgp')

    assert.ok(run && description && mapping)
    const count = run.readUInt32BE(4)

    expect(description.readUInt8(0)).toBe(1)
    expect(description.toString('ascii', 4, 8)).toBe('roll')
    expect(description.readUInt32BE(8)).toBe(2)
    expect(description.readUInt32BE(12)).toBe(1)
    expect(description.readInt16BE(16)).toBe(-1)
    expect(mapping.toString('ascii', 4, 8)).toBe('roll')
    const entries = Array.from({ length: mapping.readUInt32BE(8) }, (_, at) => [
      mapping.readUInt32BE(12 + 8 * at),
      mapping.readUInt32BE(16 + 8 * at),
    ])

    expect(entries).toStrictEqual(
      index === 0
        ? [
            [1, 0],
            [count - 1, 0x1_00_01],
          ]
        : [[count, 0x1_00_01]],
    )
  }

  expect(
    (await packets(output, 'audio')).map(packet => packet.data),
  ).toStrictEqual(
    (await packets(input, 'audio', { applyAudioEdit: true })).map(
      packet => packet.data,
    ),
  )
})

test('remuxes AAC-LC FLV with a channel layout in the program config element', async () => {
  const input = await fixture('aac-pce.flv')
  const target = memoryTarget()

  await remuxMedia(input, {
    storage: await diskStorage(),
    writable: target.writable,
  })

  const output = target.blob()
  const parsed = new Input({
    formats: [MP4],
    source: new BlobSource(output),
  })

  try {
    const track = await parsed.getPrimaryAudioTrack()

    await expect(track?.getNumberOfChannels()).resolves.toBe(2)
    await expect(track?.getSampleRate()).resolves.toBe(48_000)
  } finally {
    parsed.dispose()
  }

  expect(
    (await packets(output, 'audio')).map(packet => packet.data),
  ).toStrictEqual((await packets(input, 'audio')).map(packet => packet.data))
})

test('writes a single buffer spanning thousands of stream chunks', async () => {
  const input = new Uint8Array(16 * 1024 * 1024 + 17).fill(0xab)
  let end = 0
  const stream = new WritableStream<StreamTargetChunk>({
    write({ data, position }) {
      assert.equal(position, end)
      assert.equal(data[0], 0xab)
      assert.equal(data.at(-1), 0xab)
      end += data.byteLength
    },
  })
  const target = new StreamTarget(stream, { chunked: true, chunkSize: 1024 })
  const writer = new Writer(target, true)

  writer.start()
  writer.write(input)
  await writer.flush()
  await writer.finalize()
  expect(end).toBe(input.byteLength)
  expect(stream.locked).toBe(false)
})
