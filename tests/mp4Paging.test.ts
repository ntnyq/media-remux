import { expect, test } from 'vitest'
import { Input } from '../src/vendor/mediabunny/src/input'
import { MP4 } from '../src/vendor/mediabunny/src/input-format'
import { EncodedPacketSink } from '../src/vendor/mediabunny/src/media-sink'
import { BlobSource } from '../src/vendor/mediabunny/src/source'
import { fixture as readFixture } from './helpers/media'
import { fragmentedMp4 } from './helpers/mp4Fragments'
import { indexedMp4 } from './helpers/mp4Index'
import { largeMoof } from './helpers/mp4Moof'

test.each([
  { trunVersion: 0, compositionShift: 2 ** 31 - 1 },
  { trunVersion: 0, compositionShift: 2 ** 31 },
  { trunVersion: 0, compositionShift: 2 ** 32 - 1 },
  { trunVersion: 1, compositionShift: -2048 },
] as const)(
  'reads trun v$trunVersion composition offset $compositionShift without changing its sign',
  async ({ trunVersion, compositionShift }) => {
    const fixture = await fragmentedMp4({
      fragments: 2,
      indexed: false,
      trunVersion,
      compositionShift,
      multipleRuns: true,
    })
    const input = new Input({ formats: [MP4], source: fixture.source })
    try {
      const track = await input.getPrimaryAudioTrack()
      if (!track) {
        throw new Error('Missing track')
      }
      const sink = new EncodedPacketSink(track)
      for (const metadataOnly of [true, false]) {
        let packet = await sink.getFirstPacket({ metadataOnly })
        for (let index = 0; index < 6; index++) {
          expect(packet?.timestamp).toBe(fixture.timestamp(index))
          expect(packet?.duration).toBe(1024 / 48_000)
          expect(packet?.isMetadataOnly).toBe(metadataOnly)
          expect(packet?.data).toStrictEqual(
            metadataOnly ? new Uint8Array(0) : fixture.packet(1, index),
          )
          packet = await sink.getNextPacket(packet!, { metadataOnly })
        }
        expect(packet).toBeNull()
      }
      const found = await sink.getPacket(fixture.timestamp(4))
      expect(found?.timestamp).toBe(fixture.timestamp(4))
      expect(found?.data).toStrictEqual(fixture.packet(1, 4))
    } finally {
      input.dispose()
    }
  },
)

test.each([
  { metadataOnly: false, tfdt: true },
  { metadataOnly: true, tfdt: true },
  { metadataOnly: false, tfdt: false },
  { metadataOnly: true, tfdt: false },
])(
  'traverses and seeks across hybrid MP4 samples for metadataOnly=$metadataOnly, tfdt=$tfdt',
  async ({ metadataOnly, tfdt }) => {
    const bytes = Buffer.from(
      await (await readFixture('hybrid.mp4')).arrayBuffer(),
    )
    if (!tfdt) {
      // Leave box extents intact, forcing cumulative timing recovery without TFRA.
      for (const name of ['tfdt', 'mfra']) {
        let offset = bytes.indexOf(name)
        if (offset < 0) {
          throw new Error(`Missing ${name} box`)
        }
        while (offset >= 0) {
          bytes.write('free', offset, 'ascii')
          offset = bytes.indexOf(name, offset + 4)
        }
      }
    }
    const input = new Input({
      formats: [MP4],
      source: new BlobSource(new Blob([bytes])),
    })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track) {
        throw new Error('Missing video track')
      }
      const sink = new EncodedPacketSink(track)
      const options = { metadataOnly }
      const all = []
      let packet = await sink.getFirstPacket(options)
      while (packet) {
        all.push(packet)
        packet = await sink.getNextPacket(packet, options)
      }
      expect(all).toHaveLength(75)
      const keys = []
      packet = await sink.getFirstKeyPacket(options)
      while (packet) {
        keys.push(packet)
        packet = await sink.getNextKeyPacket(packet, options)
      }
      expect(keys.map(key => key.timestamp)).toStrictEqual([0.08, 1.08, 2.08])
      for (const timestamp of [Infinity, 0.5, 2.5, 1.08, 0, 1.5]) {
        const expected = all
          .toSorted((left, right) => right.timestamp - left.timestamp)
          .find(entry => entry.timestamp <= timestamp)
        const found = await sink.getPacket(timestamp, options)
        expect(found?.timestamp).toBe(expected?.timestamp)
        expect(found?.data).toStrictEqual(expected?.data)
        const key = await sink.getKeyPacket(timestamp, options)
        const expectedKey = keys.findLast(entry => entry.timestamp <= timestamp)
        expect(key?.timestamp).toBe(expectedKey?.timestamp)
        expect(key?.data).toStrictEqual(expectedKey?.data)
      }
    } finally {
      input.dispose()
    }
  },
)

test.each([false, true])(
  'rejects out-of-file sample payloads for metadataOnly=%s in regular and fragmented MP4',
  async metadataOnly => {
    const regular = await indexedMp4({ samples: 3, compositionOffsets: [] })
    const fragmented = await fragmentedMp4({ fragments: 1, indexed: false })
    for (const fixture of [regular, fragmented]) {
      const blob = fixture.blob()
      const input = new Input({
        formats: [MP4],
        source: new BlobSource(blob.slice(0, blob.size - 1)),
      })
      try {
        const track = await input.getPrimaryAudioTrack()
        if (!track) {
          throw new Error('Missing track')
        }
        const sink = new EncodedPacketSink(track)
        await expect(
          sink.getPacket(fixture.timestamp(2), { metadataOnly }),
        ).rejects.toThrow('sample payload')
      } finally {
        input.dispose()
      }
    }
  },
)

test.each([0, 2])(
  'respects a first sync sample at index %s across forward and backward lookups',
  async firstKeySample => {
    const fixture = await indexedMp4({
      samples: 9,
      firstKeySample,
      keyInterval: 3,
      compositionOffsets: [],
    })
    const input = new Input({ formats: [MP4], source: fixture.source })
    try {
      const track = await input.getPrimaryAudioTrack()
      if (!track) {
        throw new Error('Missing track')
      }
      const sink = new EncodedPacketSink(track)
      const first = await sink.getFirstPacket()
      expect(first?.type).toBe(firstKeySample === 0 ? 'key' : 'delta')
      const firstKey = await sink.getFirstKeyPacket()
      expect(firstKey?.data).toStrictEqual(fixture.packet(firstKeySample))
      expect((await sink.getNextKeyPacket(firstKey!))?.data).toStrictEqual(
        fixture.packet(firstKeySample + 3),
      )
      expect(
        (await sink.getKeyPacket(fixture.timestamp(firstKeySample)))?.data,
      ).toStrictEqual(fixture.packet(firstKeySample))
      // Query after forward lookups too, to exercise the cached key cursor.
      await expect(
        sink.getKeyPacket(fixture.timestamp(firstKeySample) - 1 / 48_000),
      ).resolves.toBeNull()
    } finally {
      input.dispose()
    }
  },
)

test('does not invent sync samples when stss is empty', async () => {
  const fixture = await indexedMp4({
    samples: 3,
    firstKeySample: 3,
    compositionOffsets: [],
  })
  const input = new Input({ formats: [MP4], source: fixture.source })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) {
      throw new Error('Missing track')
    }
    const sink = new EncodedPacketSink(track)
    expect((await sink.getFirstPacket())?.type).toBe('delta')
    await expect(sink.getFirstKeyPacket()).resolves.toBeNull()
    await expect(sink.getKeyPacket(Infinity)).resolves.toBeNull()
  } finally {
    input.dispose()
  }
})

test.each([
  { samples: 17_003 },
  { fieldSize: 4, samples: 131_079 },
  { fieldSize: 8, samples: 65_539 },
  { fieldSize: 16, samples: 32_771 },
  { samples: 17_003, co64: true, padding: 5 * 1024 ** 3 },
  { samples: 17_003, cttsVersion: 1, compositionOffsets: [-10, 0, 10] },
] as const)(
  'pages regular MP4 tables, including sparse >4 GiB moov: %j',
  async options => {
    const fixture = await indexedMp4(options)
    const input = new Input({ formats: [MP4], source: fixture.source })
    try {
      const track = await input.getPrimaryAudioTrack()
      expect(track).not.toBeNull()
      if (!track) {
        throw new Error('Missing track')
      }
      for (const table of fixture.tableRanges) {
        expect(
          fixture.requests.some(
            read => read.start < table.end && read.end > table.start + 32,
          ),
        ).toBe(false)
      }
      const sink = new EncodedPacketSink(track)
      for (const index of [fixture.samples - 1, 8192, 4096, 4095, 1, 0]) {
        const packet = await sink.getPacket(fixture.timestamp(index))
        expect(packet?.data).toStrictEqual(fixture.packet(index))
        expect(packet?.timestamp).toBe(fixture.timestamp(index))
      }
      expect(
        fixture.requests.every(read => read.end - read.start <= 64 * 1024),
      ).toBe(true)
      expect(
        fixture.reads.every(
          read =>
            !options.padding ||
            read.start < 128 ||
            read.start > options.padding,
        ),
      ).toBe(true)
    } finally {
      input.dispose()
    }
  },
)

test('pages TFRA indexes and rereads evicted fragments without retaining full indexes', async () => {
  const fixture = await fragmentedMp4({
    fragments: 1025,
    padding: 5 * 1024 ** 3,
  })
  const input = new Input({ formats: [MP4], source: fixture.source })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) {
      throw new Error('Missing track')
    }
    const sink = new EncodedPacketSink(track)
    for (const fragment of [1024, 0, 512, 255, 0]) {
      const index = fragment * fixture.samplesPerFragment
      const packet = await sink.getPacket(fixture.timestamp(index))
      expect(packet?.timestamp).toBe(fixture.timestamp(index))
      expect(packet?.data).toStrictEqual(fixture.packet(1, index))
    }
    expect(
      fixture.requests.every(read => read.end - read.start <= 64 * 1024),
    ).toBe(true)
  } finally {
    input.dispose()
  }
})

test.each(['forward', 'shuffle'] as const)(
  'pages a single large moof and preserves %s sample timing',
  async order => {
    const fixture = await largeMoof({ samples: 5003, runSize: 17, order })
    const input = new Input({ formats: [MP4], source: fixture.source })
    try {
      const track = await input.getPrimaryAudioTrack()
      if (!track) {
        throw new Error('Missing track')
      }
      const sink = new EncodedPacketSink(track)
      const ordered = Array.from(
        { length: fixture.samples },
        (_, index) => index,
      ).toSorted((left, right) => fixture.pts(left) - fixture.pts(right))
      for (const index of [5002, 4096, 2048, 0]) {
        const packet = await sink.getPacket(fixture.pts(index) / 48_000)
        expect(packet?.timestamp).toBe(fixture.pts(index) / 48_000)
        expect(packet?.data).toStrictEqual(fixture.packet(index))
        const next = ordered[ordered.indexOf(index) + 1]
        const expectedDuration =
          next === undefined
            ? fixture.duration(index)
            : fixture.pts(next) - fixture.pts(index)
        expect(packet?.duration).toBe(expectedDuration / 48_000)
      }
      expect(
        fixture.requests.every(read => read.end - read.start <= 64 * 1024),
      ).toBe(true)
    } finally {
      input.dispose()
    }
  },
)
