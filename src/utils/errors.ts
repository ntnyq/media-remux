import { REMUX_ERROR_CODE } from '../constants'
import type { RemuxError, RemuxErrorCode } from '../types'

/**
 * Identifies a stable remux error code, including codes received from a Worker.
 *
 * @param value - Candidate error code.
 * @returns Whether the value is a recognized remux error code.
 */
export function isRemuxErrorCode(value: unknown): value is RemuxErrorCode {
  return Object.values(REMUX_ERROR_CODE).some(code => code === value)
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
 * @throws {TypeError} If the error's code property cannot be written.
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
