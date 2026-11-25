import { isUndefined } from '@ntnyq/utils'
import {
  FRAGMENT_SAMPLE_TYPE,
  MEDIA_CODEC,
  REMUX_ERROR_CODE,
} from '../constants'
import type { DecodeTimeline, PacketTrack, SegmentInfo } from '../types'
import { createRemuxError } from '../utils'
import { GLOBAL_TIMESCALE } from '../vendor/mediabunny/src/isobmff/isobmff-muxer'
import type { IsobmffTrackTiming } from '../vendor/mediabunny/src/output-format'
import type { EncodedPacket } from '../vendor/mediabunny/src/packet'

/**
 * Plans decode clocks without retaining individual packet metadata.
 * The earliest PTS minus elapsed decode time determines each track's required
 * decode lead. AV1 matches presentation time and permits forward jumps at
 * keyframes to represent gaps with a new fragment decode base.
 *
 * @param tracks - Output tracks in muxer order; video uses the default MP4 timescale.
 * @returns A bounded accumulator shared by segment inspections and output setup.
 */
export function createDecodeTimeline(tracks: PacketTrack[]): DecodeTimeline {
  const clocks = tracks.map(track => ({
    isAv1: track.codec === MEDIA_CODEC.av1,
    timescale:
      'sampleRate' in track.config ? track.config.sampleRate : GLOBAL_TIMESCALE,
    units: 0,
    remainder: 0,
    decodeStartUnits: 0,
    sourceDecodeStart: undefined as number | undefined,
    segmentMinimum: Infinity,
    segmentStart: Infinity,
    segmentEnd: -Infinity,
    segmentLastAv1Timestamp: -Infinity,
    segmentAv1DecodeEnd: -Infinity,
    av1DecodeEnd: -Infinity,
    hasLeadingTrim: false,
    start: Infinity,
    end: -Infinity,
  }))
  let elapsed = 0

  return {
    /**
     * Records one packet in decode order using the muxer's duration quantization.
     *
     * @param index - Zero-based output track position.
     * @param packet - Packet retaining the source decode duration.
     * @param presentationStart - Visible start after any track-level audio edit.
     * @returns Nothing.
     * @throws {Error} If source decode timing is missing.
     */
    addPacket(
      index: number,
      packet: EncodedPacket,
      presentationStart = packet.timestamp,
    ) {
      const clock = clocks[index]
      const duration = packet.sideData.decodeDuration

      if (!clock || isUndefined(duration)) {
        throw createRemuxError(
          REMUX_ERROR_CODE.invalidInput,
          'Missing packet decode duration.',
        )
      }

      if (clock.isAv1) {
        const tick = 1 / clock.timescale
        const gap = packet.timestamp - clock.segmentAv1DecodeEnd

        if (
          packet.timestamp < clock.segmentLastAv1Timestamp ||
          gap < -tick ||
          (gap > tick && packet.type !== FRAGMENT_SAMPLE_TYPE.key)
        ) {
          throw createRemuxError(
            REMUX_ERROR_CODE.unsupportedMediaFeature,
            'AV1 decode time must match presentation time with gaps only at keyframes.',
          )
        }

        clock.segmentLastAv1Timestamp = packet.timestamp
        clock.segmentAv1DecodeEnd = packet.timestamp + duration
      } else {
        const decodeOrigin = packet.timestamp - clock.units / clock.timescale
        const precise = duration * clock.timescale + clock.remainder
        const units = Math.round(precise)

        // MPEG-TS supplies a decode origin directly. Later segments keep the
        // output's continuous clock, using source DTS deltas for each sample.
        if (clock.start === Infinity && clock.segmentStart === Infinity) {
          clock.sourceDecodeStart = packet.sideData.decodeTimestamp
        }

        clock.segmentMinimum = Math.min(clock.segmentMinimum, decodeOrigin)
        clock.remainder = precise - units
        clock.units += units
      }

      clock.hasLeadingTrim ||= presentationStart > packet.timestamp
      clock.segmentStart = Math.min(clock.segmentStart, presentationStart)
      clock.segmentEnd = Math.max(
        clock.segmentEnd,
        packet.timestamp + packet.duration,
      )
    },

    /**
     * Applies the segment's common presentation shift to its decode constraints.
     *
     * @param info - Validated shared presentation origin and span, in seconds.
     * @returns Nothing.
     */
    finishSegment(info: SegmentInfo) {
      for (const clock of clocks) {
        if (clock.segmentStart === Infinity) {
          // Audio can end before a trimmed segment's video starts.
          continue
        }

        const segmentStart = clock.segmentStart - info.start + elapsed

        if (clock.isAv1) {
          if (clock.av1DecodeEnd - segmentStart > 1 / clock.timescale) {
            throw createRemuxError(
              REMUX_ERROR_CODE.unsupportedMediaFeature,
              'AV1 decode time overlaps the previous segment.',
            )
          }

          clock.av1DecodeEnd = clock.segmentAv1DecodeEnd - info.start + elapsed
          clock.segmentAv1DecodeEnd = -Infinity
          clock.segmentLastAv1Timestamp = -Infinity
        } else {
          const earliestOrigin = clock.segmentMinimum - info.start + elapsed
          const sourceOrigin = clock.sourceDecodeStart
          const decodeStartUnits =
            sourceOrigin === undefined
              ? clock.decodeStartUnits
              : Math.round(
                  (sourceOrigin - info.start + elapsed) * clock.timescale,
                )

          clock.decodeStartUnits = Math.min(
            decodeStartUnits,
            Math.floor(earliestOrigin * clock.timescale),
          )
          clock.sourceDecodeStart = undefined
        }

        clock.segmentMinimum = Infinity
        clock.start = Math.min(clock.start, segmentStart)
        clock.end = Math.max(clock.end, clock.segmentEnd - info.start + elapsed)
        clock.segmentStart = Infinity
        clock.segmentEnd = -Infinity
      }

      elapsed += info.duration
    },

    /**
     * Snapshots decode origins and presentation bounds for one-based track IDs.
     * Negative starts use a media edit. AV1 may begin at a positive tfdt.
     *
     * @returns Track IDs mapped to decode and presentation timing in seconds.
     */
    trackTimings(): Map<number, IsobmffTrackTiming> {
      return new Map(
        clocks.map((clock, index) => [
          index + 1,
          {
            decodeStart: clock.isAv1
              ? clock.start
              : clock.decodeStartUnits / clock.timescale,
            presentationStart: clock.start === Infinity ? 0 : clock.start,
            presentationEnd: clock.end === -Infinity ? 0 : clock.end,
            ...(clock.hasLeadingTrim ? { hasLeadingTrim: true } : {}),
          },
        ]),
      )
    },
  }
}
