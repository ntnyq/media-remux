import type { MpegTsInput, RemuxInput } from '../types/remux'

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
