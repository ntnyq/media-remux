import { expect, test } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../src'
import type { RemuxResult } from '../src'
import { Input } from '../src/vendor/mediabunny/src/input'
import { MP4 } from '../src/vendor/mediabunny/src/input-format'
import { IsobmffDemuxer } from '../src/vendor/mediabunny/src/isobmff/isobmff-demuxer'
import { CustomSource } from './helpers/CustomSource'
import { diskStorage, fixture, memoryTarget } from './helpers/media'
import { fragmentedMp4 } from './helpers/mp4Fragments'

test('rejects a partial child box header at the end of a moof', async () => {
  const fragmented = await fragmentedMp4({ fragments: 3, indexed: false })
  const bytes = Buffer.from(await fragmented.blob().arrayBuffer())
  const moof = fragmented.fragmentOffset(1, 2)
  const size = bytes.readUInt32BE(moof)
  const end = moof + size
  const trun = bytes.indexOf('trun', moof)
  const target = memoryTarget()

  bytes.writeUInt32BE(size + 4, moof)
  bytes.writeInt32BE(bytes.readInt32BE(trun + 12) + 4, trun + 12)
  const malformed = new Blob([
    bytes.subarray(0, end),
    Uint8Array.of(0, 0, 0, 8),
    bytes.subarray(end),
  ])

  await expect(
    remuxMedia(malformed, {
      writable: target.writable,
      storage: await diskStorage(),
    }),
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: 'Truncated nested MP4 box header.',
  })
  expect(target.state.writes).toHaveLength(0)
})

test.each([0, 2])(
  'rejects an invalid MP4 fragment description index %s before writing output',
  async index => {
    const fragmented = await fragmentedMp4({ fragments: 3 })
    const bytes = Buffer.from(await fragmented.blob().arrayBuffer())
    const trex = bytes.indexOf('trex')
    const target = memoryTarget()

    expect(bytes.readUInt32BE(trex + 12)).toBe(1)
    bytes.writeUInt32BE(index, trex + 12)

    await expect(
      remuxMedia(new Blob([bytes]), {
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('fragment sample description'),
    })
    expect(target.state.writes).toHaveLength(0)
  },
)

test.each([true, false])(
  'rejects repeated track fragments in a later moof before writing output (tfdt: %s)',
  async tfdt => {
    const fragmented = await fragmentedMp4({
      fragments: 3,
      indexed: false,
      tfdt,
    })
    const original = fragmented.blob()
    const bytes = Buffer.from(await original.arrayBuffer())
    const moofStart = fragmented.fragmentOffset(1, 2)
    const moofEnd = moofStart + bytes.readUInt32BE(moofStart)
    const trafStart = bytes.indexOf('traf', moofStart) - 4

    expect(trafStart).toBeGreaterThan(moofStart)
    const traf = Buffer.from(bytes.subarray(trafStart, moofEnd))

    expect(traf.readUInt32BE(0)).toBe(traf.length)

    // Both runs reference the same three payloads, replayed on a later timeline.
    // Growing the moof shifts mdat, so update both relative data offsets.
    const trun = traf.indexOf('trun')

    expect(trun).toBeGreaterThan(0)
    traf.writeInt32BE(traf.readInt32BE(trun + 12) + traf.length, trun + 12)
    const duplicate = Buffer.from(traf)

    expect(duplicate.includes('tfdt')).toBe(tfdt)

    if (tfdt) {
      const offset = duplicate.indexOf('tfdt')

      duplicate.writeBigUInt64BE(
        duplicate.readBigUInt64BE(offset + 8) + 3072n,
        offset + 8,
      )
    }

    const moof = Buffer.concat([
      bytes.subarray(moofStart, trafStart),
      traf,
      duplicate,
    ])

    moof.writeUInt32BE(moof.length)
    const input = new Blob([
      bytes.subarray(0, moofStart),
      moof,
      bytes.subarray(moofEnd),
    ])
    const video = await fixture('video.mp4')

    for (const operation of ['remux', 'concat', 'combine'] as const) {
      const target = memoryTarget()
      const options = {
        writable: target.writable,
        storage: await diskStorage(),
      }
      let job: Promise<RemuxResult>

      if (operation === 'combine') {
        job = combineTracks(video, input, options)
      } else if (operation === 'concat') {
        job = concatMedia([original, input], options)
      } else {
        job = remuxMedia(input, options)
      }

      await expect(job).rejects.toThrow(/multiple traf boxes/u)
      expect(target.state.writes).toStrictEqual([])
      expect(target.state.isClosed).toBe(false)
      expect(target.state.isAborted).toBe(false)
      expect(target.writable.locked).toBe(false)
    }
  },
)

test('retries hybrid decode-time recovery after a sample-table read fails', async () => {
  const bytes = Buffer.from(await (await fixture('hybrid.mp4')).arrayBuffer())
  const moof = bytes.indexOf('moof') - 4
  const tfdt = bytes.indexOf('tfdt', moof)
  const mfra = bytes.lastIndexOf('mfra')
  const stts = bytes.indexOf('stts')

  expect(moof).toBeGreaterThan(0)
  expect(tfdt).toBeGreaterThan(moof)
  expect(mfra).toBeGreaterThan(tfdt)
  expect(stts).toBeGreaterThan(0)
  expect(bytes[tfdt + 4]).toBe(1)
  const decodeTime = Number(bytes.readBigUInt64BE(tfdt + 8))

  bytes.write('free', tfdt, 'ascii')
  bytes.write('free', mfra, 'ascii')

  const firstTimingRow = stts + 12
  const failure = new Error('sample timing could not be read')
  let shouldFail = true
  const input = new Input({
    formats: [MP4],
    source: new CustomSource({
      getSize: () => bytes.length,
      read(start, end) {
        if (start === firstTimingRow && shouldFail) {
          shouldFail = false

          throw failure
        }

        return bytes.subarray(start, end)
      },
    }),
  })

  try {
    // eslint-disable-next-line no-underscore-dangle -- Exercise a fragment read before the normal sample table is initialized.
    const demuxer = await input._getDemuxer()

    if (!(demuxer instanceof IsobmffDemuxer)) {
      throw new TypeError('Expected an MP4 demuxer')
    }

    await demuxer.readMetadata()
    await expect(demuxer.readFragment(moof)).rejects.toBe(failure)

    const fragment = await demuxer.readFragment(moof)

    expect(fragment?.trackData.get(1)?.samples.timestampOffset).toBe(decodeTime)
  } finally {
    input.dispose()
  }
})
