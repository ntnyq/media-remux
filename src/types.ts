import type { ValueOf } from '@ntnyq/utils'
import type {
  REMUX_MIME_TYPE,
  REMUX_PROGRESS_PHASE,
  REMUX_TRACK_SELECTION,
} from './constants'
import type { FragmentIndexStore } from './storage/fragmentIndex'
import type { FragmentSampleStore } from './storage/fragmentSamples'

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
 * Caller-owned temporary stores; dispose them after every job.
 */
export interface RemuxStorage {
  /**
   * Per-track storage for completed-fragment TFRA index records.
   */
  fragmentIndex: FragmentIndexStore

  /**
   * Storage for sample metadata, encoded payloads, and sorted GOP timestamps.
   */
  fragmentSamples: FragmentSampleStore
}

/**
 * Progress snapshot for input inspection, packet copying, or output finalization.
 */
export interface RemuxProgress {
  /**
   * Current stage: inspect validates inputs, remux copies encoded packets, and
   * finalize writes the remaining container metadata.
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
 * Summary of a completed remux, track-combining, or concatenation operation.
 */
export interface RemuxResult {
  /**
   * Total encoded payload bytes written, excluding container headers and indexes.
   */
  bytesProcessed: number

  /**
   * Output presentation span in seconds, summed across normalized segments.
   */
  duration: number

  /**
   * video/mp4 when the output includes video, otherwise audio/mp4.
   */
  mimeType: ValueOf<typeof REMUX_MIME_TYPE>
}
