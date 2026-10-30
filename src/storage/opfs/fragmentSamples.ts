import { createDiskFragmentSamples } from '../fragmentSamples'

/**
 * Worker file handle supporting synchronous positional access to temporary files.
 */
interface WorkerFileHandle extends FileSystemFileHandle {
  /**
   * Opens exclusive synchronous file access in a dedicated Worker.
   *
   * @returns A promise resolving to positional I/O and file lifecycle methods.
   */
  createSyncAccessHandle: () => Promise<{
    /**
     * Reads synchronously into a caller-owned buffer.
     *
     * @param data - Destination bytes to fill from the start of the buffer.
     * @param options - Positional read settings.
     * @param options.at - Absolute source byte offset in the file.
     * @returns Number of bytes read, which may be less than the buffer length.
     */
    read: (data: Uint8Array<ArrayBuffer>, options: { at: number }) => number

    /**
     * Writes synchronously at an explicit file position.
     *
     * @param data - Source bytes to write.
     * @param options - Positional write settings.
     * @param options.at - Absolute destination byte offset in the file.
     * @returns Number of bytes written, which may be less than the buffer length.
     */
    write: (data: Uint8Array<ArrayBuffer>, options: { at: number }) => number

    /**
     * Resizes the synchronous backing file.
     *
     * @param size - New file length in bytes.
     * @returns Nothing.
     */
    truncate: (size: number) => void

    /**
     * Releases the synchronous handle and its exclusive file lock.
     *
     * @returns Nothing.
     */
    close: () => void
  }>
}

/**
 * Checks whether a Worker file handle exposes synchronous positional OPFS
 * access.
 *
 * @param handle - File handle returned by the temporary sample directory.
 * @returns Whether createSyncAccessHandle is callable, narrowing the handle to
 * WorkerFileHandle.
 */
function isSyncAccessFileHandle(
  handle: FileSystemFileHandle,
): handle is WorkerFileHandle {
  return (
    'createSyncAccessHandle' in handle &&
    typeof handle.createSyncAccessHandle === 'function'
  )
}

/**
 * Creates a sample store using dedicated Worker synchronous OPFS handles for
 * positional updates without reopening and copying the whole file. Handles
 * stay private to one remux job and open lazily; creation performs no I/O.
 * Store operations reject unsupported synchronous access, malformed sample
 * data, and OPFS failures. Existing backing files are truncated when opened.
 * Disposal closes every opened handle but leaves file removal to the caller.
 *
 * @param directory - Exclusive, caller-owned remux directory used for per-track
 * records, media, and external-sort files named samples-trackId-kind.bin.
 * @returns A lazily opened sample store backed by synchronous Worker OPFS
 * handles, with serialized sample operations, bounded reads and sorting,
 * prefix compaction, and idempotent disposal.
 */
export function createOpfsFragmentSamples(
  directory: FileSystemDirectoryHandle,
) {
  return createDiskFragmentSamples(async (trackId, kind) => {
    const handle = await directory.getFileHandle(
      `samples-${trackId}-${kind}.bin`,
      { create: true },
    )
    if (!isSyncAccessFileHandle(handle)) {
      throw new Error('This browser does not support worker sample disk.')
    }

    const file = await handle.createSyncAccessHandle()

    return {
      /**
       * Adapts positional reads to the synchronous Worker handle.
       *
       * @param data - Destination buffer to fill.
       * @param position - Absolute source byte offset.
       * @returns Number of bytes read by the synchronous handle.
       */
      read: (data, position) => file.read(data, { at: position }),

      /**
       * Adapts positional writes to the synchronous Worker handle.
       *
       * @param data - Source bytes to write.
       * @param position - Absolute destination byte offset.
       * @returns Number of bytes written by the synchronous handle.
       */
      write: (data, position) => file.write(data, { at: position }),

      /**
       * Resizes a sample backing file through its synchronous handle.
       *
       * @param size - New file length in bytes.
       * @returns Nothing.
       */
      truncate: size => file.truncate(size),

      /**
       * Releases the sample file's synchronous access lock.
       *
       * @returns Nothing.
       */
      close: () => file.close(),
    }
  })
}
