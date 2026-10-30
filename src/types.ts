import type { FragmentIndexStore } from './storage/fragmentIndex'
import type { FragmentSampleStore } from './storage/fragmentSamples'

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
  phase: 'inspect' | 'remux' | 'finalize'

  /**
   * Cumulative encoded payload bytes copied, excluding container overhead.
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
   * Optional cancellation signal checked during inspection, copying, and storage
   * operations. Cancellation propagates the signal's original abort reason.
   */
  signal?: AbortSignal

  /**
   * Receives synchronous progress notifications. Throwing fails the job.
   *
   * @param progress - Current phase, copied payload bytes, and segment position.
   * @returns Nothing; asynchronous callback results are not awaited.
   */
  onProgress?: (progress: RemuxProgress) => void

  /**
   * Selects tracks for remux/concat. Defaults to all supported primary tracks.
   */
  tracks?: 'all' | 'audio' | 'video'
}

/**
 * Summary of a completed remux, track-combining, or concatenation operation.
 */
export interface RemuxResult {
  /**
   * Total encoded payload bytes copied, excluding container headers and indexes.
   */
  bytesProcessed: number

  /**
   * Output presentation span in seconds, summed across normalized segments.
   */
  duration: number

  /**
   * video/mp4 when the output includes video, otherwise audio/mp4.
   */
  mimeType: 'video/mp4' | 'audio/mp4'
}
