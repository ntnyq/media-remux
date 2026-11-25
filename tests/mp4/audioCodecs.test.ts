import assert from 'node:assert/strict'
import { expect, test } from 'vitest'
import { remuxMedia } from '../../src'
import { openMediaInput } from '../../src/core/input/mediaInput'
import { diskStorage, fixture, memoryTarget, packets } from '../helpers/media'
import { boxPayloads } from '../helpers/mp4Boxes'

test('copies AC-3 and H.264 packets with their configuration and shared timing', async () => {
  const source = await fixture('progressive-ac3.mp4')
  const target = memoryTarget()

  await remuxMedia(source, {
    storage: await diskStorage(),
    writable: target.writable,
  })

  const output = target.blob()
  const bytes = Buffer.from(await output.arrayBuffer())

  for (const offset of [bytes.indexOf('mdhd'), bytes.lastIndexOf('mdhd')]) {
    expect(offset).toBeGreaterThan(0)
    const duration =
      bytes[offset + 4] === 1
        ? bytes.readBigUInt64BE(offset + 28)
        : BigInt(bytes.readUInt32BE(offset + 20))

    expect(duration).toBe(0n)
  }

  const input = await openMediaInput(output)

  try {
    expect(input.tracks.find(track => track.kind === 'audio')).toMatchObject({
      codec: 'ac3',
      config: {
        codec: 'ac-3',
        sampleRate: 48_000,
        numberOfChannels: 6,
        description: Uint8Array.of(0x10, 0x3d, 0xc0),
      },
    })
  } finally {
    input.dispose()
  }

  for (const kind of ['video', 'audio'] as const) {
    const expected = await packets(source, kind)
    const actual = await packets(output, kind)

    expect(actual.map(packet => packet.data)).toStrictEqual(
      expected.map(packet => packet.data),
    )
    expect(actual[0]!.timestamp).toBeCloseTo(
      kind === 'audio' ? 9344 / 48_000 : 0,
      5,
    )

    for (const [index, packet] of actual.entries()) {
      expect(packet.timestamp).toBeCloseTo(expected[index]!.timestamp, 5)
      expect(packet.duration).toBeCloseTo(expected[index]!.duration, 5)
    }
  }
})

test.each(['missing', 'invalid'] as const)(
  'rejects a selected AC-3 track with %s dac3 before writing',
  async mutation => {
    const blob = await fixture('progressive-ac3.mp4')
    const bytes = Buffer.from(await blob.arrayBuffer())
    const dac3 = bytes.indexOf('dac3')

    expect(dac3).toBeGreaterThan(0)

    if (mutation === 'missing') {
      bytes.write('free', dac3, 'ascii')
    } else {
      // fscod = 3 is reserved.
      bytes[dac3 + 4] = bytes[dac3 + 4]! | 0xc0
    }

    const input = new Blob([bytes])
    const target = memoryTarget()

    await expect(
      remuxMedia(input, {
        storage: await diskStorage(),
        writable: target.writable,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('dac3'),
    })
    expect(target.state.writes).toStrictEqual([])

    const videoOnly = memoryTarget()

    await remuxMedia(input, {
      tracks: 'video',
      storage: await diskStorage(),
      writable: videoOnly.writable,
    })
    expect(videoOnly.state.isClosed).toBe(true)
  },
)

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
