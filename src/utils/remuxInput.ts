import { raceWithSignal } from '@ntnyq/utils'
import type { MpegTsInput, RemuxInput } from '../types/remux'
import { checkAbort } from './abort'

/**
 * Reads a Blob range, allowing cancellation while the native read is pending.
 * @param blob - Immutable source bytes.
 * @param start - Inclusive start offset.
 * @param end - Exclusive end offset, clamped to the Blob size.
 * @param signal - Optional cancellation signal.
 * @returns The bytes in the requested range.
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

/** Checks the descriptor shape before the TS reader validates offset values. */
export function isMpegTsInput(value: unknown): value is MpegTsInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'blob' in value &&
    value.blob instanceof Blob &&
    'segmentOffsets' in value &&
    Array.isArray(value.segmentOffsets) &&
    (!('allowContinuityCounterReset' in value) ||
      value.allowContinuityCounterReset === undefined ||
      typeof value.allowContinuityCounterReset === 'boolean')
  )
}

/** Captures segment starts before asynchronous work or callbacks can change them. */
export function captureRemuxInput(input: RemuxInput): RemuxInput {
  if (input instanceof Blob || !isMpegTsInput(input)) {
    return input
  }

  const { blob, segmentOffsets, allowContinuityCounterReset } = input

  return {
    blob,
    segmentOffsets: [...segmentOffsets],
    ...(allowContinuityCounterReset === undefined
      ? {}
      : { allowContinuityCounterReset }),
  }
}
