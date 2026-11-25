/**
 * Checks for cancellation, preserving the signal's original abort reason.
 *
 * @param signal - Optional cancellation signal; omitting it performs no check.
 * @returns Nothing when the signal is absent or has not been aborted.
 * @throws The signal's abort reason when it has been aborted.
 */
export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}
