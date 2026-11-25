import { afterEach, expect, test, vi } from 'vitest'
import { remuxMedia } from '../src'
import { encodeAac } from '../src/core/audioCodecs'
import { diskStorage, fixture, memoryTarget } from './helpers/media'

afterEach(() => vi.unstubAllGlobals())

test.each(['AudioDecoder', 'AudioEncoder'])(
  'cancels remux while waiting for %s capability detection',
  async name => {
    const controller = new AbortController()
    const reason = new Error('cancelled during capability detection')
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<{ supported: boolean }>()
    const target = memoryTarget()

    vi.stubGlobal('AudioData', {})
    vi.stubGlobal('EncodedAudioChunk', {})
    vi.stubGlobal('AudioDecoder', {
      isConfigSupported: () => ({ supported: true }),
    })
    vi.stubGlobal(name, {
      isConfigSupported() {
        started.resolve()

        return pending.promise
      },
    })

    const result = remuxMedia(await fixture('audio.m4a'), {
      normalizeAudio: true,
      writable: target.writable,
      storage: await diskStorage(),
      signal: controller.signal,
    })

    await started.promise
    controller.abort(reason)
    await expect(result).rejects.toBe(reason)
    pending.reject(new Error('capability detection failed after cancellation'))
    expect(target.state.writes).toEqual([])
    expect(target.writable.locked).toBe(false)
  },
  1000,
)

test('preserves the abort reason while a codec flush is pending', async () => {
  const controller = new AbortController()
  const reason = new Error('cancelled during flush')
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<void>()
  const close = vi.fn<() => void>()

  vi.stubGlobal(
    'AudioEncoder',
    class {
      state = 'configured'
      configure() {}
      close = close
      flush() {
        started.resolve()

        return pending.promise
      }
    },
  )

  async function* inputs() {
    yield* []
  }

  const result = encodeAac(inputs(), controller.signal).next()

  await started.promise
  controller.abort(reason)
  await expect(result).rejects.toBe(reason)
  pending.reject(new Error('flush failed after cancellation'))
  expect(close).toHaveBeenCalledOnce()
})

test('does not start flushing if cancellation arrives as the input ends', async () => {
  const controller = new AbortController()
  const reason = new Error('cancelled before flush')
  const flush = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

  vi.stubGlobal(
    'AudioEncoder',
    class {
      state = 'configured'
      configure() {}
      close() {}
      flush = flush
    },
  )

  async function* inputs() {
    controller.abort(reason)
    yield* []
  }

  await expect(encodeAac(inputs(), controller.signal).next()).rejects.toBe(
    reason,
  )
  expect(flush).not.toHaveBeenCalled()
})

test('closes the encoder when configuration fails', async () => {
  const failure = new Error('AAC configuration failed')
  const close = vi.fn<() => void>()

  vi.stubGlobal(
    'AudioEncoder',
    class {
      state = 'unconfigured'
      close = close
      configure() {
        throw failure
      }
    },
  )

  async function* inputs() {
    yield* []
  }

  await expect(encodeAac(inputs()).next()).rejects.toBe(failure)
  expect(close).toHaveBeenCalledOnce()
})

test('releases an input that arrives after cancellation without submitting it', async () => {
  const controller = new AbortController()
  const reason = new Error('cancelled')
  const closeCodec = vi.fn<() => void>()
  const closeInput = vi.fn<() => void>()
  const encode = vi.fn<(input: AudioData) => void>()

  vi.stubGlobal(
    'AudioEncoder',
    class {
      state = 'configured'
      configure = vi.fn<(config: AudioEncoderConfig) => void>()
      close = closeCodec
      encode = encode
    },
  )

  async function* inputs() {
    controller.abort(reason)
    yield { close: closeInput } as unknown as AudioData
  }

  await expect(encodeAac(inputs(), controller.signal).next()).rejects.toBe(
    reason,
  )
  expect(encode).not.toHaveBeenCalled()
  expect(closeCodec).toHaveBeenCalledOnce()
  expect(closeInput).toHaveBeenCalledOnce()
})
