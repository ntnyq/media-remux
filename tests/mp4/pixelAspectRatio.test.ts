import { expect, test } from 'vitest'
import { concatMedia, remuxMedia } from '../../src'
import { diskStorage, fixture, memoryTarget, packets } from '../helpers/media'

test('preserves a 32-bit pixel aspect ratio with large coprime coded dimensions', async () => {
  const original = await fixture('video.mp4')
  const bytes = Buffer.from(await original.arrayBuffer())
  const sampleEntry = bytes.indexOf('avc1', bytes.indexOf('stsd'))
  const pasp = bytes.indexOf('pasp', sampleEntry)
  const target = memoryTarget()
  const numerator = 4_294_967_291
  const denominator = 4_294_967_279

  expect(sampleEntry).toBeGreaterThan(0)
  expect(pasp).toBeGreaterThan(sampleEntry)
  bytes.writeUInt16BE(4095, sampleEntry + 28)
  bytes.writeUInt16BE(2047, sampleEntry + 30)
  bytes.writeUInt32BE(numerator, pasp + 4)
  bytes.writeUInt32BE(denominator, pasp + 8)

  await remuxMedia(new Blob([bytes]), {
    writable: target.writable,
    storage: await diskStorage(),
  })
  await expect(readPixelAspectRatio(target.blob())).resolves.toStrictEqual([
    numerator,
    denominator,
  ])
})

/**
 * Reads the exact pixel aspect ratio signaled by an MP4 pasp box.
 *
 * @param blob - Generated MP4 to inspect independently of the input parser.
 * @returns The integer numerator and denominator from the container.
 */
async function readPixelAspectRatio(blob: Blob): Promise<[number, number]> {
  const bytes = Buffer.from(await blob.arrayBuffer())
  const offset = bytes.indexOf('pasp')

  expect(offset).toBeGreaterThan(0)

  return [bytes.readUInt32BE(offset + 4), bytes.readUInt32BE(offset + 8)]
}

test.each([
  { name: 'sar-4-3.flv', numerator: 4, denominator: 3 },
  { name: 'sar-2-3.flv', numerator: 2, denominator: 3 },
])(
  'preserves exact $numerator/$denominator SAR through repeated remux and mixed-container concatenation',
  async ({ name, numerator, denominator }) => {
    const flv = await fixture(name)
    const source = await packets(flv, 'video')
    let input = flv

    for (let round = 0; round < 3; round++) {
      const target = memoryTarget()

      await remuxMedia(input, {
        writable: target.writable,
        storage: await diskStorage(),
      })
      input = target.blob()
      await expect(readPixelAspectRatio(input)).resolves.toStrictEqual([
        numerator,
        denominator,
      ])
      expect(
        (await packets(input, 'video')).map(packet => packet.data),
      ).toStrictEqual(source.map(packet => packet.data))
    }

    // Exercise the MP4 SPS fallback separately from the explicit pasp reader.
    const withoutPasp = Buffer.from(await input.arrayBuffer())
    const offset = withoutPasp.indexOf('pasp')

    expect(offset).toBeGreaterThan(0)
    withoutPasp.write('free', offset, 'ascii')
    const spsOnly = memoryTarget()

    await remuxMedia(new Blob([withoutPasp]), {
      writable: spsOnly.writable,
      storage: await diskStorage(),
    })
    await expect(readPixelAspectRatio(spsOnly.blob())).resolves.toStrictEqual([
      numerator,
      denominator,
    ])

    for (const inputs of [
      [flv, input],
      [input, flv],
    ]) {
      const concatenated = memoryTarget()

      await concatMedia(inputs, {
        writable: concatenated.writable,
        storage: await diskStorage(),
      })
      await expect(
        readPixelAspectRatio(concatenated.blob()),
      ).resolves.toStrictEqual([numerator, denominator])
      expect(
        (await packets(concatenated.blob(), 'video')).map(
          packet => packet.data,
        ),
      ).toStrictEqual([...source, ...source].map(packet => packet.data))
    }
  },
)

test.each(['after-avcC', 'before-avcC'] as const)(
  'keeps an explicit pasp override exact when it appears %s',
  async order => {
    const target = memoryTarget()

    await remuxMedia(await fixture('sar-4-3.flv'), {
      writable: target.writable,
      storage: await diskStorage(),
    })
    let bytes = Buffer.from(await target.blob().arrayBuffer())
    const pasp = bytes.indexOf('pasp') - 4

    expect(pasp).toBeGreaterThan(0)
    bytes.writeUInt32BE(7, pasp + 8)
    bytes.writeUInt32BE(5, pasp + 12)
    const avcC = bytes.indexOf('avcC') - 4

    expect(avcC).toBeGreaterThan(0)
    expect(avcC).toBeLessThan(pasp)

    if (order === 'before-avcC') {
      const end = pasp + bytes.readUInt32BE(pasp)

      bytes = Buffer.concat([
        bytes.subarray(0, avcC),
        bytes.subarray(pasp, end),
        bytes.subarray(avcC, pasp),
        bytes.subarray(end),
      ])
    }

    const remuxed = memoryTarget()

    await remuxMedia(new Blob([bytes]), {
      writable: remuxed.writable,
      storage: await diskStorage(),
    })
    await expect(readPixelAspectRatio(remuxed.blob())).resolves.toStrictEqual([
      7, 5,
    ])
  },
)
