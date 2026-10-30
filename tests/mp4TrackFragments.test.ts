import { expect, test } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../src'
import type { RemuxResult } from '../src'
import { diskStorage, fixture, memoryTarget } from './helpers/media'
import { fragmentedMp4 } from './helpers/mp4Fragments'

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
