/* oxlint-disable no-await-in-loop -- Decode and spool audio in presentation order. */

import { checkAbort } from '../abort'
import {
  FRAGMENT_SAMPLE_TYPE,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
} from '../constants'
import { createRemuxError } from '../errors'
import type { RemuxStorage } from '../types'
import { EncodedPacket } from '../vendor/mediabunny/src/packet'
import {
  AAC_CHANNELS,
  AAC_FRAME_SIZE,
  AAC_SAMPLE_RATE,
  audioChunks,
  checkAacEncoder,
  decodeAudio,
  encodeAac,
  makeAudioData,
  measureAacPriming,
} from './audioCodecs'
import type { PacketTrack } from './input/mediaInput'
import type { SegmentInfo } from './mediaTracks'

// The output uses at most two tracks. Use a separate temporary track ID.
const AUDIO_SPOOL_ID = 3
const RESAMPLE_RADIUS = 8
const RESAMPLE_PHASES = 64

interface AudioSegment {
  tracks: PacketTrack[]
  info: SegmentInfo
}

interface PcmBlock {
  planes: Float32Array<ArrayBuffer>[]
  sampleRate: number
  start: number
  end: number
  previous?: Float32Array<ArrayBuffer>[]
  next?: Float32Array<ArrayBuffer>[]
}

/** Low-pass interpolation kernels, indexed by the fractional source position. */
function resamplingKernels(sampleRate: number) {
  const cutoff = Math.min(1, AAC_SAMPLE_RATE / sampleRate)

  return Array.from({ length: RESAMPLE_PHASES }, (_, phase) => {
    const fraction = phase / RESAMPLE_PHASES
    const kernel = Float32Array.from(
      { length: 2 * RESAMPLE_RADIUS },
      (_tap, tap) => {
        const distance = tap - RESAMPLE_RADIUS + 1 - fraction
        const angle = Math.PI * cutoff * distance
        const sinc = angle === 0 ? 1 : Math.sin(angle) / angle

        return sinc * (1 + Math.cos((Math.PI * distance) / RESAMPLE_RADIUS))
      },
    )
    const sum = kernel.reduce((total, weight) => total + weight, 0)

    return kernel.map(weight => weight / sum)
  })
}

/**
 * Copies Worker-owned AudioData into bounded PCM blocks. Decode the prefix of
 * a cut MP3 stream to restore its reservoir, then crop on the presentation clock.
 * @yields Source PCM blocks positioned on the output clock.
 */
async function* decodeSegment(
  track: PacketTrack,
  shift: number,
  signal?: AbortSignal,
): AsyncGenerator<PcmBlock, void, unknown> {
  if (!('sampleRate' in track.config)) {
    throw new Error('Expected an audio decoder configuration.')
  }

  let lastEnd = -Infinity
  let pending: PcmBlock | undefined

  for await (const data of decodeAudio(
    audioChunks(track.packets()),
    track.config,
    signal,
  )) {
    let block: PcmBlock

    try {
      if (data.numberOfChannels < 1 || data.numberOfChannels > AAC_CHANNELS) {
        throw createRemuxError(
          REMUX_ERROR_CODE.unsupportedMediaFeature,
          'Audio normalization supports mono and stereo input.',
        )
      }

      const start = (data.timestamp / 1e6) * AAC_SAMPLE_RATE + shift
      // FLV and Matroska can round otherwise adjacent frames to milliseconds.
      const alignedStart =
        Math.abs(start - lastEnd) <= AAC_SAMPLE_RATE / 1000 ? lastEnd : start
      const end =
        alignedStart + (data.numberOfFrames * AAC_SAMPLE_RATE) / data.sampleRate
      const planes = Array.from(
        { length: data.numberOfChannels },
        (_, planeIndex) => {
          const plane = new Float32Array(data.numberOfFrames)

          data.copyTo(plane, { planeIndex, format: 'f32-planar' })

          return plane
        },
      )

      block = { planes, sampleRate: data.sampleRate, start: alignedStart, end }
      lastEnd = end
    } finally {
      data.close()
    }

    if (pending) {
      if (
        pending.end === block.start &&
        pending.sampleRate === block.sampleRate
      ) {
        pending.next = block.planes
        block.previous = pending.planes
      }

      yield pending
    }

    pending = block
  }

  if (pending) {
    yield pending
  }
}

/**
 * Builds one continuous PCM clock from source samples and silence. The encoder
 * stays open across every splice so no extra priming appears between segments.
 * @yields Full PCM blocks for the AAC encoder.
 */
async function* pcmInputs(
  segments: AsyncIterable<AudioSegment>,
  preroll: number,
  signal?: AbortSignal,
) {
  let frame = 0
  let elapsed = 0
  let pcm = new Float32Array(AAC_FRAME_SIZE * AAC_CHANNELS)
  const kernels = new Map<number, ReturnType<typeof resamplingKernels>>()

  function* writeUntil(end: number, block?: PcmBlock) {
    while (frame < end) {
      checkAbort(signal)
      const offset = frame % AAC_FRAME_SIZE
      const count = Math.min(end - frame, AAC_FRAME_SIZE - offset)

      if (block) {
        const step = block.sampleRate / AAC_SAMPLE_RATE
        let table = kernels.get(block.sampleRate)

        if (step !== 1 && !table) {
          table = resamplingKernels(block.sampleRate)
          kernels.set(block.sampleRate, table)
        }

        for (let channel = 0; channel < AAC_CHANNELS; channel++) {
          const plane = block.planes[channel] ?? block.planes[0]!
          const previous = block.previous?.[channel] ?? block.previous?.[0]
          const next = block.next?.[channel] ?? block.next?.[0]
          const target = channel * AAC_FRAME_SIZE + offset

          for (let i = 0; i < count; i++) {
            const position = (frame + i - block.start) * step

            if (!table) {
              const index = Math.min(
                plane.length - 1,
                Math.max(0, Math.round(position)),
              )

              pcm[target + i] = plane[index]!
              continue
            }

            const base = Math.floor(position)
            const phase = Math.floor((position - base) * RESAMPLE_PHASES)
            const weights = table[phase]!
            let value = 0

            for (let tap = 0; tap < weights.length; tap++) {
              const index = base - RESAMPLE_RADIUS + 1 + tap
              const sample =
                index < 0
                  ? (previous?.[previous.length + index] ?? plane[0]!)
                  : (plane[index] ??
                    next?.[index - plane.length] ??
                    plane[plane.length - 1]!)

              value += sample * weights[tap]!
            }

            pcm[target + i] = value
          }
        }
      }

      frame += count

      if (frame % AAC_FRAME_SIZE === 0) {
        yield makeAudioData(pcm, AAC_FRAME_SIZE, frame - AAC_FRAME_SIZE)
        pcm = new Float32Array(pcm.length)
      }
    }
  }

  for await (const { tracks, info } of segments) {
    const track = tracks.find(
      candidate => candidate.kind === MEDIA_TRACK_KIND.audio,
    )
    const shift = (elapsed - info.start) * AAC_SAMPLE_RATE + preroll
    const segmentStart = Math.round(elapsed * AAC_SAMPLE_RATE) + preroll

    elapsed += info.duration

    const segmentEnd = Math.round(elapsed * AAC_SAMPLE_RATE) + preroll

    if (track && info.audioRange) {
      const first = Math.max(
        segmentStart,
        Math.round(info.audioRange.start * AAC_SAMPLE_RATE + shift),
      )
      const last = Math.min(
        segmentEnd,
        Math.round(info.audioRange.end * AAC_SAMPLE_RATE + shift),
      )

      for await (const block of decodeSegment(track, shift, signal)) {
        const start = Math.max(first, Math.round(block.start))
        const end = Math.min(last, Math.round(block.end))

        if (end > Math.max(frame, start)) {
          yield* writeUntil(start)
          yield* writeUntil(end, block)
        }
      }
    }

    yield* writeUntil(segmentEnd)
  }

  if (frame % AAC_FRAME_SIZE !== 0) {
    // The last block is zero-padded here and trimmed on the movie timeline.
    yield makeAudioData(pcm, AAC_FRAME_SIZE, frame - (frame % AAC_FRAME_SIZE))
  }
}

/**
 * Encodes and spools normalized audio before opening the output. Each encoded
 * packet keeps its full AAC data, including the first packet that overlaps the
 * retained end. Encoder priming and added silence occupy complete frames.
 */
export async function normalizeAudio(
  segments: AsyncIterable<AudioSegment>,
  duration: number,
  store: RemuxStorage['fragmentSamples'],
  signal?: AbortSignal,
) {
  await checkAacEncoder(signal)
  const end = Math.round(duration * AAC_SAMPLE_RATE)

  if (!Number.isSafeInteger(end) || end < 1) {
    throw createRemuxError(
      REMUX_ERROR_CODE.invalidInput,
      'Audio duration is outside the normalization clock range.',
    )
  }

  const priming = await measureAacPriming(signal)
  const preroll = 2 * AAC_FRAME_SIZE - (priming % AAC_FRAME_SIZE)
  let frame = -(priming + preroll)
  let count = 0
  let firstId: number | undefined
  let config: AudioDecoderConfig | undefined

  for await (const result of encodeAac(
    pcmInputs(segments, preroll, signal),
    signal,
  )) {
    checkAbort(signal)
    config ??= result.config

    if (frame < 0) {
      frame += AAC_FRAME_SIZE
      continue
    }

    if (frame >= end) {
      continue
    }

    const length = Math.min(AAC_FRAME_SIZE, end - frame)
    const timestamp = frame / AAC_SAMPLE_RATE
    const packetDuration = length / AAC_SAMPLE_RATE
    const data = new Uint8Array(result.chunk.byteLength)

    result.chunk.copyTo(data)
    const id = await store.append(
      AUDIO_SPOOL_ID,
      {
        timestamp,
        decodeTimestamp: timestamp,
        duration: packetDuration,
        type: FRAGMENT_SAMPLE_TYPE.key,
        size: data.length,
        timescaleUnitsToNextSample: length,
      },
      data,
    )

    firstId ??= id
    count++
    frame += length
  }

  if (
    !config?.description ||
    config.sampleRate !== AAC_SAMPLE_RATE ||
    config.numberOfChannels !== AAC_CHANNELS ||
    frame < end ||
    firstId === undefined
  ) {
    throw createRemuxError(
      REMUX_ERROR_CODE.unsupportedMediaFeature,
      'Native AAC encoder did not produce the requested format and duration.',
    )
  }

  const startId = firstId

  return {
    config,
    timing: {
      decodeStart: 0,
      presentationStart: 0,
      presentationEnd: end / AAC_SAMPLE_RATE,
    },
    async *packets() {
      for (let id = startId; id < startId + count; id++) {
        checkAbort(signal)
        const row = await store.get(AUDIO_SPOOL_ID, id)
        const data = await store.readMedia(
          AUDIO_SPOOL_ID,
          row.mediaOffset,
          row.size,
        )

        yield new EncodedPacket(
          data,
          row.type,
          row.timestamp,
          row.duration,
          -1,
          row.size,
          { decodeDuration: row.duration },
        )
      }
    },
  }
}
