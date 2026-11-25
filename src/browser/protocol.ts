import {
  isBoolean,
  isFunction,
  isNonEmptyArray,
  isNonEmptyString,
  isNull,
  isNumber,
  isObject,
  isString,
  isUndefined,
} from '@ntnyq/utils'
import {
  MEDIA_JOB_OPERATION,
  REMUX_MIME_TYPE,
  REMUX_PROGRESS_PHASE,
  REMUX_TRACK_SELECTION,
  WORKER_MESSAGE_TYPE,
} from '../constants'
import type { WorkerRequest, WorkerResponse } from '../types'
import { isRemuxErrorCode } from '../utils'
import { parseCombineTimeline } from '../utils/combineTimeline'
import { isMpegTsInput } from '../utils/remuxInput'

/**
 * Checks whether an untrusted value can be inspected for protocol properties.
 *
 * @param value - Unknown message or nested payload.
 * @returns Whether the value is a non-null object, including arrays.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !isFunction(value)
}

/**
 * Checks durations for finite, nonnegative values.
 *
 * @param value - Unknown protocol field.
 * @returns Whether the value is a finite number greater than or equal to zero.
 */
function isNonnegativeFiniteNumber(value: unknown): value is number {
  return isNumber(value) && Number.isFinite(value) && value >= 0
}

/**
 * Checks that a byte count or segment index is a nonnegative safe integer.
 *
 * @param value - Unknown protocol field.
 * @returns Whether the value is an exactly representable nonnegative integer.
 */
function isCounter(value: unknown): value is number {
  return isNonnegativeFiniteNumber(value) && Number.isSafeInteger(value)
}

/**
 * Checks the shape and numeric bounds of a Worker progress, completion, or error
 * response. Durations must be finite and nonnegative. Byte counts and segment
 * indices must be nonnegative safe integers.
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
      (isUndefined(value['code']) || isRemuxErrorCode(value['code']))
    )
  }

  if (value['type'] === WORKER_MESSAGE_TYPE.complete) {
    const { result } = value

    return (
      isRecord(result) &&
      isCounter(result['bytesProcessed']) &&
      isNonnegativeFiniteNumber(result['duration']) &&
      Object.values<unknown>(REMUX_MIME_TYPE).includes(result['mimeType'])
    )
  }

  const { progress } = value

  return (
    value['type'] === WORKER_MESSAGE_TYPE.progress &&
    isRecord(progress) &&
    Object.values<unknown>(REMUX_PROGRESS_PHASE).includes(progress['phase']) &&
    isCounter(progress['bytesProcessed']) &&
    isCounter(progress['segmentIndex'])
  )
}

/**
 * Checks a run request's operation, input shapes, and track and audio options.
 * Verifies either the OPFS path components or the required filesystem methods.
 * The operation verifies access permissions when it opens the job files.
 *
 * @param value - Untrusted data received by a media Worker.
 * @returns Whether the value matches a supported request, narrowing it to
 * WorkerRequest when true. Concatenation requires at least one Blob.
 */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value) || value['type'] !== WORKER_MESSAGE_TYPE.run) {
    return false
  }

  const { job, handle, directory, path } = value

  if (
    !isRecord(job) ||
    (isUndefined(path)
      ? !isRecord(handle) ||
        !isRecord(directory) ||
        !isFunction(handle['createWritable']) ||
        !isFunction(directory['getFileHandle'])
      : !isNonEmptyArray(path) ||
        [...path].some(
          component =>
            !isNonEmptyString(component) ||
            /[/\\]/u.test(component) ||
            component === '.' ||
            component === '..',
        ))
  ) {
    return false
  }

  const { tracks, normalizeAudio } = job

  if (
    (!isUndefined(tracks) &&
      !Object.values<unknown>(REMUX_TRACK_SELECTION).includes(tracks)) ||
    (!isUndefined(normalizeAudio) && !isBoolean(normalizeAudio))
  ) {
    return false
  }

  if (job['operation'] === MEDIA_JOB_OPERATION.remux) {
    return job['input'] instanceof Blob || isMpegTsInput(job['input'])
  }

  if (job['operation'] === MEDIA_JOB_OPERATION.combine) {
    return (
      !isNull(parseCombineTimeline(job['timeline'])) &&
      (job['video'] instanceof Blob || isMpegTsInput(job['video'])) &&
      (job['audio'] instanceof Blob || isMpegTsInput(job['audio']))
    )
  }

  return (
    job['operation'] === MEDIA_JOB_OPERATION.concat &&
    isNonEmptyArray(job['inputs']) &&
    !job['inputs'].includes(undefined) &&
    job['inputs'].every(input => input instanceof Blob)
  )
}
