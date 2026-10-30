/* oxlint-disable no-bitwise -- Binary media fields require masks, shifts, and flag manipulation. */
import { expect, test } from 'vitest'
import { concatMedia, remuxMedia } from '../src'
import { openMediaInput } from '../src/core/input/mediaInput'
import { trackSignature } from '../src/core/mediaTracks'
import { fixture, packets, diskStorage, memoryTarget } from './helpers/media'

test.each([
  { name: 'interlaced.flv', width: 320, height: 240, aspectWidth: 320 },
  { name: 'anamorphic.flv', width: 320, height: 240, aspectWidth: 640 },
])(
  'preserves FLV display geometry from $name in MP4 headers',
  async ({ name, width, height, aspectWidth }) => {
    const blob = await fixture(name)
    const input = await openMediaInput(blob)
    try {
      const config = input.tracks[0]?.config
      if (!config || 'sampleRate' in config) {
        throw new Error('Missing video configuration')
      }
      expect(config).toMatchObject({
        codedWidth: width,
        codedHeight: height,
      })
      expect(config.displayAspectWidth ?? width).toBe(aspectWidth)
      expect(config.displayAspectHeight ?? height).toBe(height)
    } finally {
      input.dispose()
    }
    const target = memoryTarget()
    await remuxMedia(blob, {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const bytes = Buffer.from(await target.blob().arrayBuffer())
    // Probe container fields independently of the SPS-aware input parser.
    const stsd = bytes.indexOf('stsd')
    const tkhd = bytes.indexOf('tkhd')
    expect(stsd).toBeGreaterThan(0)
    expect(tkhd).toBeGreaterThan(0)
    const entry = stsd + 12
    expect(bytes.toString('ascii', entry + 4, entry + 8)).toBe('avc1')
    expect(bytes.readUInt16BE(entry + 32)).toBe(width)
    expect(bytes.readUInt16BE(entry + 34)).toBe(height)
    expect(bytes.readUInt32BE(tkhd + 80) / 65_536).toBe(width)
    expect(bytes.readUInt32BE(tkhd + 84) / 65_536).toBe(height)
    const pasp = bytes.indexOf('pasp')
    const pixelAspectRatio =
      pasp === -1
        ? 1
        : bytes.readUInt32BE(pasp + 4) / bytes.readUInt32BE(pasp + 8)
    expect(pixelAspectRatio).toBe(aspectWidth / width)
    expect(
      (await packets(target.blob(), 'video')).map(packet => packet.data),
    ).toStrictEqual((await packets(blob, 'video')).map(packet => packet.data))
  },
)

test.each(['progressive.flv', 'bt709-full-range.flv'] as const)(
  'preserves track layouts and decoder signatures when remuxing %s to MP4',
  async name => {
    const flv = await fixture(name)
    const target = memoryTarget()
    await remuxMedia(flv, {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const signatures: string[][] = []
    for (const blob of [flv, target.blob()]) {
      const input = await openMediaInput(blob)
      try {
        expect(input.tracks.map(track => track.kind)).toStrictEqual(
          name === 'progressive.flv' ? ['video', 'audio'] : ['video'],
        )
        signatures.push(input.tracks.map(trackSignature))
      } finally {
        input.dispose()
      }
    }
    expect(signatures[1]).toStrictEqual(signatures[0])
  },
)

function tags(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = []
  let offset = view.getUint32(5) + 4
  while (offset < bytes.length) {
    const size = view.getUint32(offset) & 0xff_ff_ff
    entries.push({
      offset,
      size,
      type: bytes[offset],
      packetType: bytes[offset + 12],
    })
    offset += 11 + size + 4
  }
  return entries
}

/**
 * Replaces the AAC sequence header without changing any encoded media payload.
 *
 * @param description - Replacement AudioSpecificConfig bytes.
 * @returns The real FLV fixture with corrected tag and previous-tag sizes.
 */
async function withAacDescription(description: Uint8Array) {
  const bytes = Buffer.from(
    await (await fixture('progressive.flv')).arrayBuffer(),
  )
  const entry = tags(bytes).find(tag => tag.type === 8 && tag.packetType === 0)!
  const header = Buffer.from(bytes.subarray(entry.offset, entry.offset + 13))
  const size = 2 + description.length
  header.writeUIntBE(size, 1, 3)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(11 + size)

  return new Blob([
    bytes.subarray(0, entry.offset),
    header,
    Uint8Array.from(description),
    tail,
    bytes.subarray(entry.offset + 11 + entry.size + 4),
  ])
}

test.each([
  { name: 'double-rate SBR', hex: '118856e580' },
  { name: 'same-rate SBR', hex: '118856e598' },
])(
  'rejects implicitly signaled $name before writing FLV output',
  async ({ hex }) => {
    const input = await withAacDescription(Buffer.from(hex, 'hex'))
    const target = memoryTarget()

    await expect(
      remuxMedia(input, {
        tracks: 'audio',
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toThrow(/AAC-LC/u)
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  },
)

test('accepts AAC-LC when its sync extension explicitly disables SBR', async () => {
  const input = await withAacDescription(Buffer.from('118856e500', 'hex'))
  const track = await openMediaInput(input, undefined, 'audio')
  try {
    const first = await track.tracks[0]!.packets().next()
    expect(first.value?.duration).toBe(1024 / 48_000)
    expect(track.tracks[0]!.config).toMatchObject({
      codec: 'mp4a.40.2',
      sampleRate: 48_000,
      numberOfChannels: 1,
    })
  } finally {
    track.dispose()
  }
})

test('discards implicitly signaled SBR audio when only video is selected', async () => {
  const input = await withAacDescription(Buffer.from('118856e580', 'hex'))
  const target = memoryTarget()
  await remuxMedia(input, {
    tracks: 'video',
    writable: target.writable,
    storage: await diskStorage(),
  })
  const source = await packets(await fixture('progressive.flv'), 'video')
  const output = await packets(target.blob(), 'video')
  expect(output.map(packet => packet.data)).toStrictEqual(
    source.map(packet => packet.data),
  )
  expect(target.state.isClosed).toBe(true)
})

test('preserves explicit full-range BT.709 SPS colors across FLV and MP4 concatenation', async () => {
  const flv = await fixture('bt709-full-range.flv')
  const remuxed = memoryTarget()
  await remuxMedia(flv, {
    writable: remuxed.writable,
    storage: await diskStorage(),
  })
  const mp4 = remuxed.blob()
  const target = memoryTarget()
  await concatMedia([flv, mp4], {
    writable: target.writable,
    storage: await diskStorage(),
  })

  for (const blob of [flv, mp4, target.blob()]) {
    const input = await openMediaInput(blob)
    try {
      expect(input.tracks[0]?.config).toMatchObject({
        colorSpace: {
          primaries: 'bt709',
          transfer: 'bt709',
          matrix: 'bt709',
          fullRange: true,
        },
      })
    } finally {
      input.dispose()
    }
  }
  // Check container signaling independently of the SPS-aware packet reader.
  const bytes = Buffer.from(await target.blob().arrayBuffer())
  const colr = bytes.indexOf('colr')
  expect(colr).toBeGreaterThan(0)
  expect(bytes.toString('ascii', colr + 4, colr + 8)).toBe('nclx')
  expect(bytes.readUInt16BE(colr + 8)).toBe(1)
  expect(bytes.readUInt16BE(colr + 10)).toBe(1)
  expect(bytes.readUInt16BE(colr + 12)).toBe(1)
  expect(bytes[colr + 14]).toBe(128)
  const source = await packets(flv, 'video')
  expect(
    (await packets(target.blob(), 'video')).map(packet => packet.data),
  ).toStrictEqual([...source, ...source].map(packet => packet.data))
})

test('rejects actual container color changes before touching concatenation output', async () => {
  const remuxed = memoryTarget()
  await remuxMedia(await fixture('bt709-full-range.flv'), {
    writable: remuxed.writable,
    storage: await diskStorage(),
  })
  const original = remuxed.blob()
  const bytes = Buffer.from(await original.arrayBuffer())
  const colr = bytes.indexOf('colr')
  expect(colr).toBeGreaterThan(0)

  for (const field of [8, 10, 12, 14]) {
    const changed = Buffer.from(bytes)
    if (field === 14) {
      changed[colr + field] = 0
    } else {
      // SMPTE 170M differs from the BT.709 values in the unchanged SPS.
      changed.writeUInt16BE(6, colr + field)
    }
    const target = memoryTarget()
    await expect(
      concatMedia([original, new Blob([changed])], {
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toThrow('Incompatible')
    expect(target.state.writes).toStrictEqual([])
    expect(target.state.isClosed).toBe(false)
    expect(target.state.isAborted).toBe(false)
    expect(target.writable.locked).toBe(false)
  }
})

test('reads signed FLV composition offsets and preserves decode order', async () => {
  const bytes = new Uint8Array(
    await (await fixture('progressive.flv')).arrayBuffer(),
  )
  const tag = tags(bytes).find(
    entry => entry.type === 9 && entry.packetType === 1,
  )
  if (!tag) {
    throw new Error('Missing video packet')
  }
  const original = await packets(new Blob([bytes]), 'video')
  // Signed -20 ms.
  bytes.set([0xff, 0xff, 0xec], tag.offset + 13)
  const changed = await packets(new Blob([bytes]), 'video')
  const dts =
    (bytes[tag.offset + 4] ?? 0) * 65_536 +
    (bytes[tag.offset + 5] ?? 0) * 256 +
    (bytes[tag.offset + 6] ?? 0) +
    (bytes[tag.offset + 7] ?? 0) * 16_777_216
  expect(changed[0]?.timestamp).toBeCloseTo(dts / 1000 - 0.02, 8)
  expect(changed.map(packet => packet.data)).toStrictEqual(
    original.map(packet => packet.data),
  )
})

test('rejects changing FLV sequence headers and invalid previous-tag sizes', async () => {
  const bytes = new Uint8Array(
    await (await fixture('progressive.flv')).arrayBuffer(),
  )
  const tag = tags(bytes).find(
    entry => entry.type === 8 && entry.packetType === 0,
  )
  if (!tag) {
    throw new Error('Missing AAC configuration')
  }
  const changedHeader = bytes.slice(tag.offset, tag.offset + 11 + tag.size + 4)
  changedHeader[13] = (changedHeader[13] ?? 0) ^ 0x10
  await expect(
    openMediaInput(new Blob([bytes, changedHeader])),
  ).rejects.toThrow('configuration changes')
  const corrupt = bytes.slice()
  corrupt[tag.offset + 11 + tag.size + 3] = 0xff
  await expect(openMediaInput(new Blob([corrupt]))).rejects.toThrow(
    'previous tag size',
  )
})

test('rejects unsupported FLV codecs before writing output', async () => {
  const bytes = new Uint8Array(
    await (await fixture('progressive.flv')).arrayBuffer(),
  )
  const tag = tags(bytes).find(entry => entry.type === 9)
  if (!tag) {
    throw new Error('Missing video tag')
  }
  // Sorenson H.263.
  bytes[tag.offset + 11] = 0x12
  const target = memoryTarget()
  await expect(
    remuxMedia(new Blob([bytes]), {
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toThrow('only H.264')
  expect(target.state.writes).toStrictEqual([])
})

test('extracts selected AAC without requiring the discarded FLV video codec', async () => {
  const original = await fixture('progressive.flv')
  const bytes = new Uint8Array(await original.arrayBuffer())
  for (const tag of tags(bytes).filter(entry => entry.type === 9)) {
    bytes[tag.offset + 11] = 0x12
  }
  const target = memoryTarget()
  await remuxMedia(new Blob([bytes]), {
    tracks: 'audio',
    writable: target.writable,
    storage: await diskStorage(),
  })
  const before = await packets(original, 'audio')
  const after = await packets(target.blob(), 'audio')
  expect(after.map(packet => packet.data)).toStrictEqual(
    before.map(packet => packet.data),
  )
  await expect(packets(target.blob(), 'video')).resolves.toStrictEqual([])
})
