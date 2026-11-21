import { setImmediate } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../src'
import { EncodedAudioPacketSource } from '../src/vendor/mediabunny/src/media-source'
import { Output } from '../src/vendor/mediabunny/src/output'
import { Mp4OutputFormat } from '../src/vendor/mediabunny/src/output-format'
import { StreamTarget } from '../src/vendor/mediabunny/src/target'
import { temporaryFragmentSamples } from './helpers/fragmentSamples'
import { diskStorage, fixture, memoryTarget, packets } from './helpers/media'
import { indexedMp4 } from './helpers/mp4Index'

test('releases the output stream when the muxer fails to start', async () => {
  const target = memoryTarget()
  const failure = new Error('could not emit ftyp')
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      onFtyp() {
        throw failure
      },
    }),
    target: new StreamTarget(target.writable),
  })

  output.addAudioTrack(new EncodedAudioPacketSource('aac'))

  await expect(output.start()).rejects.toBe(failure)
  expect(output.state).toBe('canceled')
  expect(target.state.isAborted).toBe(true)
  expect(target.writable.locked).toBe(false)
})

test.each([1, 16])(
  'closes a zero-buffer output after writing %i compatible segments',
  async count => {
    const input = await fixture('fractional-av.mp4')
    const target = memoryTarget({ highWaterMark: 0 })

    await concatMedia(
      Array.from({ length: count }, () => input),
      {
        writable: target.writable,
        storage: await diskStorage(),
      },
    )

    const source = await packets(input, 'video')
    const output = await packets(target.blob(), 'video')

    expect(output.map(packet => packet.data)).toStrictEqual(
      Array.from({ length: count }, () =>
        source.map(packet => packet.data),
      ).flat(),
    )
    expect(target.state.writes.length).toBeGreaterThanOrEqual(
      count === 1 ? 1 : 2,
    )
    expect(target.state.isClosed).toBe(true)
    expect(target.writable.locked).toBe(false)
  },
)

test('propagates a null sink rejection and unlocks the stream', async () => {
  const writable = new WritableStream({
    async write() {
      throw null
    },
  })

  await expect(
    remuxMedia(await fixture('video.mp4'), {
      writable,
      storage: await diskStorage(),
    }),
  ).rejects.toBeNull()
  expect(writable.locked).toBe(false)
})

test('a final progress failure leaves no background access after sample storage disposal', async () => {
  const samples = await temporaryFragmentSamples()
  const storage = await diskStorage()
  const target = memoryTarget()
  const failure = new Error('final progress failed')
  let isDisposed = false
  let readsAfterDisposal = 0
  const { get } = samples.store
  const read = vi.spyOn(samples.store, 'get').mockImplementation((...args) => {
    if (isDisposed) {
      readsAfterDisposal++
    }

    return get(...args)
  })

  try {
    await expect(
      remuxMedia(await fixture('video.mp4'), {
        writable: target.writable,
        storage: { ...storage, fragmentSamples: samples.store },
        onProgress(progress) {
          if (progress.phase === 'finalize') {
            throw failure
          }
        },
      }),
    ).rejects.toBe(failure)
    isDisposed = true
    await samples.dispose()
    // Give detached promise continuations a turn to reveal post-cleanup reads.
    await setImmediate()
    expect(readsAfterDisposal).toBe(0)
    expect(target.state.isAborted).toBe(true)
    expect(target.state.isClosed).toBe(false)
    expect(target.writable.locked).toBe(false)
  } finally {
    await samples.dispose()
    read.mockRestore()
  }
})

test.each([
  { phase: 'write', fails: false, highWaterMark: 4 },
  { phase: 'write', fails: false, highWaterMark: 0 },
  { phase: 'close', fails: false, highWaterMark: 4 },
  { phase: 'close', fails: true, highWaterMark: 4 },
] as const)(
  'settles cancellation during $phase with highWaterMark $highWaterMark (close fails: $fails)',
  async ({ phase, fails, highWaterMark }) => {
    const controller = new AbortController()
    const reason = new Error('cancel output')
    const closeFailure = new Error('output did not commit')
    const state = { closed: false, aborted: false }
    const writable = new WritableStream(
      {
        async write() {
          if (phase === 'write') {
            await setImmediate()
            controller.abort(reason)
          }
        },
        async close() {
          if (phase === 'close') {
            await setImmediate()
            controller.abort(reason)
          }

          if (fails) {
            throw closeFailure
          }

          state.closed = true
        },
        abort() {
          state.aborted = true
        },
      },
      { highWaterMark },
    )
    const result = remuxMedia(await fixture('vfr-bframes.mp4'), {
      writable,
      storage: await diskStorage(),
      signal: controller.signal,
    })
    const outcome = await result
      .then(({ mimeType }) => mimeType)
      .catch((error: unknown) => error)
    const expected = phase === 'write' ? reason : 'video/mp4'

    expect(outcome).toBe(fails ? closeFailure : expected)
    expect(state).toStrictEqual({
      closed: phase === 'close' && !fails,
      aborted: phase === 'write',
    })
    expect(writable.locked).toBe(false)
  },
)

test('emits audio fragments as the final track continues after video ends', async () => {
  const video = await fixture('bt709-full-range.flv')
  const sampleCount = 640
  const audio = (await indexedMp4({ samples: sampleCount })).blob()
  const storage = await diskStorage()
  const { append, release } = storage.fragmentSamples
  let audioAppended = 0
  let audioReleased = 0
  let peakQueued = 0
  const appendProbe = vi
    .spyOn(storage.fragmentSamples, 'append')
    .mockImplementation(async (...args) => {
      const id = await append(...args)

      if (args[0] === 2) {
        audioAppended++
        peakQueued = Math.max(peakQueued, audioAppended - audioReleased)
      }

      return id
    })
  const releaseProbe = vi
    .spyOn(storage.fragmentSamples, 'release')
    .mockImplementation(async (...args) => {
      await release(...args)

      if (args[0] === 2) {
        ;[, audioReleased] = args
      }
    })

  try {
    const target = memoryTarget()

    await combineTracks(video, audio, { storage, writable: target.writable })
    expect(audioReleased).toBe(sampleCount)
    expect(peakQueued).toBeLessThan(128)
    await expect(packets(target.blob(), 'audio')).resolves.toHaveLength(
      sampleCount,
    )
  } finally {
    appendProbe.mockRestore()
    releaseProbe.mockRestore()
  }
})

test.each([
  { operation: 'cancel', hasFailure: false },
  { operation: 'cancel', hasFailure: true },
  { operation: 'finalize', hasFailure: false },
  { operation: 'finalize', hasFailure: true },
] as const)(
  '$operation waits for every in-flight track close, including failures: $hasFailure',
  async ({ operation, hasFailure }) => {
    const target = memoryTarget()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
      target: new StreamTarget(target.writable),
    })
    const sources = [
      new EncodedAudioPacketSource('aac'),
      new EncodedAudioPacketSource('aac'),
    ]

    for (const source of sources) {
      output.addAudioTrack(source, {
        decoderConfig: {
          codec: 'mp4a.40.2',
          sampleRate: 48_000,
          numberOfChannels: 1,
          description: Uint8Array.of(17, 136),
        },
      })
    }

    await output.start()
    const first = Promise.withResolvers<boolean>()
    const second = Promise.withResolvers<boolean>()
    const entered = Promise.withResolvers<boolean>()
    const failure = new Error('track close failed')
    let started = 0
    const close = vi
      // eslint-disable-next-line no-underscore-dangle -- Hold the internal track cleanup in flight.
      .spyOn(output._muxer, 'onTrackClose')
      .mockImplementation(async track => {
        if (++started === sources.length) {
          entered.resolve(true)
        }

        if (track.id === 1) {
          await first.promise

          if (hasFailure) {
            throw failure
          }
        } else {
          await second.promise
        }
      })

    for (const source of sources) {
      source.close()
    }

    await entered.promise
    let isSettled = false
    const lifecycle = (async () => {
      try {
        await output[operation]()

        return { error: undefined }
      } catch (error) {
        return { error }
      } finally {
        isSettled = true
      }
    })()

    try {
      first.resolve(true)
      await setImmediate()
      expect(isSettled).toBe(false)
      expect(target.writable.locked).toBe(true)
      second.resolve(true)
      const result = await lifecycle

      expect(result.error).toBe(hasFailure ? failure : undefined)
      expect(target.writable.locked).toBe(false)
      expect(target.state.isAborted).toBe(operation === 'cancel' || hasFailure)
      expect(target.state.isClosed).toBe(
        operation === 'finalize' && !hasFailure,
      )
    } finally {
      first.resolve(true)
      second.resolve(true)
      await lifecycle
      close.mockRestore()
    }
  },
)
