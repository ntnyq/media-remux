import assert from 'node:assert/strict'
import { expect, test, vi } from 'vitest'
import { concatMedia, remuxMedia } from '../../src'
import { openMediaInput } from '../../src/core/input/openMediaInput'
import { Input } from '../../src/vendor/mediabunny/src/input'
import { MP4 } from '../../src/vendor/mediabunny/src/input-format'
import { BlobSource } from '../../src/vendor/mediabunny/src/source'
import { diskStorage, fixture, memoryTarget, packets } from '../helpers/media'
import { boxPayloads } from '../helpers/mp4Boxes'
import { fragmentedMp4 } from '../helpers/mp4Fragments'
import { indexedMp4 } from '../helpers/mp4Index'

test('remuxes MP4 without reading optional movie metadata payloads', async () => {
  // This fixture places moov after mdat, so adding metadata leaves chunk offsets intact.
  const original = await fixture('fractional-av.mp4')
  const bytes = Buffer.from(await original.arrayBuffer())
  const [movie] = boxPayloads(bytes, 'moov')

  assert.ok(movie)
  const header = movie.byteOffset - bytes.byteOffset - 8
  const end = header + 8 + movie.length
  const metadata = Buffer.alloc(128 * 1024)

  metadata.writeUInt32BE(metadata.length)
  metadata.write('udta', 4)
  metadata.writeUInt32BE(metadata.length - 8, 8)
  metadata.write('free', 12)
  bytes.writeUInt32BE(movie.length + 8 + metadata.length, header)
  const input = new Blob([
    bytes.subarray(0, end),
    metadata,
    bytes.subarray(end),
  ])
  const target = memoryTarget()
  const storage = await diskStorage()
  const read = vi.spyOn(BlobSource.prototype, '_read')

  try {
    await remuxMedia(input, { storage, writable: target.writable })
    expect(read.mock.calls.length).toBeGreaterThan(0)
    expect(
      Math.max(...read.mock.calls.map(([start, stop]) => stop - start)),
    ).toBeLessThanOrEqual(64 * 1024)
  } finally {
    read.mockRestore()
  }

  expect(
    (await packets(target.blob(), 'video')).map(packet => packet.data),
  ).toEqual((await packets(original, 'video')).map(packet => packet.data))
})

test('rejects external MP4 sample data only when its track is selected', async () => {
  // The movie metadata follows mdat so changing the data reference keeps all
  // local chunk offsets intact. The first track in this fixture is video.
  const source = await fixture('fractional-av.mp4')
  const bytes = Buffer.from(await source.arrayBuffer())
  const location = Buffer.from('separate-media.mp4\0')
  const ancestors: Buffer[] = []
  let parent: Buffer = bytes

  for (const type of ['moov', 'trak', 'mdia', 'minf', 'dinf', 'dref']) {
    const [payload] = boxPayloads(parent, type)

    assert.ok(payload)
    ancestors.push(payload)
    parent = payload
  }

  const entry = parent.subarray(8)

  expect(entry.length).toBe(12)
  expect(entry.toString('ascii', 4, 8)).toBe('url ')
  entry.writeUInt32BE(entry.length + location.length, 0)
  entry.writeUInt32BE(0, 8) // URL refers to a separate file.

  for (const payload of ancestors) {
    bytes.writeUInt32BE(
      payload.length + 8 + location.length,
      payload.byteOffset - bytes.byteOffset - 8,
    )
  }

  const end = entry.byteOffset - bytes.byteOffset + entry.length
  const input = new Blob([
    bytes.subarray(0, end),
    location,
    bytes.subarray(end),
  ])
  const target = memoryTarget()

  await expect(
    remuxMedia(input, {
      storage: await diskStorage(),
      writable: target.writable,
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_FEATURE' })
  expect(target.state.writes).toEqual([])

  await remuxMedia(input, {
    tracks: 'audio',
    storage: await diskStorage(),
    writable: target.writable,
  })
  expect(
    (await packets(target.blob(), 'audio')).map(packet => packet.data),
  ).toEqual(
    (await packets(source, 'audio', { applyAudioEdit: true })).map(
      packet => packet.data,
    ),
  )
})

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

test('keeps the movie transformation when the movie header follows the track', async () => {
  const original = await fixture('video.mp4')
  const bytes = Buffer.from(await original.arrayBuffer())
  const mvhd = bytes.indexOf('mvhd') - 4
  const headerEnd = mvhd + bytes.readUInt32BE(mvhd)
  const moov = bytes.indexOf('moov') - 4
  const moovEnd = moov + bytes.readUInt32BE(moov)
  const matrix = [0, 1, 0, -1, 0, 0, 0, 0, 1]
  const target = memoryTarget()

  expect(bytes[mvhd + 8]).toBe(0)
  expect(bytes.indexOf('trak')).toBeGreaterThan(headerEnd)

  for (const [index, value] of matrix.entries()) {
    bytes.writeInt32BE(
      value * 2 ** (index % 3 === 2 ? 30 : 16),
      mvhd + 44 + 4 * index,
    )
  }

  await remuxMedia(
    new Blob([
      bytes.subarray(0, mvhd),
      bytes.subarray(headerEnd, moovEnd),
      bytes.subarray(mvhd, headerEnd),
      bytes.subarray(moovEnd),
    ]),
    {
      writable: target.writable,
      storage: await diskStorage(),
    },
  )
  const output = await openMediaInput(target.blob())

  try {
    expect(
      output.tracks.find(track => track.kind === 'video')?.matrix,
    ).toStrictEqual(matrix)
  } finally {
    output.dispose()
  }
})

test('finds a track whose media handler follows the sample table', async () => {
  const original = await fixture('audio.m4a')
  const bytes = Buffer.from(await original.arrayBuffer())
  const mdia = bytes.indexOf('mdia') - 4
  const hdlr = bytes.indexOf('hdlr', mdia) - 4
  const handlerEnd = hdlr + bytes.readUInt32BE(hdlr)
  const mediaEnd = mdia + bytes.readUInt32BE(mdia)
  const target = memoryTarget()

  expect(bytes.indexOf('stbl', mdia)).toBeGreaterThan(handlerEnd)
  await remuxMedia(
    new Blob([
      bytes.subarray(0, hdlr),
      bytes.subarray(handlerEnd, mediaEnd),
      bytes.subarray(hdlr, handlerEnd),
      bytes.subarray(mediaEnd),
    ]),
    {
      writable: target.writable,
      storage: await diskStorage(),
    },
  )
  expect(
    (await packets(target.blob(), 'audio')).map(packet => packet.data),
  ).toStrictEqual(
    (await packets(original, 'audio', { applyAudioEdit: true })).map(
      packet => packet.data,
    ),
  )
})

test('checks multiple MP4 sample descriptions only on selected tracks', async () => {
  const input = await fixture('progressive.mp4')
  const original = Buffer.from(await input.arrayBuffer())
  const moovStart = original.indexOf('moov') - 4
  const moovEnd = moovStart + original.readUInt32BE(moovStart)
  const stsd = original.indexOf('stsd', moovStart)
  const entryStart = stsd + 12
  const entry = original.subarray(
    entryStart,
    entryStart + original.readUInt32BE(entryStart),
  )

  // Add a second valid AVC sample entry and relocate moov to preserve stco.
  for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']) {
    const offset = original.indexOf(type, moovStart) - 4

    original.writeUInt32BE(original.readUInt32BE(offset) + entry.length, offset)
  }

  original.writeUInt32BE(2, stsd + 8)
  const moov = Buffer.concat([
    original.subarray(moovStart, entryStart),
    entry,
    original.subarray(entryStart, moovEnd),
  ])

  original.writeUInt32BE(moovEnd - moovStart, moovStart)
  original.write('free', moovStart + 4, 'ascii')
  const multipleDescriptions = new Blob([original, moov])
  const target = memoryTarget()

  await remuxMedia(multipleDescriptions, {
    tracks: 'audio',
    storage: await diskStorage(),
    writable: target.writable,
  })

  const source = await packets(input, 'audio', { applyAudioEdit: true })
  const actual = await packets(target.blob(), 'audio')

  expect(actual.map(packet => packet.data)).toStrictEqual(
    source.map(packet => packet.data),
  )
  const videoTarget = memoryTarget()

  await expect(
    remuxMedia(multipleDescriptions, {
      tracks: 'video',
      storage: await diskStorage(),
      writable: videoTarget.writable,
    }),
  ).rejects.toThrow(/Multiple MP4 sample descriptions/u)
  expect(videoTarget.state.writes).toHaveLength(0)
})

test.each([0, 2])(
  'rejects an MP4 composition table covering %s samples in its final one-sample run',
  async count => {
    const source = await fixture('vfr-bframes.mp4')
    const bytes = Buffer.from(await source.arrayBuffer())
    const ctts = bytes.indexOf('ctts')
    const lastRun = ctts + 12 + (bytes.readUInt32BE(ctts + 8) - 1) * 8
    const target = memoryTarget()

    expect(bytes.readUInt32BE(lastRun)).toBe(1)
    bytes.writeUInt32BE(count, lastRun)

    await expect(
      remuxMedia(new Blob([bytes]), {
        storage: await diskStorage(),
        writable: target.writable,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('ctts'),
    })
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  },
)

test.each([
  [0, 25],
  [1, 49],
  [1, 1],
  [25, 1],
])(
  'rejects invalid MP4 sync sample indices %s and %s',
  async (first, second) => {
    const source = await fixture('video.mp4')
    const bytes = Buffer.from(await source.arrayBuffer())
    const stss = bytes.indexOf('stss')
    const target = memoryTarget()

    expect(bytes.readUInt32BE(stss + 8)).toBe(2)
    bytes.writeUInt32BE(first, stss + 12)
    bytes.writeUInt32BE(second, stss + 16)

    await expect(
      remuxMedia(new Blob([bytes]), {
        storage: await diskStorage(),
        writable: target.writable,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('stss'),
    })
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  },
)

test.each([0, 2])(
  'rejects an invalid MP4 stsc description index %s on the selected track',
  async index => {
    const original = await fixture('progressive.mp4')
    const bytes = Buffer.from(await original.arrayBuffer())
    const stsc = bytes.indexOf('stsc')
    const video = memoryTarget()
    const audio = memoryTarget()

    expect(bytes.readUInt32BE(stsc + 20)).toBe(1)
    bytes.writeUInt32BE(index, stsc + 20)
    const input = new Blob([bytes])

    await expect(
      remuxMedia(input, {
        tracks: 'video',
        storage: await diskStorage(),
        writable: video.writable,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('chunk sample description'),
    })
    expect(video.state.writes).toHaveLength(0)

    await remuxMedia(input, {
      tracks: 'audio',
      storage: await diskStorage(),
      writable: audio.writable,
    })
    expect(await packets(audio.blob(), 'audio')).toStrictEqual(
      await packets(original, 'audio', { applyAudioEdit: true }),
    )
  },
)

test.each([
  'truncated-header',
  'truncated-large-header',
  'invalid-box-size',
  'oversized-mdat',
  'unsafe-large-mdat',
] as const)(
  'rejects %s in fragmented MP4 before touching remux or concat output',
  async variant => {
    const fragmented = await fragmentedMp4({ fragments: 3, indexed: false })
    const original = fragmented.blob()
    let bytes = new Uint8Array(await original.arrayBuffer())
    const lastMoof = fragmented.fragmentOffset(1, 2)
    const mdat = Buffer.from(bytes).indexOf('mdat') - 4

    expect(mdat).toBeGreaterThan(0)

    if (variant === 'truncated-header') {
      bytes = bytes.slice(0, lastMoof + 4)
    } else if (variant === 'truncated-large-header') {
      bytes = bytes.slice(0, lastMoof + 12)
      new DataView(bytes.buffer).setUint32(lastMoof, 1)
    } else if (variant === 'invalid-box-size') {
      new DataView(bytes.buffer).setUint32(lastMoof, 4)
    } else {
      const view = new DataView(bytes.buffer)

      if (variant === 'oversized-mdat') {
        view.setUint32(mdat, bytes.length + 1)
      } else {
        view.setUint32(mdat, 1)
        view.setBigUint64(mdat + 8, 2n ** 53n)
      }
    }

    const malformed = new Blob([bytes])

    for (const inputs of [[malformed], [original, malformed]]) {
      const target = memoryTarget()
      const options = {
        writable: target.writable,
        storage: await diskStorage(),
      }

      await expect(
        inputs.length === 1
          ? remuxMedia(malformed, options)
          : concatMedia(inputs, options),
      ).rejects.toBeInstanceOf(RangeError)
      expect(target.state.writes).toStrictEqual([])
      expect(target.state.isClosed).toBe(false)
      expect(target.state.isAborted).toBe(false)
      expect(target.writable.locked).toBe(false)
    }
  },
)

test.each(['mdat', 'free'] as const)(
  'accepts a terminal size-zero %s box without losing packets',
  async kind => {
    const fragmented = await fragmentedMp4({ fragments: 3, indexed: false })
    const original = fragmented.blob()
    const bytes = new Uint8Array(await original.arrayBuffer())
    const mdat = Buffer.from(bytes).lastIndexOf('mdat') - 4

    expect(mdat).toBeGreaterThan(0)
    let blob: Blob

    if (kind === 'mdat') {
      new DataView(bytes.buffer).setUint32(mdat, 0)
      blob = new Blob([bytes])
    } else {
      blob = new Blob([bytes, Uint8Array.of(0, 0, 0, 0), 'free', 'padding'])
    }

    const target = memoryTarget()
    const result = await remuxMedia(blob, {
      writable: target.writable,
      storage: await diskStorage(),
    })
    const before = await packets(original, 'audio')
    const after = await packets(target.blob(), 'audio')

    expect(after).toHaveLength(9)
    expect(after).toStrictEqual(before)
    expect(result.duration).toBe(0.192)
    expect(target.state.isClosed).toBe(true)
    expect(target.writable.locked).toBe(false)
  },
)

test.each(['stts', 'stsc', 'stco'] as const)(
  'rejects an undersized empty %s initialization table before touching remux or concat output',
  async name => {
    const fragmented = await fragmentedMp4({ fragments: 3, indexed: false })
    const original = fragmented.blob()
    const bytes = Buffer.from(await original.arrayBuffer())
    // Empty regular tables are valid in fragmented initialization metadata, but
    // invalid headers must still reject rather than hide the remaining tables.
    const offset = bytes.indexOf(name)

    expect(offset).toBeGreaterThan(0)
    bytes.writeUInt32BE(4, offset - 4)
    const malformed = new Blob([bytes])

    for (const inputs of [[malformed], [original, malformed]]) {
      const target = memoryTarget()
      const options = {
        writable: target.writable,
        storage: await diskStorage(),
      }

      await expect(
        inputs.length === 1
          ? remuxMedia(malformed, options)
          : concatMedia(inputs, options),
      ).rejects.toBeInstanceOf(RangeError)
      expect(target.state.writes).toStrictEqual([])
      expect(target.state.isClosed).toBe(false)
      expect(target.state.isAborted).toBe(false)
      expect(target.writable.locked).toBe(false)
    }
  },
)

test.each(['stts', 'stsc', 'stss', 'stco', 'tfhd', 'trun'] as const)(
  'rejects an undersized nested %s box before touching remux or concat output',
  async name => {
    const fragmented = await fragmentedMp4({ fragments: 3, indexed: false })
    const isFragmentBox = name === 'tfhd' || name === 'trun'
    const original = isFragmentBox
      ? fragmented.blob()
      : await fixture('video.mp4')
    const bytes = Buffer.from(await original.arrayBuffer())
    const offset = bytes.indexOf(
      name,
      isFragmentBox ? fragmented.fragmentOffset(1, 1) : 0,
    )

    expect(offset).toBeGreaterThan(0)
    bytes.writeUInt32BE(4, offset - 4)
    const malformed = new Blob([bytes])

    for (const inputs of [[malformed], [original, malformed]]) {
      const target = memoryTarget()
      const options = {
        writable: target.writable,
        storage: await diskStorage(),
      }

      await expect(
        inputs.length === 1
          ? remuxMedia(malformed, options)
          : concatMedia(inputs, options),
      ).rejects.toBeInstanceOf(RangeError)
      expect(target.state.writes).toStrictEqual([])
      expect(target.state.isClosed).toBe(false)
      expect(target.state.isAborted).toBe(false)
      expect(target.writable.locked).toBe(false)
    }
  },
)

test('remuxes every regular and fragmented sample in a hybrid MP4', async () => {
  const input = await fixture('hybrid.mp4')
  const target = memoryTarget()
  const result = await remuxMedia(input, {
    writable: target.writable,
    storage: await diskStorage(),
  })
  const source = await packets(input, 'video')
  const output = await packets(target.blob(), 'video')

  expect(source).toHaveLength(75)
  expect(output).toHaveLength(75)
  expect(output.map(packet => packet.data)).toStrictEqual(
    source.map(packet => packet.data),
  )
  const start = Math.min(...source.map(packet => packet.timestamp))

  for (const [index, packet] of output.entries()) {
    expect(packet.timestamp).toBeCloseTo(source[index]!.timestamp - start, 4)
    expect(packet.duration).toBeCloseTo(source[index]!.duration, 4)
  }

  expect(result.duration).toBeCloseTo(3, 4)
})

test.each(['stts-short', 'stts-long', 'stsc-short', 'stsc-long'])(
  'rejects inconsistent MP4 sample counts (%s) before touching output',
  async variant => {
    const bytes = new Uint8Array(
      await (await fixture('video.mp4')).arrayBuffer(),
    )
    const view = new DataView(bytes.buffer)
    const name = variant.startsWith('stts') ? 'stts' : 'stsc'
    const offset = Buffer.from(bytes).indexOf(name)

    expect(offset).toBeGreaterThan(0)
    // The fixture has one timing run; stsc's first row starts at chunk one.
    const field = offset + (name === 'stts' ? 12 : 16)

    view.setUint32(
      field,
      variant.endsWith('short') ? 1 : view.getUint32(field) + 1,
    )
    const target = memoryTarget()

    await expect(
      remuxMedia(new Blob([bytes]), {
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toThrow('sample counts')
    expect(target.state.writes).toStrictEqual([])
    expect(target.state.isClosed).toBe(false)
    expect(target.state.isAborted).toBe(false)
    expect(target.writable.locked).toBe(false)
  },
)

test('rejects an MP4 chunk mapping that references a nonexistent chunk', async () => {
  const source = await indexedMp4({ samples: 2 })
  const bytes = Buffer.from(await source.blob().arrayBuffer())
  const stsc = bytes.indexOf('stsc')

  expect(stsc).toBeGreaterThan(0)
  expect(bytes.readUInt32BE(stsc + 24)).toBe(2)
  // The first run now covers both available chunks, leaving the total sample
  // count correct even though the second run has no corresponding offset.
  bytes.writeUInt32BE(3, stsc + 24)
  const target = memoryTarget()

  await expect(
    remuxMedia(new Blob([bytes]), {
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('stsc'),
  })
  expect(target.state.writes).toStrictEqual([])
  expect(target.writable.locked).toBe(false)
})

test.each(['regular', 'fragmented'] as const)(
  'rejects truncated %s MP4 payloads before touching output',
  async format => {
    const input =
      format === 'regular'
        ? await fixture('video.mp4')
        : (await fragmentedMp4({ fragments: 2, indexed: false })).blob()
    const truncated = input.slice(0, input.size - 1)

    for (const inputs of [[truncated], [input, truncated]]) {
      const target = memoryTarget()

      await expect(
        concatMedia(inputs, {
          writable: target.writable,
          storage: await diskStorage(),
        }),
      ).rejects.toThrow('sample payload')
      expect(target.state.writes).toStrictEqual([])
      expect(target.state.isClosed).toBe(false)
      expect(target.state.isAborted).toBe(false)
      expect(target.writable.locked).toBe(false)
    }
  },
)
