import { createOpfsFragmentStore } from './fragmentStore'

/**
 * Keeps completed-fragment TFRA records in per-track OPFS files until
 * finalization. Files open lazily; creating the store performs no I/O.
 * Store operations propagate OPFS failures, reject invalid tracks or ranges,
 * and seal a track before its first read. The caller removes the containing
 * directory after disposal.
 *
 * @param directory - Exclusive, caller-owned temporary remux directory in which
 * index-trackId.tfra files are created lazily.
 * @returns A per-track disk index store with append/read, reset, and
 * idempotent disposal operations. Reads return at most 64 KiB, and reset allows
 * a track's index file to be reopened with its previous contents truncated.
 */
export function createOpfsFragmentIndex(directory: FileSystemDirectoryHandle) {
  return createOpfsFragmentStore(directory, trackId => `index-${trackId}.tfra`)
}
