import { GLOBAL_TIMESCALE } from '../vendor/mediabunny/src/isobmff/isobmff-muxer'
import type { IsobmffTrackTiming } from '../vendor/mediabunny/src/output-format'
import type { EncodedPacket } from '../vendor/mediabunny/src/packet'
import type { PacketTrack } from './input/mediaInput'
import type { SegmentInfo } from './mediaTracks'

/**
 * Plans continuous decode clocks without retaining individual packet metadata.
 * The earliest PTS minus elapsed decode time determines each track's required
 * decode lead. Inspect all segments before writing the MP4 edit lists.
 *
 * @param tracks - Output tracks in muxer order; video uses the default MP4 timescale.
 * @returns A bounded accumulator shared by segment inspections and output setup.
 */
export function createDecodeTimeline(tracks: PacketTrack[]) {
  const clocks = tracks.map(track => ({
    timescale:
      'sampleRate' in track.config ? track.config.sampleRate : GLOBAL_TIMESCALE,
    units: 0,
    remainder: 0,
    minimum: 0,
    segmentMinimum: Infinity,
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
        throw new Error('Missing packet decode duration.')
      }
      clock.segmentMinimum = Math.min(
        clock.segmentMinimum,
        packet.timestamp - clock.units / clock.timescale,
      )
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
        clock.minimum = Math.min(
          clock.minimum,
          Math.floor(
            (clock.segmentMinimum - info.start + elapsed) * clock.timescale,
          ),
        )
        clock.segmentMinimum = Infinity
        clock.start = Math.min(
          clock.start,
          clock.segmentStart - info.start + elapsed,
        )
        clock.end = Math.max(clock.end, clock.segmentEnd - info.start + elapsed)
        clock.segmentStart = Infinity
        clock.segmentEnd = -Infinity
      }
      elapsed += info.duration
    },

    /**
     * Snapshots decode origins and presentation bounds for one-based track IDs.
     * Nonpositive starts are represented by a media edit and nonnegative tfdt.
     *
     * @returns Track IDs mapped to decode and presentation timing in seconds.
     */
    trackTimings(): Map<number, IsobmffTrackTiming> {
      return new Map(
        clocks.map((clock, index) => [
          index + 1,
          {
            decodeStart: clock.minimum / clock.timescale,
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
