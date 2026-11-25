/* oxlint-disable no-await-in-loop -- Feed native codecs with bounded queues. */

import { createDeferred, isUndefined, raceWithSignal } from '@ntnyq/utils'
import {
  REMUX_ERROR_CODE,
  AAC_CHANNELS,
  AAC_ENCODER_CONFIG,
  AAC_FRAME_SIZE,
  AAC_SAMPLE_RATE,
  MAX_CODEC_QUEUE,
} from '../constants'
import type { AacChunk, AudioCodecSession } from '../types'
import { checkAbort, createRemuxError } from '../utils'
import { readEsDescriptor } from '../vendor/mediabunny/src/isobmff/isobmff-reader'
import type { EncodedPacket } from '../vendor/mediabunny/src/packet'
import { FileSlice } from '../vendor/mediabunny/src/reader'

/**
 * Checks whether WebCodecs supports the AAC-LC normalization format.
 *
 * @param signal - Optional cancellation signal for the support probe.
 * @returns A promise resolving when the required encoder support is confirmed.
 * @throws If the required WebCodecs APIs or encoder configuration are unavailable.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function checkAacEncoder(signal?: AbortSignal): Promise<void> {
  checkAbort(signal)

  if (
    isUndefined(globalThis.AudioEncoder) ||
    isUndefined(globalThis.AudioData) ||
    !(
      await waitForCodec(
        () => AudioEncoder.isConfigSupported(AAC_ENCODER_CONFIG),
        signal,
      )
    ).supported
  ) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      'Audio normalization requires a WebCodecs AAC-LC encoder.',
    )
  }
}

/**
 * Checks whether WebCodecs can decode the selected mono or stereo audio format.
 *
 * @param config - Decoder configuration from the selected source track.
 * @param signal - Optional cancellation signal for the support probe.
 * @returns A promise resolving when the required decoder support is confirmed.
 * @throws If the channel count, WebCodecs APIs, or decoder configuration are unsupported.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function checkAudioDecoder(
  config: AudioDecoderConfig,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal)

  if (
    config.numberOfChannels < 1 ||
    config.numberOfChannels > AAC_CHANNELS ||
    isUndefined(globalThis.AudioDecoder) ||
    isUndefined(globalThis.EncodedAudioChunk) ||
    !(await waitForCodec(() => AudioDecoder.isConfigSupported(config), signal))
      .supported
  ) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      `Audio normalization requires a WebCodecs decoder for mono or stereo ${config.codec}.`,
    )
  }
}

/**
 * Runs a codec operation with cancellation checks around the wait.
 *
 * @template Result - Value produced by the codec operation.
 * @param wait - Starts the asynchronous codec operation.
 * @param signal - Optional cancellation signal raced against the operation.
 * @returns A promise resolving to the codec operation's result.
 * @throws The operation failure or the signal's abort reason.
 */
async function waitForCodec<Result>(
  wait: () => Promise<Result>,
  signal?: AbortSignal,
) {
  checkAbort(signal)
  const result = await (signal ? raceWithSignal(wait(), signal) : wait())

  checkAbort(signal)

  return result
}

/**
 * Streams codec outputs with backpressure and closes owned resources on exit.
 *
 * @template Source - Input accepted by the codec.
 * @template Result - Output emitted by the codec.
 * @param inputs - Stream of inputs to submit in order.
 * @param open - Creates a codec session using the supplied output and error callbacks.
 * @param signal - Optional cancellation signal for the session.
 * @param releaseOutput - Optional cleanup for outputs that were never yielded.
 * @yields Each codec output in callback order.
 * @throws If input iteration, codec processing, or cancellation fails.
 */
async function* runAudioCodec<Source, Result>(
  inputs: AsyncIterable<Source>,
  open: (
    output: (value: Result) => void,
    error: (reason: DOMException) => void,
  ) => AudioCodecSession<Source>,
  signal?: AbortSignal,
  releaseOutput?: (result: Result) => void,
): AsyncGenerator<Result, void, unknown> {
  const failure = new AbortController()
  const activeSignal = signal
    ? AbortSignal.any([signal, failure.signal])
    : failure.signal
  const outputs: Result[] = []

  checkAbort(activeSignal)
  const { codec, configure, queueSize, submit, releaseInput } = open(
    result => outputs.push(result),
    reason => failure.abort(reason),
  )

  try {
    configure()

    for await (const input of inputs) {
      try {
        checkAbort(activeSignal)
        submit(input)
      } finally {
        releaseInput?.(input)
      }

      checkAbort(activeSignal)

      if (queueSize() >= MAX_CODEC_QUEUE) {
        const { promise: dequeued, resolve } = createDeferred<void>()
        const onDequeue = () => resolve()

        codec.addEventListener('dequeue', onDequeue, { once: true })

        try {
          await waitForCodec(() => dequeued, activeSignal)
        } finally {
          codec.removeEventListener('dequeue', onDequeue)
        }
      }

      while (outputs.length > 0) {
        checkAbort(activeSignal)
        yield outputs.shift()!
      }
    }

    await waitForCodec(() => codec.flush(), activeSignal)

    while (outputs.length > 0) {
      checkAbort(activeSignal)
      yield outputs.shift()!
    }
  } catch (error) {
    checkAbort(activeSignal)

    throw error
  } finally {
    if (codec.state !== 'closed') {
      codec.close()
    }

    outputs.forEach(output => releaseOutput?.(output))
  }
}

/**
 * Native WebKit can report an MPEG-4 ES descriptor in AAC encoder metadata.
 * Extracts the AudioSpecificConfig required by MP4 and WebCodecs decoders.
 *
 * @param config - Decoder configuration emitted by the native AAC encoder.
 * @returns A configuration with the extracted description, or the original configuration.
 * @throws If an MPEG-4 ES descriptor is invalid or lacks decoder-specific data.
 */
function aacDecoderConfig(config: AudioDecoderConfig): AudioDecoderConfig {
  const { description } = config

  if (!description) {
    return config
  }

  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(
        description.buffer,
        description.byteOffset,
        description.byteLength,
      )
    : new Uint8Array(description)

  if (bytes[0] !== 0x03) {
    return config
  }

  const { decoderSpecificInfo } = readEsDescriptor(
    FileSlice.tempFromBytes(bytes),
  )

  if (!decoderSpecificInfo?.length) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      'Native AAC encoder did not report an AudioSpecificConfig.',
    )
  }

  return { ...config, description: decoderSpecificInfo }
}

/**
 * Wraps planar stereo PCM in a WebCodecs audio frame at the AAC sample rate.
 *
 * @param data - Consecutive left and right Float32 PCM planes.
 * @param frames - Number of PCM samples per channel.
 * @param start - First sample position on the output clock.
 * @returns AudioData timestamped in microseconds.
 */
export function makeAudioData(
  data: Float32Array<ArrayBuffer>,
  frames: number,
  start: number,
): AudioData {
  return new AudioData({
    data,
    format: 'f32-planar',
    numberOfChannels: AAC_CHANNELS,
    numberOfFrames: frames,
    sampleRate: AAC_SAMPLE_RATE,
    timestamp: Math.round((start * 1e6) / AAC_SAMPLE_RATE),
  })
}

/**
 * Encodes PCM as AAC-LC and closes each submitted AudioData frame.
 *
 * @param inputs - PCM frames matching the normalization format.
 * @param signal - Optional cancellation signal for encoding.
 * @yields Encoded AAC chunks with decoder configuration when reported.
 */
export async function* encodeAac(
  inputs: AsyncIterable<AudioData>,
  signal?: AbortSignal,
) {
  for await (const result of runAudioCodec<AudioData, AacChunk>(
    inputs,
    (output, error) => {
      const codec = new AudioEncoder({
        output: (chunk, metadata) =>
          output({ chunk, config: metadata?.decoderConfig }),
        error,
      })

      return {
        codec,
        configure: () => codec.configure(AAC_ENCODER_CONFIG),
        queueSize: () => codec.encodeQueueSize,
        submit: input => codec.encode(input),
        releaseInput: input => input.close(),
      }
    },
    signal,
  )) {
    yield result.config
      ? { ...result, config: aacDecoderConfig(result.config) }
      : result
  }
}

/**
 * Decodes encoded audio with backpressure. The consumer owns each yielded frame.
 *
 * @param inputs - Encoded audio chunks in decode order.
 * @param config - WebCodecs configuration for the source codec and format.
 * @param signal - Optional cancellation signal for decoding.
 * @returns An asynchronous generator yielding decoded AudioData frames.
 */
export function decodeAudio(
  inputs: AsyncIterable<EncodedAudioChunk>,
  config: AudioDecoderConfig,
  signal?: AbortSignal,
) {
  return runAudioCodec<EncodedAudioChunk, AudioData>(
    inputs,
    (output, error) => {
      const codec = new AudioDecoder({ output, error })

      return {
        codec,
        configure: () => codec.configure(config),
        queueSize: () => codec.decodeQueueSize,
        submit: chunk => codec.decode(chunk),
      }
    },
    signal,
    output => output.close(),
  )
}

/**
 * Adapts encoded packets to WebCodecs audio chunks marked as key chunks.
 *
 * @param packets - Source packets in decode order.
 * @yields A WebCodecs chunk for each source packet.
 */
export async function* audioChunks(packets: AsyncIterable<EncodedPacket>) {
  for await (const packet of packets) {
    yield (
      packet.type === 'key' ? packet : packet.clone({ type: 'key' })
    ).toEncodedAudioChunk()
  }
}

/**
 * Measures native AAC priming by locating a known PCM marker after an encode/decode round trip.
 *
 * @param signal - Optional cancellation signal for the probe.
 * @returns A promise resolving to the encoder delay in samples at the AAC sample rate.
 * @throws If the codec probe fails or the delay cannot be measured.
 */
export async function measureAacPriming(signal?: AbortSignal): Promise<number> {
  const markerStart = 4 * AAC_FRAME_SIZE
  const marker = Float32Array.from(
    { length: 128 },
    (_, i) =>
      Math.sin(0.08 * i + 0.006 * i * i) * Math.sin((Math.PI * i) / 128) * 0.5,
  )

  async function* probe() {
    for (let i = 0; i < 8; i++) {
      const start = i * AAC_FRAME_SIZE
      const data = new Float32Array(AAC_FRAME_SIZE * AAC_CHANNELS)

      if (start === markerStart) {
        data.set(marker)
        data.set(marker, AAC_FRAME_SIZE)
      }

      yield makeAudioData(data, AAC_FRAME_SIZE, start)
    }
  }

  let config: AudioDecoderConfig | undefined
  const chunks: EncodedAudioChunk[] = []

  for await (const result of encodeAac(probe(), signal)) {
    config ??= result.config
    chunks.push(result.chunk)
  }

  if (!config?.description) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      'AAC encoder did not report its decoder configuration.',
    )
  }

  async function* encodedProbe() {
    yield* chunks
  }

  const pcm = new Float32Array(16 * AAC_FRAME_SIZE)
  let frames = 0

  for await (const data of decodeAudio(encodedProbe(), config, signal)) {
    try {
      const plane = pcm.subarray(frames, frames + data.numberOfFrames)

      if (plane.length !== data.numberOfFrames) {
        throw createRemuxError(
          REMUX_ERROR_CODE.unsupportedMediaFeature,
          'Unexpected native AAC encoder priming.',
        )
      }

      data.copyTo(plane, { planeIndex: 0, format: 'f32-planar' })
      frames += plane.length
    } finally {
      data.close()
    }
  }

  let best = 0
  let offset = -1

  for (let i = markerStart; i <= frames - marker.length; i++) {
    let correlation = 0

    for (let j = 0; j < marker.length; j++) {
      correlation += pcm[i + j]! * marker[j]!
    }

    if (correlation > best) {
      best = correlation
      offset = i - markerStart
    }
  }

  if (offset < 0 || best < 1) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      'Could not measure native AAC encoder priming.',
    )
  }

  return offset
}
