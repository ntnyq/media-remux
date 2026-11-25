/* oxlint-disable no-await-in-loop -- Replay uncertain track timing in decode order with bounded memory. */

import { isUndefined } from '@ntnyq/utils'
import {
  PACKET_TYPE,
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_ERROR_CODE,
} from '../constants'
import type {
  DecodeTimeline,
  OutputSegment,
  PacketTrack,
  SegmentPlan,
} from '../types'
import { checkAbort, createRemuxError } from '../utils'
import {
  GLOBAL_TIMESCALE,
  MAX_MP4_UINT32,
  intoTimescale,
  quantizeAv1SampleTiming,
  quantizeDecodeDuration,
  validateMp4CompositionOffset,
  validateMp4SampleDuration,
} from '../vendor/mediabunny/src/isobmff/isobmff-muxer'
import type { IsobmffTrackTiming } from '../vendor/mediabunny/src/output-format'
import type { EncodedPacket } from '../vendor/mediabunny/src/packet'

/**
 * Plans decode clocks without retaining individual packet metadata.
 * The earliest PTS minus elapsed decode time determines each track's required
 * decode lead. AV1 matches presentation time and permits forward jumps at
 * keyframes to represent gaps with a new fragment decode base.
 *
 * @param outputTracks - Output tracks in muxer order; video uses the default MP4 timescale.
 * @returns A bounded accumulator shared by segment inspections and output setup.
 */
export function createDecodeTimeline(
  outputTracks: PacketTrack[],
): DecodeTimeline {
  const clocks = outputTracks.map(track => ({
    isAv1: track.codec === MEDIA_CODEC.av1,
    isAudio: track.kind === MEDIA_TRACK_KIND.audio,
    timescale:
      track.kind === MEDIA_TRACK_KIND.audio
        ? track.config.sampleRate
        : GLOBAL_TIMESCALE,
    accumulatedDecodeTicks: 0,
    decodeTickRemainder: 0,
    decodeStartTicks: 0,
    sourceDecodeStart: undefined as number | undefined,
    segmentMinimumDecodeOrigin: Infinity,
    segmentMaximumDecodeOrigin: -Infinity,
    minimumDecodeOrigin: Infinity,
    maximumDecodeOrigin: -Infinity,
    largestAv1DecodeDuration: 0,
    largestSourceTime: 0,
    segmentStart: Infinity,
    segmentEnd: -Infinity,
    segmentLastAv1Timestamp: -Infinity,
    segmentAv1DecodeEnd: -Infinity,
    av1DecodeEnd: -Infinity,
    hasLeadingTrim: false,
    start: Infinity,
    end: -Infinity,
  }))
  let elapsedPresentationSeconds = 0

  return {
    /**
     * Records one packet in decode order using the muxer's duration quantization.
     *
     * @param index - Zero-based output track position.
     * @param packet - Packet retaining the source decode duration.
     * @param presentationStart - Visible start after any track-level audio edit.
     * @returns Nothing.
     * @throws If source decode timing is missing, invalid, or exceeds the MP4 sample duration field.
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

      clock.largestSourceTime = Math.max(
        clock.largestSourceTime,
        Math.abs(packet.timestamp),
      )

      if (clock.isAv1) {
        const tick = 1 / clock.timescale
        const gap = packet.timestamp - clock.segmentAv1DecodeEnd

        if (
          packet.timestamp < clock.segmentLastAv1Timestamp ||
          gap < -tick ||
          (gap > tick && packet.type !== PACKET_TYPE.key)
        ) {
          throw createRemuxError(
            REMUX_ERROR_CODE.unsupportedMediaFeature,
            'AV1 decode time must match presentation time with gaps only at keyframes.',
          )
        }

        clock.segmentLastAv1Timestamp = packet.timestamp
        clock.segmentAv1DecodeEnd = packet.timestamp + duration
        clock.largestAv1DecodeDuration = Math.max(
          clock.largestAv1DecodeDuration,
          duration,
        )
      } else {
        const decodeOrigin =
          packet.timestamp - clock.accumulatedDecodeTicks / clock.timescale
        const quantized = quantizeDecodeDuration(
          duration,
          clock.timescale,
          clock.decodeTickRemainder,
        )

        validateMp4SampleDuration(quantized.ticks)

        // Use the source DTS when available. Later segments keep the output's
        // continuous clock, using source DTS deltas for each sample.
        if (clock.start === Infinity && clock.segmentStart === Infinity) {
          clock.sourceDecodeStart = packet.sideData.decodeTimestamp
        }

        clock.segmentMinimumDecodeOrigin = Math.min(
          clock.segmentMinimumDecodeOrigin,
          decodeOrigin,
        )
        clock.segmentMaximumDecodeOrigin = Math.max(
          clock.segmentMaximumDecodeOrigin,
          decodeOrigin,
        )
        clock.decodeTickRemainder = quantized.remainder
        clock.accumulatedDecodeTicks += quantized.ticks
      }

      clock.hasLeadingTrim ||= presentationStart > packet.timestamp
      clock.segmentStart = Math.min(clock.segmentStart, presentationStart)
      clock.segmentEnd = Math.max(
        clock.segmentEnd,
        packet.timestamp + packet.duration,
      )
    },

    /**
     * Applies the segment's presentation shifts to its decode constraints.
     *
     * @param plan - Validated shared presentation origin and span, in seconds.
     * @param unshiftedStart - Earliest playable timestamp before track alignment.
     * @returns Nothing.
     * @throws If the output duration cannot be represented exactly in movie ticks
     * or AV1 decode time overlaps between segments.
     */
    finishSegment(plan: SegmentPlan, unshiftedStart: number) {
      const segmentEnd = elapsedPresentationSeconds + plan.duration

      if (!Number.isSafeInteger(intoTimescale(segmentEnd, GLOBAL_TIMESCALE))) {
        throw createRemuxError(
          REMUX_ERROR_CODE.invalidInput,
          'Output duration is outside the supported MP4 movie clock range.',
        )
      }

      for (const [index, clock] of clocks.entries()) {
        if (clock.segmentStart === Infinity) {
          // Audio can end before a trimmed segment's video starts.
          continue
        }

        const origin = plan.trackOrigins?.[index] ?? plan.start
        const segmentStart =
          clock.segmentStart - origin + elapsedPresentationSeconds

        clock.largestSourceTime = Math.max(
          clock.largestSourceTime,
          Math.abs(origin),
        )

        if (clock.isAv1) {
          if (clock.av1DecodeEnd - segmentStart > 1 / clock.timescale) {
            throw createRemuxError(
              REMUX_ERROR_CODE.unsupportedMediaFeature,
              'AV1 decode time overlaps the previous segment.',
            )
          }

          clock.av1DecodeEnd =
            clock.segmentAv1DecodeEnd - origin + elapsedPresentationSeconds
          clock.segmentAv1DecodeEnd = -Infinity
          clock.segmentLastAv1Timestamp = -Infinity
        } else {
          const earliestOrigin =
            clock.segmentMinimumDecodeOrigin -
            origin +
            elapsedPresentationSeconds
          const latestOrigin =
            clock.segmentMaximumDecodeOrigin -
            origin +
            elapsedPresentationSeconds

          clock.minimumDecodeOrigin = Math.min(
            clock.minimumDecodeOrigin,
            earliestOrigin,
          )
          clock.maximumDecodeOrigin = Math.max(
            clock.maximumDecodeOrigin,
            latestOrigin,
          )

          const sourceOrigin = clock.sourceDecodeStart
          // Shift the inferred decode start by the same amount as presentation.
          const shiftTicks = Math.round(
            (unshiftedStart - origin) * clock.timescale,
          )
          const decodeStartTicks = isUndefined(sourceOrigin)
            ? clock.decodeStartTicks + shiftTicks
            : Math.round(
                (sourceOrigin - origin + elapsedPresentationSeconds) *
                  clock.timescale,
              )
          // The muxer rounds composition offsets to the nearest tick. A PTS
          // fractionally before DTS can still have a zero encoded offset.
          const earliestTicks = Math.min(
            Math.floor(earliestOrigin * clock.timescale + 0.5 - 1e-7),
            Math.floor(Math.min(clock.start, segmentStart) * clock.timescale),
          )

          clock.decodeStartTicks = Math.min(decodeStartTicks, earliestTicks)
          clock.sourceDecodeStart = undefined
        }

        clock.segmentMinimumDecodeOrigin = Infinity
        clock.segmentMaximumDecodeOrigin = -Infinity
        clock.start = Math.min(clock.start, segmentStart)
        clock.end = Math.max(
          clock.end,
          clock.segmentEnd - origin + elapsedPresentationSeconds,
        )
        clock.segmentStart = Infinity
        clock.segmentEnd = -Infinity
      }

      elapsedPresentationSeconds = segmentEnd
    },

    /**
     * Checks 32-bit MP4 fields that depend on the final output timeline.
     * The first scan bounds these fields. Tracks close to a limit are replayed
     * with the muxer's exact rounding and final decode start.
     *
     * @param segments - Opens the inspected segments for metadata-only replay when needed.
     * @param signal - Optional cancellation signal checked during replay.
     * @returns A promise resolving when all copied tracks fit the MP4 fields.
     * @throws If a quantized field exceeds its MP4 range, packet reading fails, or reading is aborted.
     */
    async validateSampleTiming(
      segments: () => AsyncIterable<OutputSegment>,
      signal?: AbortSignal,
    ) {
      const uncertainTracks = clocks.flatMap((clock, index) => {
        if (clock.start === Infinity) {
          return []
        }

        const { timescale } = clock
        const decodeStart = clock.isAv1
          ? clock.start
          : clock.decodeStartTicks / timescale
        const timestampOffset = clock.isAudio
          ? decodeStart
          : Math.min(decodeStart, 0)
        const decodeTicks = intoTimescale(decodeStart, timescale)
        // Allow for rounding in the source shift, tick-to-second conversion,
        // and subtraction of the track's media origin in the muxer.
        const roundingMargin =
          16 *
          Number.EPSILON *
          Math.max(
            1,
            clock.largestSourceTime,
            clock.largestAv1DecodeDuration,
            clock.accumulatedDecodeTicks / timescale,
            Math.abs(decodeStart),
            elapsedPresentationSeconds,
          ) *
          timescale
        const minComposition = intoTimescale(
          clock.minimumDecodeOrigin - decodeStart,
          timescale,
          false,
        )
        const maxComposition = intoTimescale(
          clock.maximumDecodeOrigin - decodeStart,
          timescale,
          false,
        )
        const needsReplay = clock.isAv1
          ? intoTimescale(clock.largestAv1DecodeDuration, timescale, false) +
              1 +
              roundingMargin >
            MAX_MP4_UINT32
          : minComposition < -0.5 + roundingMargin ||
            maxComposition >= MAX_MP4_UINT32 + 0.5 - roundingMargin ||
            !Number.isSafeInteger(
              Math.abs(decodeTicks) + clock.accumulatedDecodeTicks,
            )

        return needsReplay
          ? [
              {
                index,
                timescale,
                isAv1: clock.isAv1,
                timestampOffset,
                decodeTicks,
                decodeTickRemainder: 0,
              },
            ]
          : []
      })

      if (uncertainTracks.length === 0) {
        return
      }

      let segmentOffset = 0

      for await (const { tracks, plan } of segments()) {
        for (const clock of uncertainTracks) {
          const track = tracks[clock.index]

          if (!track) {
            continue
          }

          const { timescale, timestampOffset } = clock
          const origin = plan.trackOrigins?.[clock.index] ?? plan.start

          for await (const packet of track.packets(
            true,
            plan.skippedPackets?.[clock.index],
          )) {
            checkAbort(signal)

            const timestamp = packet.timestamp - origin + segmentOffset
            const duration = packet.sideData.decodeDuration!

            if (clock.isAv1) {
              validateMp4SampleDuration(
                quantizeAv1SampleTiming(timestamp, duration, timescale)
                  .durationTicks,
              )
            } else {
              const decodeTimestamp = clock.decodeTicks / timescale
              const composition =
                timestamp -
                timestampOffset -
                (decodeTimestamp - timestampOffset)

              validateMp4CompositionOffset(
                intoTimescale(composition, timescale),
                true,
              )

              const quantized = quantizeDecodeDuration(
                duration,
                timescale,
                clock.decodeTickRemainder,
              )

              clock.decodeTicks += quantized.ticks
              clock.decodeTickRemainder = quantized.remainder
            }
          }
        }

        segmentOffset += plan.duration
      }
    },

    /**
     * Snapshots decode origins and presentation bounds for tracks with retained packets.
     * Negative starts use a media edit. AV1 may begin at a positive tfdt.
     *
     * @returns Track IDs mapped to decode and presentation timing in seconds.
     */
    trackTimings(): Map<number, IsobmffTrackTiming> {
      const timings = new Map<number, IsobmffTrackTiming>()

      for (const [index, clock] of clocks.entries()) {
        if (clock.start !== Infinity) {
          timings.set(index + 1, {
            decodeStart: clock.isAv1
              ? clock.start
              : clock.decodeStartTicks / clock.timescale,
            presentationStart: clock.start,
            presentationEnd: clock.end,
            ...(clock.hasLeadingTrim ? { hasLeadingTrim: true } : {}),
          })
        }
      }

      return timings
    },
  }
}
