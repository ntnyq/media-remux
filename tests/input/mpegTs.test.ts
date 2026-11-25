import { Buffer } from 'node:buffer'
import { expect, test, vi } from 'vitest'
import {
  combineTracks,
  remuxMedia,
  type RemuxInput,
  type RemuxTrackSelection,
} from '../../src'
import { REMUX_ERROR_CODE } from '../../src/constants'
import { openMediaInput } from '../../src/core/input/openMediaInput'
import {
  MpegTsDemuxer,
  UnsupportedMpegTsError,
} from '../../src/vendor/mediabunny/src/mpeg-ts/mpeg-ts-demuxer'
import { Reader } from '../../src/vendor/mediabunny/src/reader'
import { BlobSource } from '../../src/vendor/mediabunny/src/source'
import { diskStorage, fixture, memoryTarget, packets } from '../helpers/media'

const packetSize = 188
const videoPid = 0x100
const audioPid = 0x101
const pmtPid = 0x1000
const clock = 90_000
const wrap = 2 ** 33
const segmentOffsets = [0, 5076, 8648, 13912, 17296]

// Independent ffprobe PTS values in decode order. DTS advances by 7500 ticks.
const videoPts = [
  15000, 37500, 22500, 30000, 60000, 45000, 52500, 82500, 67500, 75000, 105000,
  90000, 97500, 127500, 112500, 120000, 135000, 157500, 142500, 150000, 180000,
  165000, 172500, 202500, 187500, 195000, 225000, 210000, 217500, 232500,
]
const firstAudioPts = 12910

function transportPackets(data: Buffer) {
  return Array.from({ length: data.length / packetSize }, (_, index) => {
    const offset = index * packetSize
    const packet = data.subarray(offset, offset + packetSize)
    const pid = packet.readUInt16BE(1) & 0x1fff
    const startsPes = Boolean(packet[1]! & 0x40)
    const payload =
      packet[3]! & 0x10
        ? packet.subarray(packet[3]! & 0x20 ? 5 + packet[4]! : 4)
        : packet.subarray(packetSize)

    return { packet, pid, startsPes, payload }
  })
}

function resetSegmentCounters(bytes: Buffer) {
  for (const [index, start] of segmentOffsets.entries()) {
    const firstCounters = new Map<number, number>()

    for (const { packet, pid, payload } of transportPackets(
      bytes.subarray(start, segmentOffsets[index + 1]),
    )) {
      if (payload.length > 0) {
        const counter = packet[3]! & 15
        const first = firstCounters.get(pid) ?? counter

        firstCounters.set(pid, first)
        packet[3] = (packet[3]! & 0xf0) | ((counter - first) & 15)
      }
    }
  }
}

/** Moves every PES timestamp through the same 33-bit wrap. */
function shiftPesTimestamps(data: Buffer, shift: number) {
  for (const { pid, startsPes, payload } of transportPackets(data)) {
    if (!startsPes || (pid !== videoPid && pid !== audioPid)) {
      continue
    }

    const count = payload[7]! >> 6 === 3 ? 2 : 1

    for (let index = 0; index < count; index++) {
      const at = 9 + 5 * index
      const pts =
        ((payload[at]! >> 1) & 7) * 2 ** 30 +
        (payload.readUInt16BE(at + 1) >> 1) * 2 ** 15 +
        (payload.readUInt16BE(at + 3) >> 1)
      const shifted = (pts + shift) % wrap

      payload[at] = (payload[at]! & 0xf1) | (Math.floor(shifted / 2 ** 30) << 1)
      payload.writeUInt16BE((((shifted / 2 ** 15) & 0x7fff) << 1) | 1, at + 1)
      payload.writeUInt16BE(((shifted & 0x7fff) << 1) | 1, at + 3)
    }
  }
}

function readPes(data: Buffer, pid: number, count: number) {
  const transport = transportPackets(data)
  const starts = transport
    .flatMap((packet, index) =>
      packet.pid === pid && packet.startsPes ? [index] : [],
    )
    .slice(0, count + 1)

  return starts.slice(0, -1).map((start, index) => {
    const end = starts[index + 1]!
    const pes = Buffer.concat(
      transport
        .slice(start, end)
        .filter(packet => packet.pid === pid)
        .map(packet => packet.payload),
    )
    const headerSize = 9 + pes[8]!
    const length = pes.readUInt16BE(4)

    return {
      start,
      end,
      header: pes.subarray(0, headerSize),
      data: pes.subarray(headerSize, length === 0 ? pes.length : 6 + length),
    }
  })
}

function replacePes(
  bytes: Buffer,
  pid: number,
  start: number,
  end: number,
  replacements: { header: Buffer; data: Buffer }[],
) {
  const replacement: Buffer[] = []
  let counter = 0

  for (const { header, data } of replacements) {
    const pes = Buffer.concat([header, data])

    pes.writeUInt16BE(pes.length - 6, 4)

    for (let offset = 0; offset < pes.length; offset += 184) {
      const payload = pes.subarray(offset, offset + 184)
      const packet = Buffer.alloc(packetSize, 0xff)
      const adaptation = 184 - payload.length

      packet[0] = 0x47
      packet[1] = (pid >> 8) | (offset === 0 ? 0x40 : 0)
      packet[2] = pid & 0xff
      packet[3] = (adaptation === 0 ? 0x10 : 0x30) | (counter++ & 15)

      if (adaptation > 0) {
        packet[4] = adaptation - 1

        if (adaptation > 1) {
          packet[5] = 0
        }
      }

      payload.copy(packet, 4 + adaptation)
      replacement.push(packet)
    }
  }

  const result = Buffer.concat(
    transportPackets(bytes).flatMap(({ pid: current, packet }, index) => {
      if (index === start) {
        return replacement
      }

      return index > start && index < end && current === pid ? [] : [packet]
    }),
  )

  // Repacketizing changes the number of transport packets on this PID.
  counter = 0

  for (const { pid: current, packet, payload } of transportPackets(result)) {
    if (current === pid && payload.length > 0) {
      packet[3] = (packet[3]! & 0xf0) | (counter++ & 15)
    }
  }

  return result
}

async function remux(input: RemuxInput, tracks?: RemuxTrackSelection) {
  const target = memoryTarget()
  const result = await remuxMedia(input, {
    writable: target.writable,
    storage: await diskStorage(),
    ...(tracks === undefined ? {} : { tracks }),
  })

  return { result, output: target.blob() }
}

test('remuxes consecutive TS fragments that start on dependent pictures', async () => {
  const source = await fixture('continuous-av.mpegts')
  const boundaries = [...segmentOffsets, source.size]
  // Each Blob part represents a distinct HLS download.
  const input = new Blob(
    boundaries
      .slice(1)
      .map((end, index) => source.slice(boundaries[index], end)),
  )
  const { result, output } = await remux(input)
  const video = await packets(output, 'video')
  const audio = await packets(output, 'audio')
  const expectedVideo = await packets(input, 'video')
  const expectedAudio = await packets(input, 'audio')

  expect(result.mimeType).toBe('video/mp4')
  expect(result.duration).toBeCloseTo((109 * 1024) / 44100, 8)
  expect(video.map(packet => packet.data)).toStrictEqual(
    expectedVideo.map(packet => packet.data),
  )
  expect(audio.map(packet => packet.data)).toStrictEqual(
    expectedAudio.map(packet => packet.data),
  )
  expect(video).toHaveLength(30)
  expect(audio).toHaveLength(109)
  expect(
    video.flatMap((packet, index) => (packet.type === 'key' ? [index] : [])),
  ).toEqual([0, 16])

  for (const [index, packet] of video.entries()) {
    expect(packet.timestamp).toBeCloseTo(
      (videoPts[index]! - firstAudioPts) / clock,
      4,
    )
    expect(packet.decodeDuration).toBeCloseTo(1 / 12, 6)
  }

  expect(audio[0]!.timestamp).toBeCloseTo(0, 4)
  expect(audio[108]!.timestamp).toBeCloseTo((108 * 1024) / 44100, 4)

  const avc3 = await openMediaInput(output)

  try {
    expect(avc3.tracks[0]?.config.codec).toMatch(/^avc3\./)
  } finally {
    avc3.dispose()
  }
})

test('remuxes and combines explicit TS segments with reset counters on the original clock', async () => {
  const source = await fixture('continuous-av.mpegts')
  const bytes = Buffer.from(await source.arrayBuffer())
  const gap = 9000
  const shift = wrap - 51000

  // Put a timestamp rollover and a gap at the first segment transition.
  shiftPesTimestamps(bytes, shift)
  shiftPesTimestamps(bytes.subarray(segmentOffsets[1]!), gap)

  // Replace a service description packet with a video adaptation-only packet.
  // Its counter must not use up the reset opportunity for the video PID.
  const adaptation = bytes.subarray(
    segmentOffsets[2]!,
    segmentOffsets[2]! + packetSize,
  )

  adaptation.fill(0xff)
  adaptation.set([0x47, videoPid >> 8, videoPid & 0xff, 0x2b, 183, 0])

  const continuous = new Blob([bytes])

  resetSegmentCounters(bytes)

  const blob = new Blob([bytes])
  const input = { blob, segmentOffsets, allowContinuityCounterReset: true }

  for (const strictInput of [blob, { blob, segmentOffsets }]) {
    await expect(remux(strictInput)).rejects.toMatchObject({
      code: REMUX_ERROR_CODE.invalidInput,
      message: expect.stringContaining('continuity counter is out of sequence'),
    })
  }

  async function readSource(sourceInput: RemuxInput) {
    const media = await openMediaInput(sourceInput)

    try {
      return await Promise.all(
        media.tracks.map(async track => {
          const encoded = []

          for await (const packet of track.packets()) {
            encoded.push(packet)
          }

          return encoded
        }),
      )
    } finally {
      media.dispose()
    }
  }

  const encoded = await readSource(input)

  expect(encoded).toStrictEqual(await readSource(continuous))
  expect(
    encoded[0]!.map(
      packet => Math.round(packet.sideData.decodeTimestamp! * clock) - shift,
    ),
  ).toEqual(videoPts.map((_, index) => index * 7500 + (index >= 7 ? gap : 0)))
  expect(
    encoded[0]!.map(packet => Math.round(packet.timestamp * clock) - shift),
  ).toEqual(videoPts.map((pts, index) => pts + (index >= 7 ? gap : 0)))

  const baseline = await remux(continuous)
  const actual = await remux(input)
  const target = memoryTarget()
  const combined = await combineTracks(input, input, {
    writable: target.writable,
    storage: await diskStorage(),
  })

  expect(actual.result).toStrictEqual(baseline.result)
  expect(combined).toStrictEqual(baseline.result)
  expect(actual.result.duration).toBeCloseTo(
    (109 * 1024) / 44100 + gap / clock,
    4,
  )

  for (const kind of ['video', 'audio'] as const) {
    const expected = await packets(baseline.output, kind)

    expect(await packets(actual.output, kind)).toStrictEqual(expected)
    expect(await packets(target.blob(), kind)).toStrictEqual(expected)
  }
})

test.each([
  {
    scenario: 'a packet inside a segment',
    drop: 10340,
    starts: segmentOffsets,
    error:
      'continuity counter is out of sequence. (segment 2, PID 256, byte offset 10340)',
  },
  {
    scenario: 'the first packet of a PES continuation across a boundary',
    drop: 1128,
    starts: [0, 1128],
    error:
      'continuity counter is out of sequence. (segment 1, PID 256, byte offset 1128)',
  },
  {
    scenario: 'the last packet of a bounded PES before a boundary',
    drop: 4888,
    starts: segmentOffsets,
    error:
      'Truncated MPEG-TS PES packet. (segment 1, PID 257, byte offset 6580)',
  },
])(
  'rejects loss of $scenario with resets enabled',
  async ({ drop, starts, error }) => {
    const source = await fixture('continuous-av.mpegts')
    const bytes = Buffer.from(await source.arrayBuffer())

    resetSegmentCounters(bytes)

    const target = memoryTarget()
    const input = {
      blob: new Blob([
        bytes.subarray(0, drop),
        bytes.subarray(drop + packetSize),
      ]),
      segmentOffsets: starts.map(start =>
        start > drop ? start - packetSize : start,
      ),
      allowContinuityCounterReset: true,
    }

    await expect(
      remuxMedia(input, {
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toMatchObject({
      code: REMUX_ERROR_CODE.invalidInput,
      message: expect.stringContaining(error),
    })
    expect(target.state.writes).toEqual([])
    expect(target.writable.locked).toBe(false)
  },
)

test.each([
  { firstPayload: 'continuous', duplicate: false },
  { firstPayload: 'duplicated', duplicate: true },
])(
  'consumes the reset opportunity on a $firstPayload PES continuation',
  async ({ duplicate }) => {
    const source = await fixture('continuous-av.mpegts')
    const start = 940
    const prefix = source.slice(0, start)
    const repeat = duplicate
      ? source.slice(start - packetSize, start)
      : new Blob()
    const input = {
      blob: new Blob([prefix, repeat, source.slice(start)]),
      segmentOffsets: [0, start],
      allowContinuityCounterReset: true,
    }

    const actual = await remux(input)
    const baseline = await remux(source)

    expect(actual.result).toStrictEqual(baseline.result)
    expect(await packets(actual.output, 'video')).toStrictEqual(
      await packets(baseline.output, 'video'),
    )

    // Lose the last packet of the unbounded PES after the first payload.
    const drop = 2256

    input.blob = new Blob([
      prefix,
      repeat,
      source.slice(start, drop),
      source.slice(drop + packetSize),
    ])

    await expect(remux(input)).rejects.toMatchObject({
      code: REMUX_ERROR_CODE.invalidInput,
      message: expect.stringContaining(
        `continuity counter is out of sequence. (segment 1, PID 256, byte offset ${drop + repeat.size})`,
      ),
    })
  },
)

test('checks the new PES header even when the segment may reset its counter', async () => {
  const source = await fixture('continuous-av.mpegts')
  const bytes = Buffer.from(await source.arrayBuffer())

  resetSegmentCounters(bytes)

  const packet = transportPackets(bytes)[9212 / packetSize]!

  packet.payload[2] = 0

  await expect(
    remux({
      blob: new Blob([bytes]),
      segmentOffsets,
      allowContinuityCounterReset: true,
    }),
  ).rejects.toMatchObject({
    code: REMUX_ERROR_CODE.invalidInput,
    message:
      'Invalid MPEG-TS PES header. (segment 2, PID 256, byte offset 9212)',
  })
})

test.each([
  { table: 'PAT', offset: 5264, pid: 0 },
  { table: 'PMT', offset: 5452, pid: pmtPid },
])(
  'still checks the $table checksum across explicit segments',
  async ({ offset, pid }) => {
    const source = await fixture('continuous-av.mpegts')
    const bytes = Buffer.from(await source.arrayBuffer())

    resetSegmentCounters(bytes)

    const { payload } = transportPackets(bytes)[offset / packetSize]!
    const tableStart = 1 + payload[0]!
    const sectionLength = payload.readUInt16BE(tableStart + 1) & 0x0fff
    const checksumByte = tableStart + 3 + sectionLength - 1

    payload[checksumByte] = payload[checksumByte]! ^ 1

    await expect(
      remux({
        blob: new Blob([bytes]),
        segmentOffsets,
        allowContinuityCounterReset: true,
      }),
    ).rejects.toMatchObject({
      code: REMUX_ERROR_CODE.invalidInput,
      message: `Invalid MPEG-TS program table checksum. (segment 1, PID ${pid}, byte offset ${offset})`,
    })
  },
)

test.each([
  { starts: [], case: 'empty list' },
  { starts: [188], case: 'missing zero' },
  { starts: [0, 0], case: 'duplicate offset' },
  { starts: [0, 376, 188], case: 'out-of-order offset' },
  { starts: [0, 189], case: 'unaligned offset' },
  { starts: [0, 20304], case: 'offset at EOF' },
])('rejects explicit segment offsets with $case', async ({ starts }) => {
  const blob = await fixture('continuous-av.mpegts')

  await expect(
    remux({
      blob,
      segmentOffsets: starts,
      allowContinuityCounterReset: true,
    }),
  ).rejects.toMatchObject({ code: REMUX_ERROR_CODE.invalidInput })
})

test.each([25000, 10000])(
  'unwraps A/V together with first video DTS %i ticks before rollover',
  async ticksBeforeWrap => {
    const source = await fixture('continuous-av.mpegts')
    const bytes = Buffer.from(await source.arrayBuffer())
    const shift = wrap - ticksBeforeWrap

    shiftPesTimestamps(bytes, shift)

    const input = new Blob([bytes])
    const media = await openMediaInput(input)

    try {
      const videoTrack = media.tracks[0]!
      const encoded = []

      for await (const packet of videoTrack.packets(true)) {
        encoded.push(packet)
      }

      expect(
        encoded.map(packet => Math.round(packet.timestamp * clock) - shift),
      ).toEqual(videoPts)
      expect(
        encoded.map(
          packet =>
            Math.round(packet.sideData.decodeTimestamp! * clock) - shift,
        ),
      ).toEqual(videoPts.map((_, index) => index * 7500))
    } finally {
      media.dispose()
    }

    const { output, result } = await remux(input)
    const video = await packets(output, 'video')
    const audio = await packets(output, 'audio')

    expect(result.duration).toBeCloseTo((109 * 1024) / 44100, 8)
    expect(video[0]!.timestamp - audio[0]!.timestamp).toBeCloseTo(
      (15000 - firstAudioPts) / clock,
      4,
    )
    expect(video).toHaveLength(30)
    expect(audio).toHaveLength(109)
    expect(audio[108]!.timestamp).toBeCloseTo((108 * 1024) / 44100, 4)

    const audioOnly = await remux(input, 'audio')

    expect(audioOnly.result.mimeType).toBe('audio/mp4')
    expect(await packets(audioOnly.output, 'video')).toEqual([])
    expect(await packets(audioOnly.output, 'audio')).toStrictEqual(audio)
  },
)

test('rejects an oversized AVC framing buffer before copying the payload', async () => {
  const source = new BlobSource(new Blob())

  using ref = source.ref()
  const demuxer = new MpegTsDemuxer(new Reader(ref.source), 0, () => {})
  const payloads = vi.spyOn(demuxer, 'pesPayloads')

  payloads.mockImplementation(async function* () {
    yield { data: new Uint8Array(32 * 1024 * 1024 + 1), timing: null }
  })

  await expect(demuxer.readAvc(videoPid).next()).rejects.toBeInstanceOf(
    UnsupportedMpegTsError,
  )
})

test('bounds pending PES timestamps while framing AVC across payloads', async () => {
  const source = new BlobSource(new Blob())

  using ref = source.ref()
  const demuxer = new MpegTsDemuxer(new Reader(ref.source), 0, () => {})
  const timing = { pts: 0, dts: 0 }
  const byte = Uint8Array.of(0xff)

  vi.spyOn(demuxer, 'pesPayloads').mockImplementation(async function* () {
    yield { data: Uint8Array.of(0, 0, 1, 0x09, 0xf0), timing }

    for (let index = 0; index < 65_536; index++) {
      yield { data: byte, timing }
    }
  })

  await expect(demuxer.readAvc(videoPid).next()).rejects.toThrow(
    new UnsupportedMpegTsError(
      'MPEG-TS elementary stream has too many pending PES timestamps.',
    ),
  )
})

test('keeps AVC and AAC frame timing and payload across PES and a split Annex B start code', async () => {
  const source = await fixture('continuous-av.mpegts')
  const bytes = Buffer.from(await source.arrayBuffer())
  const [first, second] = readPes(bytes, videoPid, 2)
  const cut = first!.data.length - 23

  expect(second!.data.subarray(0, 5)).toEqual(Buffer.from([0, 0, 0, 1, 9]))

  const splitVideo = replacePes(bytes, videoPid, first!.start, second!.end, [
    { header: first!.header, data: first!.data.subarray(0, cut) },
    {
      header: Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0, 0]),
      data: Buffer.concat([
        first!.data.subarray(cut),
        second!.data.subarray(0, 2),
      ]),
    },
    { header: second!.header, data: second!.data.subarray(2) },
  ])
  const [audio] = readPes(splitVideo, audioPid, 1)
  const splitBoth = replacePes(splitVideo, audioPid, audio!.start, audio!.end, [
    { header: audio!.header, data: audio!.data.subarray(0, 4) },
    {
      header: Buffer.from([0, 0, 1, 0xc0, 0, 0, 0x80, 0, 0]),
      data: audio!.data.subarray(4),
    },
  ])
  const { output, result } = await remux(new Blob([splitBoth]))
  const baseline = await remux(source)

  expect(result).toStrictEqual(baseline.result)
  expect(await packets(output, 'video')).toStrictEqual(
    await packets(baseline.output, 'video'),
  )
  expect(await packets(output, 'audio')).toStrictEqual(
    await packets(baseline.output, 'audio'),
  )
})

test('reports a truncated TS before writing the output', async () => {
  const source = await fixture('continuous-av.mpegts')
  const target = memoryTarget()

  await expect(
    remuxMedia(source.slice(0, -1), {
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toMatchObject({
    code: REMUX_ERROR_CODE.invalidInput,
    message: 'Truncated MPEG-TS packet.',
  })
  expect(target.state.writes).toEqual([])
  expect(target.writable.locked).toBe(false)
})

test('rejects a missing transport packet in a video PES of unspecified length', async () => {
  const source = await fixture('continuous-av.mpegts')
  const bytes = Buffer.from(await source.arrayBuffer())
  const [video] = readPes(bytes, videoPid, 1)
  const offset = (video!.start + 1) * packetSize
  const input = new Blob([
    bytes.subarray(0, offset),
    bytes.subarray(offset + packetSize),
  ])
  const target = memoryTarget()

  await expect(
    remuxMedia(input, {
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toMatchObject({ code: REMUX_ERROR_CODE.invalidInput })
  expect(target.state.writes).toEqual([])
})

test('copies a repeated transport payload once', async () => {
  const source = await fixture('continuous-av.mpegts')
  const bytes = Buffer.from(await source.arrayBuffer())
  const [video] = readPes(bytes, videoPid, 1)
  const offset = (video!.start + 1) * packetSize
  const input = new Blob([
    bytes.subarray(0, offset + packetSize),
    bytes.subarray(offset),
  ])
  const { output } = await remux(input)
  const baseline = await remux(source)

  expect(await packets(output, 'video')).toStrictEqual(
    await packets(baseline.output, 'video'),
  )
})

test('can extract audio when a discarded TS video stream fails the timestamp probe', async () => {
  const source = await fixture('continuous-av.mpegts')
  const bytes = Buffer.from(await source.arrayBuffer())
  const [video] = readPes(bytes, videoPid, 1)
  const offset = video!.start * packetSize

  bytes[offset + 3] = bytes[offset + 3]! | 0x80

  const { output } = await remux(new Blob([bytes]), 'audio')
  const baseline = await remux(source, 'audio')

  expect(await packets(output, 'audio')).toStrictEqual(
    await packets(baseline.output, 'audio'),
  )
})

function updateProgramMap(
  payload: Buffer,
  update: (start: number, firstStream: number) => void,
) {
  const start = 1 + payload[0]!
  const firstStream = start + 12 + (payload.readUInt16BE(start + 10) & 0x0fff)

  update(start, firstStream)
  const end = start + 3 + (payload.readUInt16BE(start + 1) & 0x0fff)
  let crc = -1

  for (const byte of payload.subarray(start, end - 4)) {
    crc ^= byte << 24

    for (let bit = 0; bit < 8; bit++) {
      crc = (crc << 1) ^ (crc < 0 ? 0x04_c1_1d_b7 : 0)
    }
  }

  payload.writeUInt32BE(crc >>> 0, end - 4)
}

test.each([
  { kind: 'video', type: 0x24, retained: 'audio' },
  { kind: 'audio', type: 0x11, retained: 'video' },
  { kind: 'audio', type: 0x81, retained: 'video' },
  { kind: 'audio', type: 0x06, retained: 'video' },
] as const)(
  'rejects unsupported TS $kind type $type when selected and allows discarding it',
  async ({ kind, type, retained }) => {
    const source = await fixture('continuous-av.mpegts')
    const bytes = Buffer.from(await source.arrayBuffer())

    for (const { payload } of transportPackets(bytes).filter(
      packet => packet.pid === pmtPid,
    )) {
      updateProgramMap(payload, (start, video) => {
        const audio = video + 5 + (payload.readUInt16BE(video + 3) & 0x0fff)
        const stream = kind === 'video' ? video : audio

        expect(payload[stream]).toBe(kind === 'video' ? 0x1b : 0x0f)
        payload[stream] = type

        if (type === 0x06) {
          // Signal AC-3 via a DVB descriptor in the final stream entry.
          payload.writeUInt16BE(0xf003, audio + 3)
          payload.set([0x6a, 1, 0], audio + 5)
          payload.writeUInt16BE(payload.readUInt16BE(start + 1) + 3, start + 1)
        }
      })
    }

    const input = new Blob([bytes])

    for (const tracks of [
      undefined,
      kind,
      'first-video-with-optional-audio',
    ] as const) {
      await expect(remux(input, tracks)).rejects.toMatchObject({
        code: REMUX_ERROR_CODE.unsupportedCodec,
      })
    }

    const { output } = await remux(input, retained)
    const baseline = await remux(source, retained)

    expect(await packets(output, retained)).toStrictEqual(
      await packets(baseline.output, retained),
    )
  },
)

test('rejects a TS program map change that moves a selected video PID', async () => {
  const source = await fixture('continuous-av.mpegts')
  const bytes = Buffer.from(await source.arrayBuffer())
  const transport = transportPackets(bytes)
  const maps = transport.filter(packet => packet.pid === pmtPid)
  const firstUpdate = transport.indexOf(maps[1]!)

  for (const { payload } of maps.slice(1)) {
    updateProgramMap(payload, (start, stream) => {
      expect(payload[stream]).toBe(0x1b)
      payload[start + 5] = payload[start + 5]! + 2 // New table version.
      payload[start + 9] = 2 // Move the PCR with video.
      payload[stream + 2] = 2 // Move video from 0x100 to 0x102.
    })
  }

  for (const { packet, pid } of transport.slice(firstUpdate + 1)) {
    if (pid === videoPid) {
      packet[2] = 2
    }
  }

  const input = new Blob([bytes])
  const target = memoryTarget()

  await expect(
    remuxMedia(input, {
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toMatchObject({ code: REMUX_ERROR_CODE.unsupportedMediaFeature })
  expect(target.state.writes).toEqual([])

  const audioOnly = await remux(input, 'audio')
  const baseline = await remux(source, 'audio')

  expect(await packets(audioOnly.output, 'audio')).toStrictEqual(
    await packets(baseline.output, 'audio'),
  )
})
