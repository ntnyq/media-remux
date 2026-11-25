import assert from 'node:assert/strict'
import { afterEach, expect, test, vi } from 'vitest'
import { combineTracks, concatMedia, remuxMedia } from '../../src'
import { encodeAac } from '../../src/core/audioCodecs'
import { diskStorage, fixture, memoryTarget, packets } from '../helpers/media'
import { boxPayloads } from '../helpers/mp4Boxes'

afterEach(() => vi.unstubAllGlobals())

test('combines without an encoder when trimming removes all audio', async () => {
  vi.stubGlobal('AudioEncoder', undefined)
  const target = memoryTarget()

  await combineTracks(
    await fixture('leading-delta.mp4'),
    await fixture('audio-edited-head.m4a'),
    {
      normalizeAudio: true,
      timeline: { audioOffset: -2 },
      writable: target.writable,
      storage: await diskStorage(),
    },
  )

  expect(await packets(target.blob(), 'video')).not.toHaveLength(0)
  expect(await packets(target.blob(), 'audio')).toEqual([])
})

test.each(['remux', 'concat'] as const)(
  '%s skips encoding when no segment retains audio',
  async operation => {
    vi.stubGlobal('AudioEncoder', undefined)
    const original = await fixture('leading-delta-av.mp4')
    const bytes = Buffer.from(await original.arrayBuffer())
    const [movie] = boxPayloads(bytes, 'moov')

    assert.ok(movie)
    const [header] = boxPayloads(movie, 'mvhd')
    const [, audio] = boxPayloads(movie, 'trak')

    assert.ok(header && audio)
    const [edits] = boxPayloads(audio, 'edts')

    assert.ok(edits)
    const [edit] = boxPayloads(edits, 'elst')

    assert.ok(edit && edit[0] === 0 && header[0] === 0)
    const timescale = header.readUInt32BE(12)

    // End audio before the first usable video keyframe.
    edit.writeUInt32BE(Math.floor(timescale / 2), 8)
    const input = new Blob([bytes])
    const target = memoryTarget()
    const options = {
      normalizeAudio: true,
      writable: target.writable,
      storage: await diskStorage(),
    }

    if (operation === 'remux') {
      await remuxMedia(input, options)
    } else {
      await concatMedia([input, input], options)
    }

    expect(await packets(target.blob(), 'video')).not.toHaveLength(0)
    expect(await packets(target.blob(), 'audio')).toEqual([])
  },
)

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
