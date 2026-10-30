import { getEventListeners } from 'node:events'
import { expect, test } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../src'
import type { RemuxResult } from '../src'
import { diskStorage, fixture, memoryTarget, packets } from './helpers/media'

test.each(['complete', 'unsupported-scheme', 'missing-auxiliary'] as const)(
  'rejects selected encrypted MP4 tracks before touching output: %s',
  async variant => {
    const bytes = Buffer.from(
      await (await fixture('encrypted.mp4')).arrayBuffer(),
    )
    const names = {
      complete: [],
      'unsupported-scheme': ['schm'],
      'missing-auxiliary': ['senc', 'saiz', 'saio'],
    }[variant]
    for (const name of names) {
      let offset = bytes.indexOf(name)
      expect(offset).toBeGreaterThan(0)
      while (offset >= 0) {
        if (name === 'schm') {
          bytes.write('cbc1', offset + 8, 'ascii')
        } else {
          // Keep every box extent valid while hiding per-sample IV metadata.
          bytes.write('free', offset, 'ascii')
        }
        offset = bytes.indexOf(name, offset + 4)
      }
    }
    const encrypted = new Blob([bytes])
    const clear = await fixture('progressive.mp4')

    for (const operation of [
      'remux',
      'audio',
      'video',
      'concat',
      'combine-video',
      'combine-audio',
    ] as const) {
      const target = memoryTarget()
      const controller = new AbortController()
      const options = {
        writable: target.writable,
        storage: await diskStorage(),
        signal: controller.signal,
      }
      let job: Promise<RemuxResult>
      if (operation === 'concat') {
        job = concatMedia([clear, encrypted], options)
      } else if (operation === 'combine-video') {
        job = combineTracks(encrypted, clear, options)
      } else if (operation === 'combine-audio') {
        job = combineTracks(clear, encrypted, options)
      } else {
        job = remuxMedia(encrypted, {
          ...options,
          tracks: operation === 'remux' ? 'all' : operation,
        })
      }
      await expect(job).rejects.toThrow('Encrypted MP4 tracks are unsupported')
      expect(target.state.writes).toStrictEqual([])
      expect(target.state.isClosed).toBe(false)
      expect(target.state.isAborted).toBe(false)
      expect(target.writable.locked).toBe(false)
      expect(getEventListeners(controller.signal, 'abort')).toStrictEqual([])
    }
  },
)

test.each(['video', 'audio'] as const)(
  'ignores a protected %s sample entry when extracting the other clear track',
  async protectedKind => {
    const original = await fixture('progressive.mp4')
    const bytes = Buffer.from(await original.arrayBuffer())
    const codec = protectedKind === 'video' ? 'avc1' : 'mp4a'
    let offset = bytes.indexOf('stsd')
    while (
      offset >= 0 &&
      bytes.toString('ascii', offset + 16, offset + 20) !== codec
    ) {
      offset = bytes.indexOf('stsd', offset + 4)
    }
    expect(offset).toBeGreaterThan(0)
    // The unselected entry is deliberately incomplete; the clear track's
    // metadata and payload are unchanged and must remain extractable.
    bytes.write(
      protectedKind === 'video' ? 'encv' : 'enca',
      offset + 16,
      'ascii',
    )
    const selectedKind = protectedKind === 'video' ? 'audio' : 'video'
    const source = await packets(original, selectedKind)
    const target = memoryTarget()
    await remuxMedia(new Blob([bytes]), {
      tracks: selectedKind,
      writable: target.writable,
      storage: await diskStorage(),
    })
    expect(
      (await packets(target.blob(), selectedKind)).map(packet => packet.data),
    ).toStrictEqual(source.map(packet => packet.data))
    expect(target.state.isClosed).toBe(true)
    expect(target.writable.locked).toBe(false)
  },
)
