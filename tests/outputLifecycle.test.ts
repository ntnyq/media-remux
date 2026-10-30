import { setImmediate } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import { remuxMedia } from '../src'
import { EncodedAudioPacketSource } from '../src/vendor/mediabunny/src/media-source'
import { Output } from '../src/vendor/mediabunny/src/output'
import { Mp4OutputFormat } from '../src/vendor/mediabunny/src/output-format'
import { StreamTarget } from '../src/vendor/mediabunny/src/target'
import { temporaryFragmentSamples } from './helpers/fragmentSamples'
import { diskStorage, fixture, memoryTarget } from './helpers/media'

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
