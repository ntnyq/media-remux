import {
  isFunction,
  isNull,
  isNumber,
  isRecord,
  isUndefined,
} from '@ntnyq/utils'
import type { CombineTimeline } from '../types'

/**
 * Reads and snapshots a combine timeline from public options or a Worker request.
 *
 * @param value - Unvalidated timeline mode or track offsets in seconds.
 * @returns The alignment mode or a copy of the finite offsets, undefined for the
 * default shared timeline, or null for invalid values.
 */
export function parseCombineTimeline(
  value: unknown,
): CombineTimeline | undefined | null {
  if (isUndefined(value) || value === 'align-starts') {
    return value
  }

  if (isFunction(value) || !isRecord(value)) {
    return null
  }

  const videoOffset = 'videoOffset' in value ? value['videoOffset'] : undefined
  const audioOffset = 'audioOffset' in value ? value['audioOffset'] : undefined

  if (
    (!isUndefined(videoOffset) &&
      (!isNumber(videoOffset) || !Number.isFinite(videoOffset))) ||
    (!isUndefined(audioOffset) &&
      (!isNumber(audioOffset) || !Number.isFinite(audioOffset)))
  ) {
    return null
  }

  return {
    ...(isUndefined(videoOffset) ? {} : { videoOffset }),
    ...(isUndefined(audioOffset) ? {} : { audioOffset }),
  }
}

/**
 * Captures a timeline before asynchronous work and rejects invalid offsets.
 *
 * @param value - Unvalidated timeline mode or track offsets in seconds.
 * @returns The alignment mode or a copy of the finite offsets, or undefined
 * when the caller leaves the timeline unspecified.
 * @throws {TypeError} If the timeline mode or track offsets are invalid.
 */
export function captureCombineTimeline(
  value: unknown,
): CombineTimeline | undefined {
  const timeline = parseCombineTimeline(value)

  if (isNull(timeline)) {
    throw new TypeError(
      'Expected an "align-starts" timeline or finite track offsets.',
    )
  }

  return timeline
}
