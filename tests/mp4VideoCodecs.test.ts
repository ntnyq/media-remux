import assert from 'node:assert/strict'
import { expect, test } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../src'
import { parseHevcSps } from '../src/vendor/mediabunny/src/codec-data'
import { diskStorage, fixture, memoryTarget, packets } from './helpers/media'

const videoTimescale = 57_600

/**
 * Reads sibling boxes from a small fixture with ordinary 32-bit box sizes.
 *
 * @param data - Contiguous box bytes.
 * @returns FourCCs and views into the original bytes.
 */
function boxes(data: Buffer) {
  const entries: { type: string; bytes: Buffer }[] = []

  for (let offset = 0; offset < data.length;) {
    const size = data.readUInt32BE(offset)

    assert.ok(size >= 8 && offset + size <= data.length)
    entries.push({
      type: data.toString('ascii', offset + 4, offset + 8),
      bytes: data.subarray(offset, offset + size),
    })
    offset += size
  }

  return entries
}

/**
 * Locates the bytes following a box's size and type.
 *
 * @param data - Sibling box bytes.
 * @param type - Required FourCC.
 * @returns Box payload, including any FullBox version and flags.
 */
function boxPayload(data: Buffer, type: string) {
  const box = boxes(data).find(entry => entry.type === type)

  assert.ok(box, `Missing ${type} box`)

  return box.bytes.subarray(8)
}

/**
 * Reads the first track's visual sample entry in the video-first fixtures.
 *
 * @param data - Complete input or output MP4 bytes.
 * @returns The stsd payload and the sample entry's type and child box bytes.
 */
function videoEntry(data: Buffer) {
  let payload = data

  for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']) {
    payload = boxPayload(payload, type)
  }

  expect(payload.readUInt32BE(4)).toBe(1)
  const entry = boxes(payload.subarray(8))[0]!

  // The VisualSampleEntry body starts after the box header and is 78 bytes.
  return { stsd: payload, type: entry.type, children: entry.bytes.subarray(86) }
}

/**
 * Checks the AV1 video track's decode clock and sample table flags.
 *
 * @param data - Fragmented MP4 output with video track ID 1.
 * @returns Video fragment start times in track ticks.
 */
function av1FragmentStarts(data: Buffer) {
  const starts: bigint[] = []
  const compositionFlags: number[] = []

  for (const fragment of boxes(data).filter(entry => entry.type === 'moof')) {
    for (const track of boxes(fragment.bytes.subarray(8))) {
      if (track.type === 'traf') {
        const children = track.bytes.subarray(8)

        if (boxPayload(children, 'tfhd').readUInt32BE(4) === 1) {
          const run = boxPayload(children, 'trun')

          compositionFlags.push(run.readUIntBE(1, 3) & 0x08_00)
          starts.push(boxPayload(children, 'tfdt').readBigUInt64BE(4))
        }
      }
    }
  }

  expect(starts.length).toBeGreaterThan(0)
  expect(compositionFlags).toStrictEqual(starts.map(() => 0))

  return starts
}

/**
 * Collects payloads and sync flags while dropping timing from packet comparisons.
 *
 * @param input - MP4 file to inspect.
 * @param kind - Track kind whose packets to read.
 * @returns Payload/flag pairs in decode order.
 */
async function encodedPackets(input: Blob, kind: 'video' | 'audio') {
  return (await packets(input, kind, { applyAudioEdit: true })).map(
    ({ data, type }) => ({ data, type }),
  )
}

// These SPS NAL units share the same 4:3, full-range BT.709 VUI after the
// reference-picture fields. FFmpeg's trace_headers verifies both bitstreams.
test.each([
  [
    'an 8-bit long-term picture order count',
    '42010101600000030090000003000003001ea030810596566924cb53bf0e6e02020208000003000800000300c040',
  ],
  [
    'chained short-term sets with a different number of retained references',
    '42010101600000030090000003000003001ea030810596566924c88bf7cde1cdc04040410000030001000003001808',
  ],
])('reads HEVC SPS display metadata after %s', (_description, sps) => {
  expect(parseHevcSps(Buffer.from(sps, 'hex'))).toMatchObject({
    pixelAspectRatio: { num: 4, den: 3 },
    fullRangeFlag: 1,
    colourPrimaries: 1,
    transferCharacteristics: 1,
    matrixCoefficients: 1,
  })
})

test.each([
  ['hvc1', 'hevc-hvc1.mp4'],
  ['hev1', 'hevc-hev1.mp4'],
])(
  'preserves the HEVC %s sample entry, hvcC and encoded packets',
  async (type, name) => {
    const input = await fixture(name)
    const audio = await fixture('audio.m4a')
    const source = videoEntry(Buffer.from(await input.arrayBuffer()))

    expect(source.type).toBe(type)

    const target = memoryTarget()

    await combineTracks(input, audio, {
      storage: await diskStorage(),
      writable: target.writable,
    })
    const output = target.blob()
    const entry = videoEntry(Buffer.from(await output.arrayBuffer()))

    expect(entry.type).toBe(type)
    expect(boxPayload(entry.children, 'hvcC')).toStrictEqual(
      boxPayload(source.children, 'hvcC'),
    )
    await expect(encodedPackets(output, 'video')).resolves.toStrictEqual(
      await encodedPackets(input, 'video'),
    )
    await expect(encodedPackets(output, 'audio')).resolves.toStrictEqual(
      await encodedPackets(audio, 'audio'),
    )
  },
)

test('preserves AV1 configuration and drops excluded AAC preroll without delaying video', async () => {
  const input = await fixture('av1-main10.mp4')
  const sourceBytes = Buffer.from(await input.arrayBuffer())
  const sourceConfig = boxPayload(videoEntry(sourceBytes).children, 'av1C')

  expect(sourceConfig.length).toBeGreaterThan(4)
  // Explicit initial presentation delay of one sample.
  sourceConfig[3] = 0x10
  const video = new Blob([sourceBytes])
  const audio = await fixture('audio.m4a')
  const sourceVideo = await packets(video, 'video')
  const sourceAudio = await packets(audio, 'audio')

  expect(sourceAudio[0]!.timestamp).toBeLessThan(sourceVideo[0]!.timestamp)

  const target = memoryTarget()

  await combineTracks(video, audio, {
    storage: await diskStorage(),
    writable: target.writable,
  })
  const output = target.blob()
  const data = Buffer.from(await output.arrayBuffer())
  const entry = videoEntry(data)

  expect(entry.type).toBe('av01')
  expect(boxPayload(entry.children, 'av1C')).toStrictEqual(sourceConfig)
  const compatibleBrands = boxPayload(data, 'ftyp')
    .toString('ascii', 8)
    .match(/.{4}/gu)

  expect(compatibleBrands).toContain('av01')
  expect(av1FragmentStarts(data)[0]).toBe(
    BigInt(Math.round(sourceVideo[0]!.timestamp * videoTimescale)),
  )

  const outputVideo = await packets(output, 'video')

  expect(outputVideo).toHaveLength(sourceVideo.length)

  for (const [index, original] of sourceVideo.entries()) {
    const actual = outputVideo[index]!

    expect(actual.data).toStrictEqual(original.data)
    expect(actual.type).toBe(original.type)
    expect(Math.abs(actual.timestamp - original.timestamp)).toBeLessThanOrEqual(
      1 / videoTimescale,
    )
    expect(Math.abs(actual.duration - original.duration)).toBeLessThanOrEqual(
      1 / videoTimescale,
    )
  }

  await expect(encodedPackets(output, 'audio')).resolves.toStrictEqual(
    await encodedPackets(audio, 'audio'),
  )
  expect((await packets(output, 'audio'))[0]!.timestamp).toBe(0)
})

test('writes colr when av1C has no configuration OBUs', async () => {
  const file = await fixture('av1-main10.mp4')
  const bytes = Buffer.from(await file.arrayBuffer())
  const { children } = videoEntry(bytes)
  const av1C = boxes(children).find(entry => entry.type === 'av1C')!.bytes
  // Replace the removed OBUs with a sibling free box to keep chunk offsets.
  const remainder = av1C.subarray(12)

  expect(remainder.length).toBeGreaterThanOrEqual(8)
  av1C.writeUInt32BE(12)
  remainder.writeUInt32BE(remainder.length)
  remainder.write('free', 4, 'ascii')
  const colr = boxes(children).find(entry => entry.type === 'colr')

  colr?.bytes.write('free', 4, 'ascii')

  const target = memoryTarget()

  await remuxMedia(new Blob([bytes]), {
    storage: await diskStorage(),
    writable: target.writable,
  })
  const result = videoEntry(Buffer.from(await target.blob().arrayBuffer()))

  expect(boxPayload(result.children, 'av1C')).toStrictEqual(
    av1C.subarray(8, 12),
  )
  expect(boxPayload(result.children, 'colr').toString('ascii', 0, 4)).toBe(
    'nclx',
  )
})

test('preserves raw MP4 color identifiers and rejects mismatched segments', async () => {
  const source = memoryTarget()

  await remuxMedia(await fixture('bt709-full-range.flv'), {
    storage: await diskStorage(),
    writable: source.writable,
  })
  const first = Buffer.from(await source.blob().arrayBuffer())
  // Valid SMPTE 240M identifiers override the BT.709 in the AVC SPS.
  const expected = Buffer.from('6e636c7800070007000780', 'hex')

  expected.copy(boxPayload(videoEntry(first).children, 'colr'))
  const video = new Blob([first])
  const audio = await fixture('audio.m4a')
  const combined = memoryTarget()

  await combineTracks(video, audio, {
    storage: await diskStorage(),
    writable: combined.writable,
  })
  const remuxed = memoryTarget()

  await remuxMedia(combined.blob(), {
    storage: await diskStorage(),
    writable: remuxed.writable,
  })
  const concatenated = memoryTarget()

  await concatMedia([video, video], {
    storage: await diskStorage(),
    writable: concatenated.writable,
  })

  for (const target of [combined, remuxed, concatenated]) {
    const { children } = videoEntry(
      Buffer.from(await target.blob().arrayBuffer()),
    )

    expect(boxPayload(children, 'colr')).toStrictEqual(expected)
  }

  for (const offset of [4, 6, 8]) {
    const second = Buffer.from(first)

    boxPayload(videoEntry(second).children, 'colr').writeUInt16BE(4, offset)
    const target = memoryTarget()

    await expect(
      concatMedia([video, new Blob([second])], {
        storage: await diskStorage(),
        writable: target.writable,
      }),
    ).rejects.toThrow(/incompatible track layout or decoder configuration/iu)
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  }
})

test('concatenates compatible AV1 and remuxes the resulting fragmented input', async () => {
  const input = await fixture('av1-main10.mp4')
  const expected = await encodedPackets(input, 'video')
  const combined = memoryTarget()
  const result = await concatMedia([input, input, input], {
    storage: await diskStorage(),
    writable: combined.writable,
  })
  const repeated = memoryTarget()
  const roundTrip = await remuxMedia(combined.blob(), {
    storage: await diskStorage(),
    writable: repeated.writable,
  })

  await expect(encodedPackets(repeated.blob(), 'video')).resolves.toStrictEqual(
    [...expected, ...expected, ...expected],
  )
  expect(roundTrip.duration).toBeCloseTo(result.duration, 4)
  const starts = av1FragmentStarts(
    Buffer.from(await repeated.blob().arrayBuffer()),
  )

  expect(starts[0]).toBe(0n)
  expect(starts.length).toBeGreaterThan(1)
})

test.each([
  ['hevc-hvc1.mp4', 'HEVC sample entry'],
  ['av1-main10.mp4', 'AV1 initial presentation delay'],
])(
  'rejects mismatched %s segment configurations before writing',
  async (name, change) => {
    const first = await fixture(name)
    const second = Buffer.from(await first.arrayBuffer())
    const entry = videoEntry(second)

    if (change === 'HEVC sample entry') {
      entry.stsd.write('hev1', 12, 'ascii')
    } else {
      const config = boxPayload(entry.children, 'av1C')

      config[3] = config[3] === 0x10 ? 0x11 : 0x10
    }

    const target = memoryTarget()

    await expect(
      concatMedia([first, new Blob([second])], {
        storage: await diskStorage(),
        writable: target.writable,
      }),
    ).rejects.toThrow(/incompatible track layout or decoder configuration/iu)
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  },
)

test.each([
  ['hevc-hvc1.mp4', 'hvcC'],
  ['av1-main10.mp4', 'av1C'],
])(
  'rejects an invalid configuration record in %s before writing',
  async (name, type) => {
    const bytes = Buffer.from(await (await fixture(name)).arrayBuffer())

    boxPayload(videoEntry(bytes).children, type)[0] = 0
    const target = memoryTarget()

    await expect(
      remuxMedia(new Blob([bytes]), {
        storage: await diskStorage(),
        writable: target.writable,
      }),
    ).rejects.toThrow(`Invalid ${type} configuration`)
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  },
)

test('preserves an AV1 video gap across a segment boundary and repeated remux', async () => {
  const video = await fixture('av1-main10.mp4')
  const audio = await fixture('audio.m4a')
  const combined = memoryTarget()

  // The audio extends beyond the video in each segment.
  const reference = await combineTracks(video, audio, {
    storage: await diskStorage(),
    writable: combined.writable,
  })
  const clip = combined.blob()
  const target = memoryTarget()

  const result = await concatMedia([clip, clip], {
    storage: await diskStorage(),
    writable: target.writable,
  })
  const output = target.blob()
  const repeated = memoryTarget()

  await remuxMedia(output, {
    storage: await diskStorage(),
    writable: repeated.writable,
  })

  const sourceVideo = await packets(clip, 'video')
  const sourceAudio = await packets(clip, 'audio')
  const tick = 1 / videoTimescale
  const lastVideo = sourceVideo.at(-1)!
  const secondVideoStart = reference.duration + sourceVideo[0]!.timestamp
  const gap = secondVideoStart - lastVideo.timestamp - lastVideo.duration

  expect(gap).toBeGreaterThan(0.7)
  expect(result.duration).toBeCloseTo(2 * reference.duration, 4)

  for (const file of [output, repeated.blob()]) {
    const starts = av1FragmentStarts(Buffer.from(await file.arrayBuffer()))

    expect(starts).toContain(
      BigInt(Math.round(secondVideoStart * videoTimescale)),
    )

    for (const [kind, source] of [
      ['video', sourceVideo],
      ['audio', sourceAudio],
    ] as const) {
      const actual = await packets(file, kind)
      const expected = [...source, ...source]

      expect(
        actual.map(packet => ({ data: packet.data, type: packet.type })),
      ).toStrictEqual(
        expected.map(packet => ({
          data: packet.data,
          type: packet.type,
        })),
      )

      for (const [index, packet] of actual.entries()) {
        const original = expected[index]!
        const shift = index < source.length ? 0 : reference.duration

        expect(packet.timestamp).toBeCloseTo(original.timestamp + shift, 4)

        const durationTolerance = kind === 'video' ? tick : 1 / 48_000

        expect(
          Math.abs(packet.duration - original.duration),
        ).toBeLessThanOrEqual(durationTolerance + Number.EPSILON)
      }
    }
  }
})
