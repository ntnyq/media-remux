/* oxlint-disable no-await-in-loop -- Inspect one track at a time to bound packet metadata reads. */

import { checkAbort } from '../abort'
import {
  FRAGMENT_SAMPLE_TYPE,
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
  REMUX_TRACK_SELECTION,
} from '../constants'
import { createRemuxError } from '../errors'
import type { RemuxOptions } from '../types'
import { resolveIsobmffColorInformation } from '../vendor/mediabunny/src/isobmff/isobmff-misc'
import { simplifyRational } from '../vendor/mediabunny/src/misc'
import type { Rational } from '../vendor/mediabunny/src/misc'
import type { DecodeTimeline } from './decodeTimeline'
import type { MediaInput, PacketTrack } from './input/mediaInput'
import { isIndependentMp3Frame } from './input/mp3Frame'

/**
 * Validated presentation timeline shared by all selected tracks in a segment.
 */
export interface SegmentInfo {
  /**
   * Earliest playable timestamp in seconds, possibly negative.
   */
  start: number

  /**
   * Positive span in seconds from start through the latest selected packet end.
   */
  duration: number

  /** Number of packets discarded from the beginning of each selected track. */
  skippedPackets?: readonly number[]

  /** Retained audio presentation bounds before the common segment shift. */
  audioRange?: { start: number; end: number }
}

/**
 * Selects tracks by kind and returns them in video-before-audio order without
 * mutating the input's track list.
 *
 * @param input - Open media input whose tracks are available for selection.
 * @param selection - Requested track kinds, including any required track.
 * @returns A new nonempty array containing the original selected track objects.
 * @throws {Error} If no tracks match the selection or required video is missing.
 */
export function selectTracks(
  input: MediaInput,
  selection: RemuxOptions['tracks'],
): PacketTrack[] {
  const requiresVideo =
    selection === REMUX_TRACK_SELECTION.videoWithOptionalAudio ||
    selection === REMUX_TRACK_SELECTION.firstVideoWithOptionalAudio
  const tracks = input.tracks
    .filter(
      track =>
        !selection ||
        selection === REMUX_TRACK_SELECTION.all ||
        requiresVideo ||
        track.kind === selection,
    )
    .toSorted((left, right) => {
      if (left.kind === right.kind) {
        return 0
      }

      return left.kind === MEDIA_TRACK_KIND.video ? -1 : 1
    })

  if (requiresVideo && tracks[0]?.kind !== MEDIA_TRACK_KIND.video) {
    throw createRemuxError(
      REMUX_ERROR_CODE.missingRequiredTrack,
      'Input has no required video track.',
    )
  }

  if (tracks.length === 0) {
    throw createRemuxError(
      REMUX_ERROR_CODE.missingRequiredTrack,
      'Input has no selected media tracks.',
    )
  }

  return tracks
}

/**
 * Views decoder initialization bytes without copying their underlying buffer.
 *
 * @param config - Audio or video decoder configuration with optional description.
 * @returns A byte view respecting the description's offset and length, or an
 * empty buffer when no description is present.
 */
function descriptionBytes(
  config: VideoDecoderConfig | AudioDecoderConfig,
): Uint8Array {
  const buffer = config.description

  if (!buffer) {
    return new Uint8Array(0)
  }

  return ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer)
}

/**
 * Reduces display dimensions to the ratio they represent for compatibility checks.
 *
 * @param config - Video decoder configuration containing display or coded dimensions.
 * @returns The exact reduced display ratio, or null when dimensions are absent.
 */
function getDisplayAspectRatio(config: VideoDecoderConfig): Rational | null {
  const width = config.displayAspectWidth ?? config.codedWidth
  const height = config.displayAspectHeight ?? config.codedHeight

  if (width === undefined || height === undefined) {
    return null
  }

  return simplifyRational({ num: width, den: height })
}

/**
 * Serializes the track properties used to check segment compatibility.
 * Includes kind, normalized codec, decoder description, audio or video format,
 * and video transformation matrix, with defaults for absent display metadata.
 *
 * @param track - Track whose decoder configuration and display metadata to compare.
 * @returns A JSON signature for comparison with another track in the same position.
 */
export function trackSignature(track: PacketTrack): string {
  const { config } = track

  return JSON.stringify({
    kind: track.kind,
    codec: config.codec.toLowerCase(),
    description: [...descriptionBytes(config)],
    ...('sampleRate' in config
      ? { sampleRate: config.sampleRate, channels: config.numberOfChannels }
      : {
          width: config.codedWidth,
          height: config.codedHeight,
          aspectRatio: getDisplayAspectRatio(config),
          colorInformation: resolveIsobmffColorInformation(
            config.colorSpace,
            track.containerColorInformation,
          ),
        }),
    matrix:
      track.kind === MEDIA_TRACK_KIND.video
        ? (track.matrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1])
        : null,
  })
}

/**
 * Scans packet metadata to validate tracks and determine their shared timeline.
 * Video must start with a keyframe. H.264 MP4 with leading delta packets can
 * advance to a verified IDR, skipping earlier audio on the same timeline.
 * Inspection reads payloads only to verify a video or MP3 cut point.
 *
 * @param tracks - Selected tracks in video-before-audio order.
 * @param signal - Optional cancellation signal checked for each packet.
 * @param decodeTimeline - Optional output decode-clock planner shared across segments.
 * @param normalizeAudio - Collect the retained audio span for WebCodecs processing.
 * @param isFirstSegment - Whether a track-level edit can hide leading audio.
 * @returns A promise resolving to the earliest presentation timestamp and the
 * duration through the latest packet end, both measured in seconds.
 * @throws {Error} If timing or packet size is invalid, a source track is empty,
 * video has no usable start, or the combined timeline has no positive duration.
 * Also propagates errors from packet iterators.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function inspectTracks(
  tracks: PacketTrack[],
  signal?: AbortSignal,
  decodeTimeline?: DecodeTimeline,
  normalizeAudio = false,
  isFirstSegment = true,
): Promise<SegmentInfo> {
  let start = Infinity
  let end = -Infinity
  let trimBefore: number | undefined
  let audioRange: SegmentInfo['audioRange']
  const skippedPackets: number[] = []

  for (const [index, track] of tracks.entries()) {
    const processesAudio =
      normalizeAudio && track.kind === MEDIA_TRACK_KIND.audio
    const { audioEditStart } = track
    let count = 0
    let skipped = 0
    let firstVideoSequence: number | undefined
    let maxTimestamp = -Infinity
    let maxTimestampBeforeLastKeyPacket = -Infinity

    for await (const packet of track.packets(true)) {
      checkAbort(signal)

      if (
        !Number.isFinite(packet.timestamp) ||
        !Number.isFinite(packet.duration) ||
        packet.duration < 0 ||
        packet.byteLength === 0
      ) {
        throw createRemuxError(
          REMUX_ERROR_CODE.invalidInput,
          'Invalid encoded packet timing or size.',
        )
      }

      if (
        count === 0 &&
        skipped === 0 &&
        track.kind === MEDIA_TRACK_KIND.video &&
        packet.type !== FRAGMENT_SAMPLE_TYPE.key
      ) {
        if (!track.findNextRandomAccessPacket) {
          throw createRemuxError(
            REMUX_ERROR_CODE.unsupportedMediaFeature,
            'Each video segment must begin with a keyframe.',
          )
        }

        const key = await track.findNextRandomAccessPacket(packet)

        checkAbort(signal)

        if (!key) {
          throw createRemuxError(
            REMUX_ERROR_CODE.unsupportedMediaFeature,
            'H.264 MP4 has no decodable keyframe after its leading dependent frames.',
          )
        }

        firstVideoSequence = key.sequenceNumber
        trimBefore = key.timestamp
      }

      if (
        (firstVideoSequence !== undefined &&
          packet.sequenceNumber !== firstVideoSequence) ||
        (track.kind === MEDIA_TRACK_KIND.audio &&
          count === 0 &&
          trimBefore !== undefined &&
          packet.timestamp < trimBefore)
      ) {
        skipped++
        continue
      }

      firstVideoSequence = undefined
      let presentationStart = packet.timestamp

      if (count === 0 && track.kind === MEDIA_TRACK_KIND.audio) {
        if (audioEditStart !== undefined && packet.timestamp < audioEditStart) {
          const duration = Math.min(
            packet.duration,
            packet.sideData.decodeDuration ?? packet.duration,
          )

          if (packet.timestamp + duration <= audioEditStart + 1e-9) {
            skipped++
            continue
          }

          if (!processesAudio && !isFirstSegment) {
            throw createRemuxError(
              REMUX_ERROR_CODE.unsupportedMediaFeature,
              'An MP4 audio edit that starts inside a packet in a later segment requires normalizeAudio.',
            )
          }

          presentationStart = audioEditStart
        }

        if (!processesAudio && skipped > 0 && track.codec === MEDIA_CODEC.mp3) {
          const retained = track.packets(false, skipped)

          try {
            const first = await retained.next()

            if (first.done || !isIndependentMp3Frame(first.value.data)) {
              throw createRemuxError(
                REMUX_ERROR_CODE.unsupportedMediaFeature,
                'The first retained MP3 frame requires preceding audio data. Use normalizeAudio to trim this track.',
              )
            }
          } finally {
            await retained.return()
          }
        }
      }

      // Match the muxer's GOP timing constraint before acquiring the output.
      // Reordered B-frame PTS within the current GOP remains valid.
      if (packet.type === FRAGMENT_SAMPLE_TYPE.key) {
        maxTimestampBeforeLastKeyPacket = maxTimestamp
      }

      if (packet.timestamp < maxTimestampBeforeLastKeyPacket) {
        throw createRemuxError(
          REMUX_ERROR_CODE.unsupportedMediaFeature,
          'Timestamps cannot be smaller than the largest timestamp of the previous GOP.',
        )
      }

      maxTimestamp = Math.max(maxTimestamp, packet.timestamp)

      if (processesAudio) {
        audioRange ??= { start: presentationStart, end: -Infinity }
        audioRange.end = Math.max(
          audioRange.end,
          packet.timestamp + packet.duration,
        )
      } else {
        decodeTimeline?.addPacket(index, packet, presentationStart)
      }

      // B-frame presentation timestamps can arrive out of order. Inspect every
      // packet rather than treating the first decoded packet as the start.
      start = Math.min(start, presentationStart)
      end = Math.max(end, packet.timestamp + packet.duration)
      count++
    }

    if (count + skipped === 0 || firstVideoSequence !== undefined) {
      throw createRemuxError(
        REMUX_ERROR_CODE.invalidInput,
        `The ${track.kind} track has no packets.`,
      )
    }

    skippedPackets.push(skipped)
  }

  if (!(end > start)) {
    throw createRemuxError(
      REMUX_ERROR_CODE.invalidInput,
      'Media segment has no positive duration.',
    )
  }

  const info = {
    start,
    duration: end - start,
    ...(skippedPackets.some(count => count > 0) ? { skippedPackets } : {}),
    ...(audioRange === undefined ? {} : { audioRange }),
  }

  decodeTimeline?.finishSegment(info)

  return info
}
