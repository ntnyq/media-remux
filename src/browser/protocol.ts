import { isFunction, isNumber, isString } from '@ntnyq/utils'
import {
  MEDIA_JOB_OPERATION,
  REMUX_MIME_TYPE,
  REMUX_PROGRESS_PHASE,
  REMUX_TRACK_SELECTION,
  WORKER_MESSAGE_TYPE,
} from '../constants'
import { isRemuxErrorCode } from '../errors'
import type { RemuxErrorCode } from '../errors'
import type { RemuxProgress, RemuxResult } from '../types'
import type { MediaJob } from './types'

/**
 * Parent-to-Worker message requesting one job with explicit output and spool handles.
 */
export interface WorkerRequest {
  /**
   * Identifies a request to execute a media job.
   */
  type: typeof WORKER_MESSAGE_TYPE.run

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
      type: typeof WORKER_MESSAGE_TYPE.progress

      /**
       * Current phase, copied payload bytes, and segment position.
       */
      progress: RemuxProgress
    }
  | {
      /**
       * Identifies successful output finalization and temporary store disposal.
       */
      type: typeof WORKER_MESSAGE_TYPE.complete

      /**
       * Completed job's duration, MIME type, and copied encoded payload byte count.
       */
      result: RemuxResult
    }
  | {
      /**
       * Identifies a terminal job failure after attempted resource cleanup.
       */
      type: typeof WORKER_MESSAGE_TYPE.error

      /**
       * Original Error name, or 'Error' when the thrown value was not an Error.
       */
      name: string

      /**
       * Failure description, including a cleanup failure suffix when applicable.
       */
      message: string

      /**
       * Stable media failure code when available.
       */
      code?: RemuxErrorCode
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
  return isNumber(value) && Number.isFinite(value) && value >= 0
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

  if (value['type'] === WORKER_MESSAGE_TYPE.error) {
    return (
      isString(value['name']) &&
      isString(value['message']) &&
      (value['code'] === undefined || isRemuxErrorCode(value['code']))
    )
  }

  if (value['type'] === WORKER_MESSAGE_TYPE.complete) {
    const { result } = value

    return (
      isRecord(result) &&
      isFiniteNumber(result['bytesProcessed']) &&
      isFiniteNumber(result['duration']) &&
      Object.values<unknown>(REMUX_MIME_TYPE).includes(result['mimeType'])
    )
  }

  const { progress } = value

  return (
    value['type'] === WORKER_MESSAGE_TYPE.progress &&
    isRecord(progress) &&
    Object.values<unknown>(REMUX_PROGRESS_PHASE).includes(progress['phase']) &&
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
  if (!isRecord(value) || value['type'] !== WORKER_MESSAGE_TYPE.run) {
    return false
  }

  const { job, handle, directory } = value

  if (
    !isRecord(job) ||
    !isRecord(handle) ||
    !isRecord(directory) ||
    !isFunction(handle['createWritable']) ||
    !isFunction(directory['getFileHandle'])
  ) {
    return false
  }

  const { tracks } = job

  if (
    tracks !== undefined &&
    !Object.values<unknown>(REMUX_TRACK_SELECTION).includes(tracks)
  ) {
    return false
  }

  if (job['operation'] === MEDIA_JOB_OPERATION.remux) {
    return job['input'] instanceof Blob
  }

  if (job['operation'] === MEDIA_JOB_OPERATION.combine) {
    return job['video'] instanceof Blob && job['audio'] instanceof Blob
  }

  return (
    job['operation'] === MEDIA_JOB_OPERATION.concat &&
    Array.isArray(job['inputs']) &&
    job['inputs'].length > 0 &&
    job['inputs'].every(input => input instanceof Blob)
  )
}
