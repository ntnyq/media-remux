/* oxlint-disable no-await-in-loop -- Mux packets in decode order with stream backpressure. */

import { isUndefined } from '@ntnyq/utils'
import {
  MEDIA_CODEC,
  MEDIA_TRACK_KIND,
  REMUX_MIME_TYPE,
  REMUX_PROGRESS_PHASE,
} from '../constants'
import type {
  RemuxOptions,
  RemuxProgress,
  RemuxResult,
  RemuxStorage,
  OutputSegment,
  PacketTrack,
  SegmentPlan,
  TrackWriter,
} from '../types'
import { checkAbort } from '../utils'
import {
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
} from '../vendor/mediabunny/src/media-source'
import { Output } from '../vendor/mediabunny/src/output'
import { Mp4OutputFormat } from '../vendor/mediabunny/src/output-format'
import type { IsobmffTrackTiming } from '../vendor/mediabunny/src/output-format'
import { EncodedPacket } from '../vendor/mediabunny/src/packet'
import { StreamTarget } from '../vendor/mediabunny/src/target'
import { normalizeAudio } from './normalizeAudio'

/**
 * Wraps each temporary store operation with cancellation checks without taking
 * ownership of the underlying stores or their disposal.
 *
 * @param storage - Caller-owned fragment index and sample stores to wrap.
 * @param signal - Optional signal checked before and after successful operations.
 * @returns Store adapters whose methods always return cancellation-aware promises.
 */
function abortableStorage(
  storage: RemuxStorage,
  signal?: AbortSignal,
): RemuxStorage {
  /**
   * Runs one storage operation between cancellation checkpoints.
   *
   * @template Result - Resolved operation result.
   * @param operation - Deferred synchronous or asynchronous storage operation.
   * @returns A promise resolving to the operation result after the final check.
   * @throws The operation failure or the signal's abort reason when detected.
   */
  async function checked<Result>(
    operation: () => Result | PromiseLike<Result>,
  ): Promise<Result> {
    checkAbort(signal)
    const result = await operation()

    checkAbort(signal)

    return result
  }

  const { fragmentIndex: index, fragmentSamples: samples } = storage

  return {
    fragmentIndex: {
      /**
       * Appends index bytes between cancellation checks.
       *
       * @param args - Track ID and encoded index bytes forwarded unchanged.
       * @returns A promise resolving when the append and final check complete.
       */
      append: (...args) => checked(() => index.append(...args)),

      /**
       * Reads index bytes between cancellation checks.
       *
       * @param args - Track ID, byte offset, and bounded byte length.
       * @returns A promise resolving to the requested index bytes.
       */
      read: (...args) => checked(() => index.read(...args)),
    },
    fragmentSamples: {
      /**
       * Appends a sample between cancellation checks.
       *
       * @param args - Track ID, sample descriptor, and encoded payload.
       * @returns A promise resolving to the assigned logical sample ID.
       */
      append: (...args) => checked(() => samples.append(...args)),

      /**
       * Retrieves sample metadata between cancellation checks.
       *
       * @param args - Track ID and retained logical sample ID.
       * @returns A promise resolving to the stored sample descriptor.
       */
      get: (...args) => checked(() => samples.get(...args)),

      /**
       * Updates sample metadata between cancellation checks.
       *
       * @param args - Track ID, logical sample ID, and replacement descriptor.
       * @returns A promise resolving after the update and final check.
       */
      set: (...args) => checked(() => samples.set(...args)),

      /**
       * Prepares sorted timestamps between cancellation checks.
       *
       * @param args - Track ID, first sample ID, and sample count.
       * @returns A promise resolving when the sorted range is ready.
       */
      sort: (...args) => checked(() => samples.sort(...args)),

      /**
       * Retrieves a sorted timestamp between cancellation checks.
       *
       * @param args - Track ID and zero-based position in its sorted range.
       * @returns A promise resolving to a presentation timestamp in seconds.
       */
      sorted: (...args) => checked(() => samples.sorted(...args)),

      /**
       * Reads encoded payload bytes between cancellation checks.
       *
       * @param args - Track ID, logical media offset, and bounded byte length.
       * @returns A promise resolving to the requested encoded payload bytes.
       */
      readMedia: (...args) => checked(() => samples.readMedia(...args)),

      /**
       * Releases a sample prefix between cancellation checks.
       *
       * @param args - Track ID and exclusive logical sample ID boundary.
       * @returns A promise resolving after release and the final check.
       */
      release: (...args) => checked(() => samples.release(...args)),
    },
  }
}

/**
 * Writes compatible encoded segments as fragmented MP4/M4A with backpressure.
 * Each segment's earliest presentation timestamp is shifted to the preceding
 * segment's end, preserving internal A/V offsets and each track's decode order.
 * Success finalizes and closes the output; failures attempt output cancellation.
 * The caller owns input disposal and temporary store disposal.
 *
 * @param outputTrackTemplates - Ordered output tracks defining codec configurations and
 * optional video transforms.
 * @param segments - Opens an independent pass over the inspected segments.
 * @param options - Positioned output stream, fresh temporary stores, optional
 * cancellation signal, and progress callback. Track selection is already applied.
 * @param trackTimings - Preflight timing keyed by one-based output track ID.
 * @param totalDuration - Combined presentation span in seconds.
 * @returns A promise resolving to the total duration in seconds, output MIME
 * type, and encoded payload bytes written, excluding container overhead.
 * @throws If packet, muxing, storage, stream, or progress callback failures occur.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function writeSegments(
  outputTrackTemplates: PacketTrack[],
  segments: () => AsyncIterable<OutputSegment>,
  options: RemuxOptions,
  trackTimings: Map<number, IsobmffTrackTiming>,
  totalDuration: number,
): Promise<RemuxResult> {
  checkAbort(options.signal)

  let isCommitting = false
  const storage = abortableStorage(options.storage, options.signal)
  const audioIndex = outputTrackTemplates.findIndex(
    track => track.kind === MEDIA_TRACK_KIND.audio,
  )
  const normalizedAudio =
    options.normalizeAudio && audioIndex !== -1
      ? await normalizeAudio(
          segments(),
          totalDuration,
          storage.fragmentSamples,
          options.signal,
        )
      : undefined
  const audioPackets = normalizedAudio?.packets()
  let pendingAudio: IteratorResult<EncodedPacket, void> | undefined

  if (normalizedAudio) {
    trackTimings.set(audioIndex + 1, normalizedAudio.timing)
  }

  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: 2,
      _fragmentIndexStore: storage.fragmentIndex,
      _fragmentSampleStore: storage.fragmentSamples,
      _fragmentTrackTimings: trackTimings,
      _fragmentedEmptyMediaHeaders: !isUndefined(normalizedAudio),
    }),
    target: new StreamTarget(options.writable, {
      chunked: true,
      chunkSize: 1024 * 1024,
      _signal: options.signal,
      _beforeClose() {
        checkAbort(options.signal)
        isCommitting = true
      },
    }),
  })

  let bytesProcessed = 0
  let duration = 0
  let segmentIndex = 0
  const writers = new Map<number, TrackWriter>()

  /**
   * Checks cancellation and reports the current muxing counters.
   *
   * @param phase - Remux or finalization phase to report.
   * @returns Nothing when no callback is supplied or notification succeeds.
   * @throws The signal's abort reason or a progress callback failure.
   */
  const progress = (phase: RemuxProgress['phase']) => {
    checkAbort(options.signal)
    options.onProgress?.({ phase, bytesProcessed, segmentIndex })
  }

  /**
   * Supplies the continuous encoded audio packets that start in this segment.
   *
   * @param plan - Segment presentation start and duration in seconds.
   * @param isLast - Whether to drain all remaining audio packets for this segment.
   * @yields Normalized audio packets on the segment's shared time base.
   */
  async function* segmentAudio(plan: SegmentPlan, isLast: boolean) {
    if (!audioPackets) {
      return
    }

    pendingAudio ??= await audioPackets.next()

    const end = isLast ? Infinity : duration + plan.duration

    while (!pendingAudio.done && pendingAudio.value.timestamp < end) {
      const packet = pendingAudio.value

      yield packet.clone({
        timestamp: packet.timestamp - duration + plan.start,
      })
      pendingAudio = await audioPackets.next()
    }
  }

  /**
   * Interleaves a segment's tracks while preserving decode order within each
   * track, normalizing timestamps, and closing every iterator on exit.
   *
   * @param segment - Ordered tracks and validated shared presentation timeline.
   * @returns A promise resolving after every available packet has been copied.
   * @throws If packet iteration, writing, progress reporting, or cancellation fails.
   */
  async function writeSegment(segment: OutputSegment) {
    const cursors = segment.tracks.flatMap((track, index) => {
      const writer = writers.get(index)

      return !writer ||
        (normalizedAudio && track.kind === MEDIA_TRACK_KIND.audio)
        ? []
        : [
            {
              iterator: track.packets(
                false,
                segment.plan.skippedPackets?.[index],
              ),
              writer,
              origin: segment.plan.trackOrigins?.[index] ?? segment.plan.start,
              next: undefined as
                | IteratorResult<EncodedPacket, void>
                | undefined,
            },
          ]
    })

    const normalizedWriter = normalizedAudio && writers.get(audioIndex)

    if (normalizedWriter) {
      cursors.push({
        iterator: segmentAudio(segment.plan, segment.isLast),
        writer: normalizedWriter,
        origin: segment.plan.start,
        next: undefined,
      })
    }

    /**
     * Advances one track and closes its writer if no later segment can use it.
     *
     * @param cursor - Packet iterator and associated output writer.
     * @returns A promise resolving when the cursor has advanced and any required
     * writer closure has been requested.
     */
    async function advance(cursor: (typeof cursors)[number]) {
      cursor.next = await cursor.iterator.next()

      if (cursor.next.done && segment.isLast) {
        cursor.writer.close()
      }
    }

    try {
      for (const cursor of cursors) {
        await advance(cursor)
      }

      while (true) {
        checkAbort(options.signal)

        // Only compare the next packet of each track, preserving each track's decode order.
        const [cursor] = cursors
          .filter(entry => entry.next && !entry.next.done)
          .toSorted(
            (left, right) =>
              (left.next?.value?.timestamp ?? 0) -
              (right.next?.value?.timestamp ?? 0) -
              (left.origin - right.origin),
          )

        if (!cursor || !cursor.next || cursor.next.done) {
          break
        }

        const packet = cursor.next.value

        // The inspected origin maps source time to the segment start.
        await cursor.writer.add(
          new EncodedPacket(
            packet.data,
            packet.type,
            packet.timestamp - cursor.origin + duration,
            packet.duration,
            packet.sequenceNumber,
            packet.byteLength,
            packet.sideData,
          ),
        )
        bytesProcessed += packet.byteLength
        progress(REMUX_PROGRESS_PHASE.remux)

        await advance(cursor)
      }
    } finally {
      await Promise.all(cursors.map(cursor => cursor.iterator.return()))
    }
  }

  try {
    for (const [index, track] of outputTrackTemplates.entries()) {
      // Video is required to have retained packets. The trailing audio track
      // can be fully trimmed when video advances to its first usable keyframe.
      if (!trackTimings.has(index + 1)) {
        continue
      }

      if (track.kind === MEDIA_TRACK_KIND.video) {
        const { config, codec } = track
        const source = new EncodedVideoPacketSource(codec)

        output.addVideoTrack(source, {
          decoderConfig: config,
          ...(track.matrix ? { transformationMatrix: track.matrix } : {}),
          ...(track.containerColorInformation && {
            containerColorInformation: track.containerColorInformation,
          }),
        })

        writers.set(index, {
          /**
           * Adds a normalized video packet with the output decoder configuration.
           *
           * @param packet - Encoded video packet to copy into the output.
           * @returns A promise resolving when the video source accepts the packet.
           */
          add: packet => source.add(packet, { decoderConfig: config }),

          /**
           * Marks the video source complete.
           *
           * @returns Nothing.
           */
          close: () => source.close(),
        })
      } else {
        const codec = normalizedAudio ? MEDIA_CODEC.aac : track.codec
        const config = normalizedAudio?.config ?? track.config
        const source = new EncodedAudioPacketSource(codec)

        output.addAudioTrack(source, { decoderConfig: config })

        writers.set(index, {
          /**
           * Adds a normalized audio packet with the output decoder configuration.
           *
           * @param packet - Encoded audio packet to copy into the output.
           * @returns A promise resolving when the audio source accepts the packet.
           */
          add: packet => source.add(packet, { decoderConfig: config }),

          /**
           * Marks the audio source complete.
           *
           * @returns Nothing.
           */
          close: () => source.close(),
        })
      }
    }

    await output.start()

    for await (const segment of segments()) {
      await writeSegment(segment)
      duration += segment.plan.duration
      segmentIndex++
    }

    progress(REMUX_PROGRESS_PHASE.finalize)
    await output.finalize()

    return {
      bytesProcessed,
      duration,
      mimeType: outputTrackTemplates.some(
        track => track.kind === MEDIA_TRACK_KIND.video,
      )
        ? REMUX_MIME_TYPE.video
        : REMUX_MIME_TYPE.audio,
    }
  } catch (error) {
    try {
      await output.cancel()
    } catch {
      // Preserve the write failure; cancellation is best-effort cleanup.
    }

    if (!isCommitting) {
      checkAbort(options.signal)
    }

    throw error
  } finally {
    await audioPackets?.return()
  }
}
