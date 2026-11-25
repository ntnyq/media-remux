/* oxlint-disable no-await-in-loop -- EBML elements are read in file order. */

import {
  REMUX_ERROR_CODE,
  MKV_ID,
  MKV_SEGMENT_BOUNDARIES,
} from '../../constants'
import type { MkvElement } from '../../types'
import { checkAbort, createRemuxError, invalidMkv, readVint } from '../../utils'
import { Reader, readBytes, readU8 } from '../../vendor/mediabunny/src/reader'
import { BlobSource } from '../../vendor/mediabunny/src/source'
import type { SourceRef } from '../../vendor/mediabunny/src/source'

/**
 * Reads MKV byte ranges with bounded caching and cancellation checkpoints.
 */
export class MkvReader {
  private readonly source: SourceRef<BlobSource>
  private readonly reader: Reader
  private readonly signal: AbortSignal | undefined

  /**
   * Creates a reader that owns a reference to a Blob-backed cache.
   *
   * @param blob - Source Matroska Blob.
   * @param signal - Optional cancellation signal checked during range reads.
   */
  constructor(blob: Blob, signal?: AbortSignal) {
    const source = new BlobSource(blob, { maxCacheSize: 4 * 1024 * 1024 })

    this.source = source.ref()
    this.reader = new Reader(source)
    this.signal = signal
  }

  /**
   * Reads an exact byte range with cancellation checks around the request.
   *
   * @param start - Absolute byte offset at which to begin reading.
   * @param size - Number of bytes to read.
   * @returns A promise resolving to the requested file slice.
   * @throws If the range is truncated or the signal is aborted.
   */
  async slice(start: number, size: number) {
    checkAbort(this.signal)
    const slice = await this.reader.requestSlice(start, size)

    checkAbort(this.signal)

    if (!slice) {
      throw invalidMkv('Truncated MKV element.')
    }

    return slice
  }

  /**
   * Reads an EBML element header and validates its extent against the parent.
   *
   * @param offset - Absolute byte offset of the element ID.
   * @param parentEnd - Exclusive byte boundary of the enclosing element or file.
   * @returns A promise resolving to the element ID, payload bounds, and size flag.
   * @throws If the header is truncated or the element extent is invalid.
   */
  async element(offset: number, parentEnd: number): Promise<MkvElement> {
    const slice = await this.slice(offset, Math.min(12, parentEnd - offset))
    const id = readVint(slice)
    const size = readVint(slice)
    const data = slice.filePos
    const end = size.allOnes ? parentEnd : data + size.value

    if (id.width > 4 || !Number.isSafeInteger(end) || end > parentEnd) {
      throw invalidMkv('Invalid MKV element size or extent.')
    }

    return {
      id: id.value + 2 ** (7 * id.width),
      data,
      end,
      unknownSize: size.allOnes,
    }
  }

  /**
   * Iterates finite, bounded children without reading their payloads.
   *
   * @param parent - Element whose direct children to visit.
   * @yields {MkvElement} The next direct child.
   * @throws If a child is malformed, uses an unsupported unknown size, or starts another segment.
   */
  async *children(parent: MkvElement) {
    let offset = parent.data

    while (offset < parent.end) {
      const child = await this.element(offset, parent.end)

      if (
        parent.id === MKV_ID.segment &&
        child.unknownSize &&
        child.id === MKV_ID.cluster
      ) {
        child.end = await this.findClusterEnd(child)
      } else if (child.unknownSize) {
        throw invalidMkv('Unexpected unknown-size MKV child element.')
      }

      if (
        parent.id === MKV_ID.segment &&
        (child.id === MKV_ID.segment || child.id === MKV_ID.header)
      ) {
        throw createRemuxError(
          REMUX_ERROR_CODE.unsupportedMediaFeature,
          'Multiple MKV segments in one input are unsupported.',
        )
      }

      yield child
      offset = child.end
    }
  }

  /**
   * Scans an unknown-size cluster up to the next segment-level element.
   *
   * @param cluster - Cluster with a provisional end inherited from its parent.
   * @returns A promise resolving to the cluster's exclusive byte boundary.
   * @throws If the cluster contains an invalid child header or an unknown-size child.
   */
  private async findClusterEnd(cluster: MkvElement) {
    let offset = cluster.data

    while (offset < cluster.end) {
      const child = await this.element(offset, cluster.end)

      // A cluster of unknown size ends at the next segment-level element.
      if (MKV_SEGMENT_BOUNDARIES.has(child.id)) {
        break
      }

      if (child.unknownSize) {
        throw invalidMkv('Unexpected unknown-size MKV cluster child.')
      }

      offset = child.end
    }

    return offset
  }

  /**
   * Reads an EBML unsigned integer that fits in a JavaScript safe integer.
   *
   * @param element - Element containing the unsigned integer payload.
   * @param defaultValue - Value to use for an empty payload, defaulting to zero.
   * @returns A promise resolving to the unsigned integer or the supplied default.
   * @throws If the payload exceeds eight bytes or the value is outside the safe integer range.
   */
  async uint(element: MkvElement, defaultValue = 0) {
    const size = element.end - element.data

    if (!size) {
      return defaultValue
    }

    if (size > 8) {
      throw invalidMkv('Invalid MKV unsigned integer size.')
    }

    const slice = await this.slice(element.data, size)
    let value = 0

    for (let i = 0; i < size; i++) {
      value = value * 256 + readU8(slice)
    }

    if (!Number.isSafeInteger(value)) {
      throw invalidMkv('MKV unsigned integer is too large.')
    }

    return value
  }

  /**
   * Reads a big-endian 32-bit or 64-bit EBML floating-point value.
   *
   * @param element - Element containing the floating-point payload.
   * @param defaultValue - Value to use for an empty payload.
   * @returns A promise resolving to the decoded number or the supplied default.
   * @throws If a nonempty payload has an invalid length.
   */
  async float(element: MkvElement, defaultValue: number) {
    const size = element.end - element.data

    if (!size) {
      return defaultValue
    }

    if (size !== 4 && size !== 8) {
      throw invalidMkv('Invalid MKV floating-point size.')
    }

    const slice = await this.slice(element.data, size)

    return size === 4
      ? slice.view.getFloat32(slice.bufferPos)
      : slice.view.getFloat64(slice.bufferPos)
  }

  /**
   * Reads a bounded EBML identifier and removes any null padding.
   *
   * @param element - Element containing the identifier bytes.
   * @returns A promise resolving to the text before the first null byte,
   * or an empty string for payloads longer than 64 bytes.
   */
  async text(element: MkvElement) {
    const size = element.end - element.data

    // The fields read here are ASCII identifiers rather than free-form metadata.
    if (size > 64) {
      return ''
    }

    const slice = await this.slice(element.data, size)

    return new TextDecoder().decode(readBytes(slice, size)).split('\0', 1)[0]
  }

  /**
   * Tests whether an EBML integer payload contains any nonzero byte.
   *
   * @param element - Element containing a signed or unsigned integer payload.
   * @returns A promise resolving to whether the integer is nonzero.
   * @throws If the payload exceeds eight bytes.
   */
  async hasNonzeroInteger(element: MkvElement) {
    const size = element.end - element.data

    if (size > 8) {
      throw invalidMkv('Invalid MKV integer size.')
    }

    const slice = await this.slice(element.data, size)

    return readBytes(slice, size).some(byte => byte !== 0)
  }

  /**
   * Releases the Blob read cache.
   */
  dispose() {
    this.source.free()
  }
}
