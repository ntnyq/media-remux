/* oxlint-disable no-underscore-dangle -- Source defines the inherited _disposed lifecycle field. */
import { InputDisposedError } from '../../src/vendor/mediabunny/src/input'
import { Source } from '../../src/vendor/mediabunny/src/source'

/**
 * Uncached virtual source for sparse >4 GiB parser regressions.
 */
export class CustomSource extends Source {
  private size: number | undefined
  private readonly options: {
    getSize: () => number | Promise<number>
    read: (start: number, end: number) => Uint8Array | Promise<Uint8Array>
    maxCacheSize?: number
    prefetchProfile?: string
  }

  /**
   * Creates a virtual source backed by size and byte-range callbacks.
   *
   * @param options - Source callbacks and compatibility settings.
   * @param options.getSize - Resolves the virtual file size in bytes.
   * @param options.read - Reads bytes from an inclusive start to an exclusive end.
   * @param options.maxCacheSize - Compatibility option; this source does not cache.
   * @param options.prefetchProfile - Compatibility option; this source does not prefetch.
   */
  public constructor(options: CustomSource['options']) {
    super()
    this.options = options
  }

  /**
   * Reports the file size cached by the first read.
   *
   * @returns The file size in bytes, or undefined before the first read resolves it.
   */
  public override _getFileSize() {
    return this.size
  }

  /**
   * Reads a byte range directly from the backing callback without caching.
   *
   * @param start - Inclusive byte offset in the virtual file.
   * @param end - Exclusive byte offset in the virtual file.
   * @returns The bytes, view, and source offset, or null if end exceeds the file size.
   * @throws {InputDisposedError} If the source is disposed before or during the read.
   */
  public override async _read(start: number, end: number) {
    if (this._disposed) {
      throw new InputDisposedError()
    }
    this.size ??= await this.options.getSize()
    if (end > this.size) {
      return null
    }
    const bytes = await this.options.read(start, end)
    if (this._disposed) {
      throw new InputDisposedError()
    }
    return {
      bytes,
      view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      offset: start,
    }
  }

  /**
   * Marks the source as disposed so subsequent reads fail.
   *
   * @returns Nothing.
   */
  public override _dispose() {
    this._disposed = true
  }
}
