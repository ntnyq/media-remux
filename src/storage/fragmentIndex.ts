/**
 * Creates a per-track byte store for completed-fragment TFRA index records.
 *
 * @param open - Opens a truncated positional backing file for the given track ID.
 * @returns A lazy index store with append, bounded read, reset, and disposal.
 * @see createDiskFragmentStore
 */
export { createDiskFragmentStore as createDiskFragmentIndex } from './fragmentStore'
