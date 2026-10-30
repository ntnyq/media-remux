import type { RemuxStorage } from '../../types'
import { createOpfsFragmentIndex } from './fragmentIndex'
import { createOpfsFragmentSamples } from './fragmentSamples'

/**
 * Caller-owned temporary remux stores with a shared resource cleanup operation.
 */
export interface DisposableRemuxStorage extends RemuxStorage {
  /**
   * Attempts to close both stores even if one fails. Repeated calls reuse each
   * store's disposal; removing the temporary directory remains the caller's job.
   *
   * @returns A promise resolving when both stores are disposed.
   * @throws The first rejected disposal result if either store fails to close.
   */
  dispose: () => Promise<void>
}

/**
 * Opens lazy OPFS spools inside a caller-owned, exclusive job directory.
 * Requires a dedicated Worker with synchronous OPFS access for sample records.
 * Disposal closes every store; it leaves directory removal to the caller.
 * Creating the adapter performs no I/O. Later store operations propagate OPFS
 * and validation failures, including unavailable synchronous access. The shared
 * disposer attempts both stores and rejects with the first rejected result.
 *
 * @param directory - Caller-owned directory reserved exclusively for this job's
 * fragment index, sample metadata, encoded payload, and sorting files.
 * @returns Lazy fragment index and sample stores plus their shared asynchronous
 * disposer. Dispose after success, failure, or cancellation before removing
 * the directory.
 */
export function createOpfsStorage(
  directory: FileSystemDirectoryHandle,
): DisposableRemuxStorage {
  const fragmentIndex = createOpfsFragmentIndex(directory)
  const fragmentSamples = createOpfsFragmentSamples(directory)

  return {
    fragmentIndex,
    fragmentSamples,

    /**
     * Disposes both stores concurrently, preserving cleanup attempts after failure.
     *
     * @returns A promise resolving when both stores close successfully.
     * @throws The first rejected disposal result if either store fails.
     */
    async dispose() {
      // A failure in one store must not leave the other store's OPFS locks held.
      const results = await Promise.allSettled([
        fragmentIndex.dispose(),
        fragmentSamples.dispose(),
      ])
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        throw failure.reason
      }
    },
  }
}
