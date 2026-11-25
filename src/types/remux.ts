import type { ValueOf } from '@ntnyq/utils'
import type {
  REMUX_MIME_TYPE,
  REMUX_PROGRESS_PHASE,
  REMUX_TRACK_SELECTION,
} from '../constants'
import type { RemuxStorage } from './storage'

/**
 * One MPEG-TS stream assembled from ordered, packet-aligned segments.
 */
export interface MpegTsInput {
  /**
   * Immutable media bytes, for example a File read from OPFS.
   */
  blob: Blob

  /**
   * Absolute segment starts in bytes, including zero. Offsets must be strictly
   * increasing multiples of 188 below the Blob size.
   */
  segmentOffsets: readonly number[]

  /**
   * Allow a new continuity counter on a selected PID's first payload in a
   * segment when it starts a valid PES and the preceding PES is complete.
   * Defaults to false. A missing whole packet at such a boundary may be
   * indistinguishable from a reset.
   */
  allowContinuityCounterReset?: boolean
}

/**
 * A complete media Blob or an MPEG-TS stream with explicit segment starts.
 */
export type RemuxInput = Blob | MpegTsInput

/**
 * Primary tracks to retain when remuxing or concatenating.
 * Both optional-audio modes require video in every input. The first-track mode
 * selects video and audio in file order.
 */
export type RemuxTrackSelection = ValueOf<typeof REMUX_TRACK_SELECTION>

/**
 * A positioned output write. Awaiting write applies backpressure.
 */
export interface MediaOutputChunk {
  /**
   * Identifies a positioned write compatible with filesystem writable streams.
   */
  type: 'write'

  /**
   * Absolute byte offset in the output file at which to write the chunk.
   */
  position: number

  /**
   * Encoded container bytes to write at position.
   */
  data: Uint8Array<ArrayBuffer>
}

/**
 * Progress snapshot for input inspection, packet writing, or output finalization.
 */
export interface RemuxProgress {
  /**
   * Current stage of input validation, encoded packet writing, or container
   * finalization.
   */
  phase: ValueOf<typeof REMUX_PROGRESS_PHASE>

  /**
   * Cumulative encoded payload bytes written, excluding container overhead.
   */
  bytesProcessed: number

  /**
   * Zero-based segment index during inspection or remuxing. During finalization
   * this is the number of segments already written.
   */
  segmentIndex: number
}

/**
 * Output destination, caller-owned temporary stores, and hooks for a core job.
 * Top-level fields are captured when the job starts; the referenced signal and
 * storage resources remain live and caller-owned.
 */
export interface RemuxOptions {
  /**
   * Destination for positioned container writes. Writes apply backpressure;
   * successful finalization closes the stream.
   */
  writable: WritableStream<MediaOutputChunk>

  /**
   * Fresh temporary stores reserved for this job. The caller must dispose them
   * after success, failure, or cancellation.
   */
  storage: RemuxStorage

  /**
   * Optional cancellation signal checked during inspection, copying, storage,
   * and immediately before committing the output stream. Cancellation before
   * commit propagates the signal's original abort reason.
   */
  signal?: AbortSignal

  /**
   * Receives synchronous progress notifications. Throwing fails the job.
   *
   * @param progress - Current phase, encoded payload bytes, and segment position.
   * @returns Nothing; asynchronous callback results are not awaited.
   */
  onProgress?: (progress: RemuxProgress) => void

  /**
   * Selects tracks for remux/concat. Defaults to all supported primary tracks.
   */
  tracks?: RemuxTrackSelection

  /**
   * Normalize selected mono/stereo audio to one continuous AAC-LC track using
   * WebCodecs. Video is copied. Defaults to copying the selected audio packets.
   */
  normalizeAudio?: boolean
}

/**
 * Aligns the earliest playable video and audio timestamps at zero, or adds
 * signed offsets in seconds before normalizing the earliest track to zero.
 */
export type CombineTimeline =
  | 'align-starts'
  | {
      /**
       * Seconds to add to video timing. Defaults to zero.
       */
      videoOffset?: number

      /**
       * Seconds to add to audio timing. Defaults to zero.
       */
      audioOffset?: number
    }

/**
 * Output and timeline options for combining separate video and audio inputs.
 */
export interface CombineOptions extends Omit<RemuxOptions, 'tracks'> {
  /**
   * Defaults to preserving the source relative timing.
   */
  timeline?: CombineTimeline
}

/**
 * Summary of a completed remux, track-combining, or concatenation operation.
 */
export interface RemuxResult {
  /**
   * Total encoded payload bytes written, excluding container headers and indexes.
   */
  bytesProcessed: number

  /**
   * Output presentation span in seconds. For concatenation, this is the sum of
   * the presentation spans of the inspected segments.
   */
  duration: number

  /**
   * video/mp4 when the output includes video, otherwise audio/mp4.
   */
  mimeType: ValueOf<typeof REMUX_MIME_TYPE>
}
