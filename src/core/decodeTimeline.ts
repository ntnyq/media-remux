import { MEDIA_CODEC, REMUX_ERROR_CODE } from '../constants'
import { createRemuxError } from '../errors'
import { GLOBAL_TIMESCALE } from '../vendor/mediabunny/src/isobmff/isobmff-muxer'
import type { IsobmffTrackTiming } from '../vendor/mediabunny/src/output-format'
import type { EncodedPacket } from '../vendor/mediabunny/src/packet'
import type { PacketTrack } from './input/mediaInput'
import type { SegmentInfo } from './mediaTracks'

/**
 * Plans continuous decode clocks without retaining individual packet metadata.
 * The earliest PTS minus elapsed decode time determines each track's required
 * decode lead. AV1 instead requires the decode clock to match presentation
 * time, including any delay relative to the other tracks.
 *
 * @param tracks - Output tracks in muxer order; video uses the default MP4 timescale.
 * @returns A bounded accumulator shared by segment inspections and output setup.
 */
export function createDecodeTimeline(tracks: PacketTrack[]) {
  const clocks = tracks.map(track => ({
    isAv1: track.codec === MEDIA_CODEC.av1,
    timescale:
      'sampleRate' in track.config ? track.config.sampleRate : GLOBAL_TIMESCALE,
    units: 0,
    remainder: 0,
    decodeStartUnits: 0,
    segmentMinimum: Infinity,
    segmentMaximum: -Infinity,
    segmentStart: Infinity,
    segmentEnd: -Infinity,
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
     * @returns Nothing.
     * @throws {Error} If source decode timing is missing.
     */
    addPacket(index: number, packet: EncodedPacket) {
      const clock = clocks[index]
      const duration = packet.sideData.decodeDuration

      if (!clock || duration === undefined) {
        throw createRemuxError(
          REMUX_ERROR_CODE.invalidInput,
          'Missing packet decode duration.',
        )
      }

      const decodeOrigin = packet.timestamp - clock.units / clock.timescale

      clock.segmentMinimum = Math.min(clock.segmentMinimum, decodeOrigin)
      clock.segmentMaximum = Math.max(clock.segmentMaximum, decodeOrigin)
      clock.segmentStart = Math.min(clock.segmentStart, packet.timestamp)
      clock.segmentEnd = Math.max(
        clock.segmentEnd,
        packet.timestamp + packet.duration,
      )
      const precise = duration * clock.timescale + clock.remainder
      const units = Math.round(precise)

      clock.remainder = precise - units
      clock.units += units
    },

    /**
     * Applies the segment's common presentation shift to its decode constraints.
     *
     * @param info - Validated shared presentation origin and span, in seconds.
     * @returns Nothing.
     */
    finishSegment(info: SegmentInfo) {
      for (const clock of clocks) {
        const segmentStart = clock.segmentStart - info.start + elapsed
        const earliestOrigin = clock.segmentMinimum - info.start + elapsed

        if (clock.isAv1) {
          if (clock.start === Infinity) {
            clock.decodeStartUnits = Math.round(segmentStart * clock.timescale)
          }

          // Independently rounding the starting PTS and cumulative decode
          // durations can differ from rounding the final PTS by one tick.
          const earliest = Math.round(earliestOrigin * clock.timescale)
          const latest = Math.round(
            (clock.segmentMaximum - info.start + elapsed) * clock.timescale,
          )

          if (
            earliest < clock.decodeStartUnits - 1 ||
            latest > clock.decodeStartUnits + 1
          ) {
            throw createRemuxError(
              REMUX_ERROR_CODE.unsupportedMediaFeature,
              'AV1 timeline requires composition offsets or a decode discontinuity.',
            )
          }
        } else {
          clock.decodeStartUnits = Math.min(
            clock.decodeStartUnits,
            Math.floor(earliestOrigin * clock.timescale),
          )
        }

        clock.segmentMinimum = Infinity
        clock.segmentMaximum = -Infinity
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
            presentationStart: clock.start,
            presentationEnd: clock.end,
          },
        ]),
      )
    },
  }
}

/** Bounded decode-clock state carried across all segment preflight scans. */
export type DecodeTimeline = ReturnType<typeof createDecodeTimeline>
