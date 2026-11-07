/* oxlint-disable no-await-in-loop -- Inspect one track at a time to bound packet metadata reads. */
import { checkAbort } from '../abort'
import type { RemuxOptions } from '../types'
import { simplifyRational } from '../vendor/mediabunny/src/misc'
import type { Rational } from '../vendor/mediabunny/src/misc'
import type { DecodeTimeline } from './decodeTimeline'
import type { MediaInput, PacketTrack } from './input/mediaInput'

/**
 * Validated presentation timeline shared by all selected tracks in a segment.
 */
export interface SegmentInfo {
  /**
   * Earliest selected packet presentation timestamp in seconds, possibly negative.
   */
  start: number

  /**
   * Positive span in seconds from start through the latest selected packet end.
   */
  duration: number
}

/**
 * Selects tracks by kind and returns them in video-before-audio order without
 * mutating the input's track list.
 *
 * @param input - Open media input whose tracks are available for selection.
 * @param selection - Requested kind; undefined or 'all' includes every track.
 * @returns A new nonempty array containing the original selected track objects.
 * @throws {Error} If no tracks match the selection.
 */
export function selectTracks(
  input: MediaInput,
  selection: RemuxOptions['tracks'],
): PacketTrack[] {
  const tracks = input.tracks
    .filter(
      track => !selection || selection === 'all' || track.kind === selection,
    )
    .toSorted((left, right) => {
      if (left.kind === right.kind) {
        return 0
      }

      return left.kind === 'video' ? -1 : 1
    })
  if (tracks.length === 0) {
    throw new Error('Input has no selected media tracks.')
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
          colorSpace: {
            primaries: config.colorSpace?.primaries ?? null,
            transfer: config.colorSpace?.transfer ?? null,
            matrix: config.colorSpace?.matrix ?? null,
            fullRange: config.colorSpace?.fullRange ?? null,
          },
        }),
    matrix:
      track.kind === 'video'
        ? (track.matrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1])
        : null,
  })
}

/**
 * Scans packet metadata to validate tracks and determine their shared timeline.
 * Every track must contain packets, and each video track must start with a
 * keyframe. Encoded payloads are not requested during this inspection.
 *
 * @param tracks - Selected tracks whose metadata iterators can be consumed.
 * @param signal - Optional cancellation signal checked for each packet.
 * @param decodeTimeline - Optional output decode-clock planner shared across segments.
 * @returns A promise resolving to the earliest presentation timestamp and the
 * duration through the latest packet end, both measured in seconds.
 * @throws {Error} If timing or packet size is invalid, a track is empty, a video
 * starts without a keyframe, or the combined timeline has no positive duration.
 * Also propagates errors from packet iterators.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function inspectTracks(
  tracks: PacketTrack[],
  signal?: AbortSignal,
  decodeTimeline?: DecodeTimeline,
): Promise<SegmentInfo> {
  let start = Infinity
  let end = -Infinity

  for (const [index, track] of tracks.entries()) {
    let count = 0
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
        throw new Error('Invalid encoded packet timing or size.')
      }

      if (count === 0 && track.kind === 'video' && packet.type !== 'key') {
        throw new Error('Each video segment must begin with a keyframe.')
      }

      // Match the muxer's GOP timing constraint before acquiring the output.
      // Reordered B-frame PTS within the current GOP remains valid.
      if (packet.type === 'key') {
        maxTimestampBeforeLastKeyPacket = maxTimestamp
      }
      if (packet.timestamp < maxTimestampBeforeLastKeyPacket) {
        throw new Error(
          'Timestamps cannot be smaller than the largest timestamp of the previous GOP.',
        )
      }
      maxTimestamp = Math.max(maxTimestamp, packet.timestamp)
      decodeTimeline?.addPacket(index, packet)

      // B-frame presentation timestamps can arrive out of order. Inspect every
      // packet rather than treating the first decoded packet as the start.
      start = Math.min(start, packet.timestamp)
      end = Math.max(end, packet.timestamp + packet.duration)
      count++
    }

    if (count === 0) {
      throw new Error(`The ${track.kind} track has no packets.`)
    }
  }

  if (!(end > start)) {
    throw new Error('Media segment has no positive duration.')
  }

  const info = { start, duration: end - start }
  decodeTimeline?.finishSegment(info)
  return info
}
