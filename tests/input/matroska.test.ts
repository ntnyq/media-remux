import { expect, test } from 'vitest'
import { concatMedia, remuxMedia } from '../../src'
import { openMediaInput } from '../../src/core/input/openMediaInput'
import { diskStorage, fixture, memoryTarget, packets } from '../helpers/media'

test('copies MKV H.264 B frames and AAC with their shared presentation timeline', async () => {
  const source = await fixture('progressive.mkv')
  const video = await packets(source, 'video')
  const audio = await packets(source, 'audio')
  const target = memoryTarget()

  expect(video).toHaveLength(48)
  expect(audio).toHaveLength(62)
  expect(video[2]!.timestamp).toBeLessThan(video[1]!.timestamp)
  expect(audio[0]!.timestamp).toBeCloseTo(0.2 - 1024 / 48_000, 7)

  const result = await remuxMedia(source, {
    storage: await diskStorage(),
    writable: target.writable,
  })
  const output = target.blob()

  expect(result.mimeType).toBe('video/mp4')
  expect(target.state.isClosed).toBe(true)

  for (const [kind, expected] of [
    ['video', video],
    ['audio', audio],
  ] as const) {
    const actual = await packets(output, kind)

    expect(actual.map(packet => packet.data)).toStrictEqual(
      expected.map(packet => packet.data),
    )

    for (const [index, packet] of actual.entries()) {
      expect(packet.timestamp).toBeCloseTo(expected[index]!.timestamp, 4)
      expect(packet.type).toBe(expected[index]!.type)
    }
  }

  const concatenated = memoryTarget()

  await concatMedia([source, output], {
    storage: await diskStorage(),
    writable: concatenated.writable,
  })

  for (const [kind, expected] of [
    ['video', video],
    ['audio', audio],
  ] as const) {
    const actual = await packets(concatenated.blob(), kind)

    expect(actual.map(packet => packet.data)).toStrictEqual(
      [...expected, ...expected].map(packet => packet.data),
    )
    expect(actual[expected.length]!.timestamp).toBeCloseTo(
      expected[0]!.timestamp + result.duration,
      4,
    )
  }
})

/**
 * Encodes a finite EBML element with a two-byte size field for small test payloads.
 */
function element(id: string, ...payload: Uint8Array[]) {
  const data = Buffer.concat(payload)
  const size = Buffer.alloc(2)

  size.writeUInt16BE(0x4000 | data.length)

  return Buffer.concat([Buffer.from(id, 'hex'), size, data])
}

function aacMatroska(
  trackFields: Uint8Array[],
  ...clusters: Uint8Array<ArrayBuffer>[]
) {
  return new Blob([
    element('1a45dfa3', element('4282', Buffer.from('matroska'))),
    // Unknown-size Segment, extending to the end of the file.
    Buffer.from('18538067ff', 'hex'),
    element('1549a966'),
    element(
      '1654ae6b',
      element(
        'ae',
        element('d7', Buffer.of(1)),
        element('83', Buffer.of(2)),
        element('86', Buffer.from('A_AAC')),
        element('63a2', Buffer.of(0x11, 0x88, 0x56, 0xe5, 0x00)),
        ...trackFields,
      ),
    ),
    ...clusters,
  ])
}

test('copies MKV container colour into nclx and rejects incompatible ranges', async () => {
  const input = await fixture('bt709-full-range.mkv')
  const output = memoryTarget()

  await remuxMedia(input, {
    storage: await diskStorage(),
    writable: output.writable,
  })
  const media = await openMediaInput(output.blob())

  try {
    expect(
      media.tracks.find(track => track.kind === 'video')
        ?.containerColorInformation,
    ).toStrictEqual({
      primaries: 1,
      transfer: 1,
      matrix: 1,
      fullRange: true,
    })
  } finally {
    media.dispose()
  }

  const limited = Buffer.from(await input.arrayBuffer())
  const range = limited.indexOf(Buffer.from('55b98102', 'hex'))

  expect(range).toBeGreaterThan(0)
  limited[range + 3] = 1
  const target = memoryTarget()

  await expect(
    concatMedia([input, new Blob([limited])], {
      storage: await diskStorage(),
      writable: target.writable,
    }),
  ).rejects.toMatchObject({ code: 'INCOMPATIBLE_SEGMENTS' })
  expect(target.state.writes).toStrictEqual([])
})

test.each([
  { name: 'Xiph', flags: 0x02 },
  { name: 'fixed', flags: 0x04 },
  { name: 'EBML', flags: 0x06 },
  { name: 'EBML with an eight-byte difference', flags: 0x06, wide: true },
])(
  'splits $name AAC laces in an unknown-size MKV cluster',
  async ({ flags, wide }) => {
    const source = await fixture('progressive.mkv')
    const original = (await packets(source, 'audio'))
      .slice(0, 3)
      .map(packet => packet.data)
    const frames =
      flags === 0x04
        ? Array<Uint8Array>(3).fill(original[0]!)
        : wide
          ? [original[1]!, original[2]!, original[0]!]
          : original
    let sizes = Buffer.alloc(0)

    if (flags === 0x02) {
      sizes = Buffer.from([frames[0]!.length, 255, frames[1]!.length - 255])
    } else if (flags === 0x06) {
      const firstSize = 0x4000 | frames[0]!.length
      const difference = frames[1]!.length - frames[0]!.length

      sizes = Buffer.alloc(wide ? 10 : 4)
      sizes.writeUInt16BE(firstSize)

      if (wide) {
        const marker = 1n << 56n
        const bias = (1n << 55n) - 1n

        sizes.writeBigUInt64BE(marker + bias + BigInt(difference), 2)
      } else {
        sizes.writeUInt16BE(0x4000 | (8191 + difference), 2)
      }
    }

    const cluster = Buffer.concat([
      // Eight-byte unknown size, terminated by the following Cluster ID.
      Buffer.from('1f43b67501ffffffffffffff', 'hex'),
      element('e7', Buffer.of(0)),
      element(
        'a0',
        element('a1', Buffer.of(0x81, 0, 0, flags, 2), sizes, ...frames),
        element('9b', Buffer.of(64)),
      ),
    ])
    const nextCluster = element(
      '1f43b675',
      element('e7', Buffer.of(64)),
      element('a3', Buffer.of(0x81, 0, 0, 0x80), original[0]!),
    )
    const input = aacMatroska([], cluster, nextCluster)
    const target = memoryTarget()

    await remuxMedia(input, {
      tracks: 'audio',
      writable: target.writable,
      storage: await diskStorage(),
    })
    const output = await packets(target.blob(), 'audio')

    expect(output.map(packet => packet.data)).toStrictEqual([
      ...frames,
      original[0]!,
    ])

    for (const [index, packet] of output.entries()) {
      expect(packet.timestamp).toBeCloseTo((index * 1024) / 48_000, 5)
    }
  },
)

test.each([
  { name: 'with only one frame', count: 1, allowLacing: true },
  { name: 'on an unlaced track', count: 2, allowLacing: false },
])(
  'rejects an MKV lace $name before writing output',
  async ({ count, allowLacing }) => {
    const [sample] = await packets(await fixture('progressive.mkv'), 'audio')
    const input = aacMatroska(
      allowLacing ? [] : [element('9c', Buffer.of(0))],
      element(
        '1f43b675',
        element('e7', Buffer.of(0)),
        element(
          'a3',
          Buffer.of(0x81, 0, 0, 0x84, count - 1),
          ...Array<Uint8Array>(count).fill(sample!.data),
        ),
      ),
    )
    const target = memoryTarget()

    await expect(
      remuxMedia(input, {
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/lac/iu),
    })
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  },
)

test('rejects a truncated MKV before writing output', async () => {
  const source = await fixture('progressive.mkv')
  const target = memoryTarget()

  await expect(
    remuxMedia(source.slice(0, -1), {
      storage: await diskStorage(),
      writable: target.writable,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(target.state.writes).toStrictEqual([])
})

test('ignores the unsupported codec of a discarded MKV track', async () => {
  const source = await fixture('progressive.mkv')
  const bytes = Buffer.from(await source.arrayBuffer())
  const offset = bytes.indexOf('A_AAC')

  expect(offset).toBeGreaterThan(0)
  bytes.write('A_AC3', offset, 'ascii')
  const input = new Blob([bytes])
  const unsupported = memoryTarget()

  await expect(
    remuxMedia(input, {
      writable: unsupported.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_CODEC' })
  expect(unsupported.state.writes).toStrictEqual([])

  const target = memoryTarget()

  await remuxMedia(input, {
    tracks: 'video',
    storage: await diskStorage(),
    writable: target.writable,
  })
  expect((await packets(target.blob(), 'video')).length).toBe(48)
  expect(await packets(target.blob(), 'audio')).toStrictEqual([])
})
