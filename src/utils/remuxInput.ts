import {
  isArray,
  isBoolean,
  isFunction,
  isObject,
  isUndefined,
  raceWithSignal,
} from '@ntnyq/utils'
import type { MpegTsInput, RemuxInput } from '../types/remux'
import { checkAbort } from './abort'

/**
 * Reads a Blob range, allowing cancellation while the native read is pending.
 *
 * @param blob - Immutable source bytes.
 * @param start - Inclusive start offset.
 * @param end - Exclusive end offset, clamped to the Blob size.
 * @param signal - Optional cancellation signal.
 * @returns A promise resolving to the bytes in the requested range.
 * @throws If the Blob read fails or the signal is aborted.
 */
export async function readBlobBytes(
  blob: Blob,
  start: number,
  end: number,
  signal?: AbortSignal,
) {
  checkAbort(signal)
  const read = blob.slice(start, end).arrayBuffer()
  const buffer = await (signal ? raceWithSignal(read, signal) : read)

  checkAbort(signal)

  return new Uint8Array(buffer)
}

/**
 * Checks the MPEG-TS descriptor shape before the reader validates offset values.
 *
 * @param value - Candidate media input.
 * @returns Whether the value has a Blob, an array of segment offsets, and a
 * boolean or absent continuity reset flag.
 */
export function isMpegTsInput(value: unknown): value is MpegTsInput {
  return (
    isObject(value) &&
    !isFunction(value) &&
    'blob' in value &&
    value.blob instanceof Blob &&
    'segmentOffsets' in value &&
    isArray(value.segmentOffsets) &&
    (!('allowContinuityCounterReset' in value) ||
      isUndefined(value.allowContinuityCounterReset) ||
      isBoolean(value.allowContinuityCounterReset))
  )
}

/**
 * Captures segment starts before asynchronous work or callbacks can change them.
 *
 * @param input - Media Blob or MPEG-TS input descriptor to snapshot.
 * @returns A descriptor with a copied offset array, or the original input
 * when it is a Blob or fails the descriptor shape check.
 */
export function captureRemuxInput(input: RemuxInput): RemuxInput {
  if (input instanceof Blob || !isMpegTsInput(input)) {
    return input
  }

  const { blob, segmentOffsets, allowContinuityCounterReset } = input

  return {
    blob,
    segmentOffsets: [...segmentOffsets],
    ...(isUndefined(allowContinuityCounterReset)
      ? {}
      : { allowContinuityCounterReset }),
  }
}
