import { getEventListeners } from 'node:events'
import { expect, test } from 'vitest'
import { combineTracks } from '../../src'
import { openMediaInput } from '../../src/core/input/mediaInput'
import { inspectTracks } from '../../src/core/mediaTracks'
import { diskStorage, fixture, memoryTarget } from '../helpers/media'
import { fragmentedMp4 } from '../helpers/mp4Fragments'

test.each([
  { name: 'video.mp4', length: 4 },
  { name: 'continuous-av.mpegts', length: 377 },
  { name: 'progressive.flv', length: 9 },
])('cancels a pending $name Blob range read', async ({ name, length }) => {
  const controller = new AbortController()
  const reason = new Error('cancel pending Blob range')
  const started = Promise.withResolvers<void>()
  const range = Promise.withResolvers<ArrayBuffer>()

  class PendingRangeBlob extends Blob {
    public override slice(start = 0, end?: number, type?: string) {
      const part = super.slice(start, end, type)

      if (part.size === length) {
        part.arrayBuffer = () => {
          started.resolve()

          return range.promise
        }
      }

      return part
    }
  }

  const input = openMediaInput(
    new PendingRangeBlob([await fixture(name)]),
    controller.signal,
  )
  const outcome = input.catch((error: unknown) => error)

  try {
    await started.promise
    controller.abort(reason)
    const nextTurn = new Promise(resolve => setImmediate(resolve))

    expect(await Promise.race([outcome, nextTurn])).toBe(reason)
  } finally {
    range.reject(new Error('underlying range read failed'))
    await outcome
  }
})

test.each(['video.mp4', 'progressive.mkv', 'continuous-av.mpegts'])(
  'releases the active $0 Blob stream on abort',
  async name => {
    const controller = new AbortController()
    const reason = new Error('cancel pending Blob stream')
    const started = Promise.withResolvers<void>()
    let streamController: ReadableStreamDefaultController<Uint8Array>
    let canceled = false

    class PendingStreamBlob extends Blob {
      public override slice(start = 0, end?: number, type?: string) {
        const part = super.slice(start, end, type)

        part.stream = () =>
          new ReadableStream({
            pull(output) {
              streamController = output
              started.resolve()

              return new Promise(() => {})
            },
            cancel() {
              canceled = true
            },
          })

        return part
      }
    }

    const input = openMediaInput(
      new PendingStreamBlob([await fixture(name)]),
      controller.signal,
    )
    const outcome = input.catch((error: unknown) => error)

    try {
      await started.promise
      controller.abort(reason)
      expect(canceled).toBe(true)
      expect(await outcome).toBe(reason)
    } finally {
      if (!canceled) {
        streamController!.close()
      }

      await outcome
    }
  },
)

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

test.each(['empty', 'malformed'] as const)(
  'releases the video input when opening %s audio fails',
  async kind => {
    const audio = kind === 'empty' ? new Blob() : new Blob(['invalid media'])
    const controller = new AbortController()
    const target = memoryTarget()

    await expect(
      combineTracks(await fixture('video.mp4'), audio, {
        signal: controller.signal,
        writable: target.writable,
        storage: await diskStorage(),
      }),
    ).rejects.toThrow(
      kind === 'empty' ? 'nonempty Blob' : 'unsupported or unrecognizable',
    )
    const listeners = getEventListeners(controller.signal, 'abort')

    controller.abort()
    expect(listeners).toStrictEqual([])
    expect(target.state.writes).toStrictEqual([])
    expect(target.writable.locked).toBe(false)
  },
)
