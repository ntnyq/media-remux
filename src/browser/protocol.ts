import type { RemuxProgress, RemuxResult } from '../types'
import type { MediaJob } from './types'

/**
 * Parent-to-Worker message requesting one job with explicit output and spool handles.
 */
export interface WorkerRequest {
  /**
   * Identifies a request to execute a media job.
   */
  type: 'run'

  /**
   * Operation and source Blobs to process in the dedicated Worker.
   */
  job: MediaJob

  /**
   * Output file handle opened by the Worker as a writable stream.
   */
  handle: FileSystemFileHandle

  /**
   * Exclusive temporary spool directory for index, sample, payload, and sort files.
   * The parent owns directory removal after Worker termination.
   */
  directory: FileSystemDirectoryHandle
}

/**
 * Worker-to-parent progress, completion, or serialized failure message,
 * discriminated by type.
 */
export type WorkerResponse =
  | {
      /**
       * Identifies a nonterminal progress notification.
       */
      type: 'progress'

      /**
       * Current phase, copied payload bytes, and segment position.
       */
      progress: RemuxProgress
    }
  | {
      /**
       * Identifies successful output finalization and temporary store disposal.
       */
      type: 'complete'

      /**
       * Completed job's duration, MIME type, and copied encoded payload byte count.
       */
      result: RemuxResult
    }
  | {
      /**
       * Identifies a terminal job failure after attempted resource cleanup.
       */
      type: 'error'

      /**
       * Original Error name, or 'Error' when the thrown value was not an Error.
       */
      name: string

      /**
       * Failure description, including a cleanup failure suffix when applicable.
       */
      message: string
    }

/**
 * Checks whether an untrusted value can be inspected for protocol properties.
 *
 * @param value - Unknown message or nested payload.
 * @returns Whether the value is a non-null object, including arrays.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Checks numeric counters and durations for finite, nonnegative values.
 *
 * @param value - Unknown protocol field.
 * @returns Whether the value is a finite number greater than or equal to zero.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Checks the shape and numeric bounds of a Worker progress, completion, or error
 * response. Byte counts and durations must be finite and nonnegative; progress
 * segment indices must also be integers.
 *
 * @param value - Untrusted data received from a media Worker.
 * @returns Whether the value matches a supported response variant, narrowing it
 * to WorkerResponse when true.
 */
export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value)) {
    return false
  }

  if (value['type'] === 'error') {
    return (
      typeof value['name'] === 'string' && typeof value['message'] === 'string'
    )
  }

  if (value['type'] === 'complete') {
    const { result } = value

    return (
      isRecord(result) &&
      isFiniteNumber(result['bytesProcessed']) &&
      isFiniteNumber(result['duration']) &&
      typeof result['mimeType'] === 'string' &&
      ['video/mp4', 'audio/mp4'].includes(result['mimeType'])
    )
  }

  const { progress } = value

  return (
    value['type'] === 'progress' &&
    isRecord(progress) &&
    typeof progress['phase'] === 'string' &&
    ['inspect', 'remux', 'finalize'].includes(progress['phase']) &&
    isFiniteNumber(progress['bytesProcessed']) &&
    Number.isInteger(progress['segmentIndex']) &&
    isFiniteNumber(progress['segmentIndex'])
  )
}

/**
 * Checks a run request's operation, Blob inputs, track selection, and required
 * filesystem methods. Handles are checked structurally; access permissions and
 * actual I/O capability are left to the operation that uses them.
 *
 * @param value - Untrusted data received by a media Worker.
 * @returns Whether the value matches a supported request, narrowing it to
 * WorkerRequest when true. Concatenation requires at least one Blob.
 */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value) || value['type'] !== 'run') {
    return false
  }

  const { job, handle, directory } = value
  if (
    !isRecord(job) ||
    !isRecord(handle) ||
    !isRecord(directory) ||
    typeof handle['createWritable'] !== 'function' ||
    typeof directory['getFileHandle'] !== 'function'
  ) {
    return false
  }

  const { tracks } = job
  if (
    tracks !== undefined &&
    (typeof tracks !== 'string' || !['all', 'audio', 'video'].includes(tracks))
  ) {
    return false
  }

  if (job['operation'] === 'remux') {
    return job['input'] instanceof Blob
  }

  if (job['operation'] === 'combine') {
    return job['video'] instanceof Blob && job['audio'] instanceof Blob
  }

  return (
    job['operation'] === 'concat' &&
    Array.isArray(job['inputs']) &&
    job['inputs'].length > 0 &&
    job['inputs'].every(input => input instanceof Blob)
  )
}
