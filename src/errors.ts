/**
 * Allowed media error codes shared by the core and Worker APIs.
 */
const REMUX_ERROR_CODES = [
  'UNSUPPORTED_CONTAINER',
  'UNSUPPORTED_CODEC',
  'UNSUPPORTED_MEDIA_FEATURE',
  'INCOMPATIBLE_SEGMENTS',
  'INVALID_INPUT',
  'MISSING_REQUIRED_TRACK',
] as const

/**
 * Stable codes for media input and compatibility failures.
 */
export type RemuxErrorCode = (typeof REMUX_ERROR_CODES)[number]

/**
 * A media error with a code shared by the core and Worker APIs.
 */
export interface RemuxError extends Error {
  /**
   * Stable code for fallback and localization decisions.
   */
  readonly code: RemuxErrorCode
}

/**
 * Validates a code received across a message boundary.
 *
 * @param value - Candidate error code.
 * @returns Whether the value is a recognized remux error code.
 */
export function isRemuxErrorCode(value: unknown): value is RemuxErrorCode {
  return REMUX_ERROR_CODES.some(code => code === value)
}

/**
 * Identifies a media error and narrows it to an error with a stable code.
 *
 * @param value - Candidate error.
 * @returns Whether the value is an Error with a recognized remux error code.
 */
export function isRemuxError(value: unknown): value is RemuxError {
  return (
    value instanceof Error && 'code' in value && isRemuxErrorCode(value.code)
  )
}

/**
 * Adds a media code while preserving the original error's type and diagnostics.
 *
 * @param error - Original error to update in place.
 * @param code - Stable remux error code to assign.
 * @returns The original error with the assigned code.
 */
export function withRemuxErrorCode(
  error: Error,
  code: RemuxErrorCode,
): RemuxError {
  return Object.assign(error, { code })
}

/**
 * Creates a media validation error with a stable code.
 *
 * @param code - Stable remux error code for the failure.
 * @param message - Human-readable description of the failure.
 * @returns A new Error with the supplied message and code.
 */
export function createRemuxError(
  code: RemuxErrorCode,
  message: string,
): RemuxError {
  return withRemuxErrorCode(new Error(message), code)
}
