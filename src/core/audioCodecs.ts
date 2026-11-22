/* oxlint-disable no-await-in-loop -- Feed native codecs with bounded queues. */

import { checkAbort } from '../abort'
import { REMUX_ERROR_CODE } from '../constants'
import { createRemuxError } from '../errors'
import { readEsDescriptor } from '../vendor/mediabunny/src/isobmff/isobmff-reader'
import type { EncodedPacket } from '../vendor/mediabunny/src/packet'
import { FileSlice } from '../vendor/mediabunny/src/reader'

const MAX_CODEC_QUEUE = 8

export const AAC_SAMPLE_RATE = 48_000
export const AAC_CHANNELS = 2
export const AAC_FRAME_SIZE = 1024

const AAC_ENCODER_CONFIG = {
  codec: 'mp4a.40.2',
  sampleRate: AAC_SAMPLE_RATE,
  numberOfChannels: AAC_CHANNELS,
  bitrate: 160_000,
} satisfies AudioEncoderConfig

type AudioCodec = EventTarget & {
  state: CodecState
  flush: () => Promise<void>
  close: () => void
}

interface AudioCodecSession<Source> {
  codec: AudioCodec
  queueSize: () => number
  submit: (source: Source) => void
}

interface AacChunk {
  chunk: EncodedAudioChunk
  config?: AudioDecoderConfig | undefined
}

export async function checkAacEncoder(): Promise<void> {
  if (
    typeof AudioEncoder === 'undefined' ||
    typeof AudioData === 'undefined' ||
    !(await AudioEncoder.isConfigSupported(AAC_ENCODER_CONFIG)).supported
  ) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      'Audio normalization requires a WebCodecs AAC-LC encoder.',
    )
  }
}

export async function checkAudioDecoder(
  config: AudioDecoderConfig,
): Promise<void> {
  if (
    config.numberOfChannels < 1 ||
    config.numberOfChannels > AAC_CHANNELS ||
    typeof AudioDecoder === 'undefined' ||
    typeof EncodedAudioChunk === 'undefined' ||
    !(await AudioDecoder.isConfigSupported(config)).supported
  ) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      `Audio normalization requires a WebCodecs decoder for mono or stereo ${config.codec}.`,
    )
  }
}

/** Races a codec wait against cancellation and cleans up its listener. */
async function waitForCodec<Result>(
  result: Promise<Result>,
  signal: AbortSignal,
) {
  checkAbort(signal)
  const abort = Promise.withResolvers<never>()
  const reject = () => abort.reject(signal.reason)

  signal.addEventListener('abort', reject, { once: true })

  try {
    return await Promise.race([result, abort.promise])
  } finally {
    signal.removeEventListener('abort', reject)
  }
}

/**
 * Streams codec outputs with backpressure and closes owned resources on exit.
 * @yields Each codec output in callback order.
 */
async function* runAudioCodec<Source, Result>(
  inputs: AsyncIterable<Source>,
  open: (
    output: (value: Result) => void,
    error: (reason: DOMException) => void,
  ) => AudioCodecSession<Source>,
  signal?: AbortSignal,
  release?: (result: Result) => void,
): AsyncGenerator<Result, void, unknown> {
  const failure = new AbortController()
  const activeSignal = signal
    ? AbortSignal.any([signal, failure.signal])
    : failure.signal
  const outputs: Result[] = []

  checkAbort(activeSignal)
  const { codec, queueSize, submit } = open(
    result => outputs.push(result),
    reason => failure.abort(reason),
  )

  try {
    for await (const input of inputs) {
      submit(input)
      checkAbort(activeSignal)

      if (queueSize() >= MAX_CODEC_QUEUE) {
        const dequeue = Promise.withResolvers<void>()
        const onDequeue = () => dequeue.resolve()

        codec.addEventListener('dequeue', onDequeue, { once: true })

        try {
          await waitForCodec(dequeue.promise, activeSignal)
        } finally {
          codec.removeEventListener('dequeue', onDequeue)
        }
      }

      while (outputs.length > 0) {
        yield outputs.shift()!
      }
    }

    await waitForCodec(codec.flush(), activeSignal)

    while (outputs.length > 0) {
      yield outputs.shift()!
    }
  } finally {
    if (codec.state !== 'closed') {
      codec.close()
    }

    outputs.forEach(output => release?.(output))
  }
}

/**
 * Native WebKit can report an MPEG-4 ES descriptor in AAC encoder metadata.
 * Extract the AudioSpecificConfig required by MP4 and WebCodecs decoders.
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

      codec.configure(AAC_ENCODER_CONFIG)

      return {
        codec,
        queueSize: () => codec.encodeQueueSize,
        submit(input) {
          try {
            codec.encode(input)
          } finally {
            input.close()
          }
        },
      }
    },
    signal,
  )) {
    yield result.config
      ? { ...result, config: aacDecoderConfig(result.config) }
      : result
  }
}

export function decodeAudio(
  inputs: AsyncIterable<EncodedAudioChunk>,
  config: AudioDecoderConfig,
  signal?: AbortSignal,
) {
  return runAudioCodec<EncodedAudioChunk, AudioData>(
    inputs,
    (output, error) => {
      const codec = new AudioDecoder({ output, error })

      codec.configure(config)

      return {
        codec,
        queueSize: () => codec.decodeQueueSize,
        submit: chunk => codec.decode(chunk),
      }
    },
    signal,
    output => output.close(),
  )
}

export async function* audioChunks(packets: AsyncIterable<EncodedPacket>) {
  for await (const packet of packets) {
    yield (
      packet.type === 'key' ? packet : packet.clone({ type: 'key' })
    ).toEncodedAudioChunk()
  }
}

/** Measures native AAC priming with a short signal at a known sample position. */
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
