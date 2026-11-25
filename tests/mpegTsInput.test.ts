import { Buffer } from 'node:buffer'
import { expect, test } from 'vitest'
import { remuxMedia } from '../src'
import { REMUX_ERROR_CODE } from '../src/constants'
import { openMediaInput } from '../src/core/input/mediaInput'
import { diskStorage, fixture, memoryTarget, packets } from './helpers/media'

const packetSize = 188
const videoPid = 0x100
const audioPid = 0x101
const pmtPid = 0x1000
const clock = 90_000
const wrap = 2 ** 33

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

async function remux(input: Blob, tracks?: 'audio' | 'video') {
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
  const boundaries = [0, 5076, 8648, 13912, 17296, source.size]
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

test('rejects a TS program map change that moves a selected video PID', async () => {
  const source = await fixture('continuous-av.mpegts')
  const bytes = Buffer.from(await source.arrayBuffer())
  const transport = transportPackets(bytes)
  const maps = transport.filter(packet => packet.pid === pmtPid)
  const firstUpdate = transport.indexOf(maps[1]!)

  for (const { payload } of maps.slice(1)) {
    const start = 1 + payload[0]!
    const end = start + 3 + (payload.readUInt16BE(start + 1) & 0x0fff)
    const stream = start + 12 + (payload.readUInt16BE(start + 10) & 0x0fff)

    expect(payload[stream]).toBe(0x1b)
    payload[start + 5] = payload[start + 5]! + 2 // New table version.
    payload[start + 9] = 2 // Move the PCR with video.
    payload[stream + 2] = 2 // Move video from 0x100 to 0x102.

    let crc = -1

    for (const byte of payload.subarray(start, end - 4)) {
      crc ^= byte << 24

      for (let bit = 0; bit < 8; bit++) {
        crc = (crc << 1) ^ (crc < 0 ? 0x04_c1_1d_b7 : 0)
      }
    }

    payload.writeUInt32BE(crc >>> 0, end - 4)
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
