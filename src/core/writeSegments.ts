/* oxlint-disable no-await-in-loop -- Mux packets in decode order with stream backpressure. */
import { checkAbort } from '../abort'
import type {
  RemuxOptions,
  RemuxProgress,
  RemuxResult,
  RemuxStorage,
} from '../types'
import {
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
} from '../vendor/mediabunny/src/media-source'
import { Output } from '../vendor/mediabunny/src/output'
import { Mp4OutputFormat } from '../vendor/mediabunny/src/output-format'
import type { IsobmffTrackTiming } from '../vendor/mediabunny/src/output-format'
import { EncodedPacket } from '../vendor/mediabunny/src/packet'
import { StreamTarget } from '../vendor/mediabunny/src/target'
import type { PacketTrack } from './input/mediaInput'
import type { SegmentInfo } from './mediaTracks'

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

interface TrackWriter {
  /**
   * Sends a packet to its configured encoded media source.
   *
   * @param packet - Encoded packet with normalized output presentation timing.
   * @returns A promise resolving when the source accepts the packet.
   */
  add: (packet: EncodedPacket) => Promise<void>

  /**
   * Marks the encoded source complete before muxer finalization.
   *
   * @returns Nothing.
   */
  close: () => void
}

/**
 * Writes compatible encoded segments as fragmented MP4/M4A with backpressure.
 * Each segment's earliest presentation timestamp is shifted to the preceding
 * segment's end, preserving internal A/V offsets and each track's decode order.
 * Success finalizes and closes the output; failures attempt output cancellation.
 * The caller owns input disposal and temporary store disposal.
 *
 * @param baseline - Ordered output tracks defining H.264/AAC configurations and
 * optional video transforms; kinds must match their decoder configurations.
 * @param segments - Segments in playback order, with validated timing in seconds
 * and tracks matching the baseline's order and configurations.
 * @param options - Positioned output stream, fresh temporary stores, optional
 * cancellation signal, and progress callback. Track selection is already applied.
 * @param trackTimings - Preflight timing keyed by one-based output track ID.
 * @returns A promise resolving to the total duration in seconds, output MIME
 * type, and copied encoded payload bytes excluding container overhead.
 * @throws {Error} If a baseline kind disagrees with its decoder configuration.
 * Also propagates packet, muxing, storage, stream, and progress callback failures.
 * @throws The signal's abort reason if cancellation is detected.
 */
export async function writeSegments(
  baseline: PacketTrack[],
  segments: AsyncIterable<{ tracks: PacketTrack[]; info: SegmentInfo }>,
  options: RemuxOptions,
  trackTimings: ReadonlyMap<number, IsobmffTrackTiming>,
): Promise<RemuxResult> {
  checkAbort(options.signal)

  const storage = abortableStorage(options.storage, options.signal)
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: 2,
      _fragmentIndexStore: storage.fragmentIndex,
      _fragmentSampleStore: storage.fragmentSamples,
      _fragmentTrackTimings: trackTimings,
    }),
    target: new StreamTarget(options.writable, {
      chunked: true,
      chunkSize: 1024 * 1024,
    }),
  })

  let bytesProcessed = 0
  let duration = 0
  let segmentIndex = 0
  const writers: TrackWriter[] = []

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
   * Interleaves a segment's tracks while preserving decode order within each
   * track, normalizing timestamps, and closing every iterator on exit.
   *
   * @param segment - Ordered tracks and validated shared presentation timeline.
   * @returns A promise resolving after every available packet has been copied.
   * @throws If packet iteration, writing, progress reporting, or cancellation fails.
   */
  async function writeSegment(segment: {
    tracks: PacketTrack[]
    info: SegmentInfo
  }) {
    const cursors = segment.tracks.map((track, index) => ({
      iterator: track.packets(),
      writer: writers[index],
      next: undefined as IteratorResult<EncodedPacket, void> | undefined,
    }))

    try {
      for (const cursor of cursors) {
        cursor.next = await cursor.iterator.next()
      }

      while (true) {
        checkAbort(options.signal)

        // Only compare the next packet of each track, preserving each track's decode order.
        const [cursor] = cursors
          .filter(entry => entry.next && !entry.next.done)
          .toSorted(
            (left, right) =>
              (left.next?.value?.timestamp ?? 0) -
              (right.next?.value?.timestamp ?? 0),
          )
        if (!cursor || !cursor.next || cursor.next.done || !cursor.writer) {
          break
        }

        const packet = cursor.next.value

        // Apply one shared shift to every track in this segment, preserving A/V
        // offsets while placing its earliest presentation time after prior segments.
        await cursor.writer.add(
          new EncodedPacket(
            packet.data,
            packet.type,
            packet.timestamp - segment.info.start + duration,
            packet.duration,
            packet.sequenceNumber,
            packet.byteLength,
            packet.sideData,
          ),
        )
        bytesProcessed += packet.byteLength
        progress('remux')

        cursor.next = await cursor.iterator.next()
      }
    } finally {
      await Promise.all(cursors.map(cursor => cursor.iterator.return()))
    }
  }

  try {
    for (const track of baseline) {
      if (track.kind === 'video' && !('sampleRate' in track.config)) {
        const { config } = track
        const source = new EncodedVideoPacketSource('avc')

        output.addVideoTrack(source, {
          decoderConfig: config,
          ...(track.matrix ? { transformationMatrix: track.matrix } : {}),
        })

        writers.push({
          /**
           * Adds a normalized H.264 packet with the baseline decoder configuration.
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
      } else if (track.kind === 'audio' && 'sampleRate' in track.config) {
        const { config } = track
        const source = new EncodedAudioPacketSource('aac')

        output.addAudioTrack(source, { decoderConfig: config })

        writers.push({
          /**
           * Adds a normalized AAC packet with the baseline decoder configuration.
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
      } else {
        throw new Error('Track kind does not match its decoder configuration.')
      }
    }

    await output.start()

    for await (const segment of segments) {
      await writeSegment(segment)
      duration += segment.info.duration
      segmentIndex++
    }

    for (const writer of writers) {
      writer.close()
    }

    progress('finalize')
    await output.finalize()
    checkAbort(options.signal)

    return {
      bytesProcessed,
      duration,
      mimeType: baseline.some(track => track.kind === 'video')
        ? 'video/mp4'
        : 'audio/mp4',
    }
  } catch (error) {
    try {
      await output.cancel()
    } catch {
      // Preserve the write failure; cancellation is best-effort cleanup.
    }

    checkAbort(options.signal)
    throw error
  }
}
