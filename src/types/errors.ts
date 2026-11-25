import type { ValueOf } from '@ntnyq/utils'
import type { REMUX_ERROR_CODE } from '../constants'

/**
 * Stable codes for media input and compatibility failures.
 */
export type RemuxErrorCode = ValueOf<typeof REMUX_ERROR_CODE>

/**
 * A media error with a code shared by the core and Worker APIs.
 */
export interface RemuxError extends Error {
  /**
   * Stable code for fallback and localization decisions.
   */
  readonly code: RemuxErrorCode
}
