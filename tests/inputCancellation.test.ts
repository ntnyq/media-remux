import { expect, test } from 'vitest'
import { openMediaInput } from '../src/core/input/mediaInput'
import { inspectTracks } from '../src/core/mediaTracks'
import { fixture } from './helpers/media'
import { fragmentedMp4 } from './helpers/mp4Fragments'

test.each([false, true])(
  'keeps the abort reason before the first MP4 read (metadataOnly=%s)',
  async metadataOnly => {
    const controller = new AbortController()
    const reason = new Error('cancel before reading packets')
    const input = await openMediaInput(
      await fixture('video.mp4'),
      controller.signal,
    )
    try {
      controller.abort(reason)
      await expect(input.tracks[0]!.packets(metadataOnly).next()).rejects.toBe(
        reason,
      )
      await expect(inspectTracks(input.tracks, controller.signal)).rejects.toBe(
        reason,
      )
    } finally {
      input.dispose()
    }
  },
)

test('keeps the abort reason when disposal interrupts an awaited metadata read', async () => {
  const controller = new AbortController()
  const reason = new Error('cancel pending metadata read')
  const source = await fragmentedMp4({ fragments: 2, indexed: false })
  const paddingHeader = Buffer.alloc(8)
  paddingHeader.writeUInt32BE(8 * 1024 * 1024)
  paddingHeader.write('free', 4)
  const padding = new Blob([paddingHeader, new Uint8Array(8 * 1024 * 1024 - 8)])
  const fragments = source.segmentBlob()
  let isArmed = false
  let interrupted = false
  class CancellableBlob extends Blob {
    public override slice(start = 0, end?: number, type?: string) {
      const part = super.slice(start, end, type)
      let offset = 0
      part.stream = () =>
        new ReadableStream({
          async pull(output) {
            if (isArmed) {
              interrupted = true
              controller.abort(reason)
              output.error(new Error('underlying read interrupted'))
              return
            }
            if (offset >= part.size) {
              output.close()
              return
            }
            const bytes = await Blob.prototype.slice
              .call(part, offset, offset + 4096)
              .arrayBuffer()
            offset += bytes.byteLength
            output.enqueue(new Uint8Array(bytes))
          },
        })
      return part
    }
  }
  const input = await openMediaInput(
    new CancellableBlob([
      source.initBlob(),
      fragments.slice(0, source.stride),
      padding,
      fragments.slice(source.stride),
      padding,
    ]),
    controller.signal,
  )
  try {
    isArmed = true
    await expect(inspectTracks(input.tracks, controller.signal)).rejects.toBe(
      reason,
    )
    expect(interrupted).toBe(true)
  } finally {
    input.dispose()
  }
})

test('does not replace disposal failures when the signal was not aborted', async () => {
  const input = await openMediaInput(
    await fixture('video.mp4'),
    new AbortController().signal,
  )
  input.dispose()
  await expect(input.tracks[0]!.packets(true).next()).rejects.toMatchObject({
    name: 'InputDisposedError',
  })
})

test.each([false, true])(
  'keeps the abort reason between MP4 packets (metadataOnly=%s)',
  async metadataOnly => {
    const controller = new AbortController()
    const reason = new DOMException('cancel between packets', 'AbortError')
    const input = await openMediaInput(
      await fixture('video.mp4'),
      controller.signal,
    )
    const iterator = input.tracks[0]!.packets(metadataOnly)
    try {
      expect((await iterator.next()).done).toBe(false)
      controller.abort(reason)
      await expect(iterator.next()).rejects.toBe(reason)
    } finally {
      await iterator.return()
      input.dispose()
    }
  },
)
