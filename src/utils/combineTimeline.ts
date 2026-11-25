import { isNumber, isUndefined } from '@ntnyq/utils'
import type { CombineTimeline } from '../types'

/**
 * Reads and snapshots a combine timeline from public options or a Worker request.
 * Returns null for invalid values and undefined for the default shared timeline.
 */
export function parseCombineTimeline(
  value: unknown,
): CombineTimeline | undefined | null {
  if (isUndefined(value) || value === 'align-starts') {
    return value
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  const videoOffset = 'videoOffset' in value ? value.videoOffset : undefined
  const audioOffset = 'audioOffset' in value ? value.audioOffset : undefined

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

/** Captures a timeline before asynchronous work and rejects invalid offsets. */
export function captureCombineTimeline(
  value: unknown,
): CombineTimeline | undefined {
  const timeline = parseCombineTimeline(value)

  if (timeline === null) {
    throw new TypeError(
      'Expected an "align-starts" timeline or finite track offsets.',
    )
  }

  return timeline
}
