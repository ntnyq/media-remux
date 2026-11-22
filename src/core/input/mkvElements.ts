/* oxlint-disable no-await-in-loop -- EBML elements are read in file order. */

import { checkAbort } from '../../abort'
import { REMUX_ERROR_CODE } from '../../constants'
import { createRemuxError } from '../../errors'
import { Reader, readBytes, readU8 } from '../../vendor/mediabunny/src/reader'
import type { FileSlice } from '../../vendor/mediabunny/src/reader'
import { BlobSource } from '../../vendor/mediabunny/src/source'
import type { SourceRef } from '../../vendor/mediabunny/src/source'

/**
 * EBML and Matroska element IDs used by the MKV reader.
 */
export const MKV_ID = {
  header: 0x1a45dfa3,
  docType: 0x4282,
  docTypeReadVersion: 0x4285,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  flagEnabled: 0xb9,
  flagDefault: 0x88,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  codecDelay: 0x56aa,
  defaultDuration: 0x23e383,
  trackTimestampScale: 0x23314f,
  trackOffset: 0x537f,
  contentEncodings: 0x6d80,
  video: 0xe0,
  displayWidth: 0x54b0,
  displayHeight: 0x54ba,
  displayUnit: 0x54b2,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  pixelCropBottom: 0x54aa,
  pixelCropTop: 0x54bb,
  pixelCropLeft: 0x54cc,
  pixelCropRight: 0x54dd,
  colour: 0x55b0,
  matrixCoefficients: 0x55b1,
  range: 0x55b9,
  transferCharacteristics: 0x55ba,
  primaries: 0x55bb,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
  referenceBlock: 0xfb,
  codecState: 0xa4,
  blockAdditions: 0x75a1,
  discardPadding: 0x75a2,
  cues: 0x1c53bb6b,
  attachments: 0x1941a469,
  chapters: 0x1043a770,
  tags: 0x1254c367,
  void: 0xec,
  crc32: 0xbf,
} as const

const SEGMENT_BOUNDARIES = new Set<number>([
  MKV_ID.header,
  MKV_ID.segment,
  MKV_ID.seekHead,
  MKV_ID.info,
  MKV_ID.tracks,
  MKV_ID.cluster,
  MKV_ID.cues,
  MKV_ID.attachments,
  MKV_ID.chapters,
  MKV_ID.tags,
])

export interface MkvElement {
  id: number
  data: number
  end: number
  unknownSize: boolean
}

/**
 * Signals malformed or truncated MKV data discovered during inspection.
 */
export function invalidMkv(message: string) {
  return createRemuxError(REMUX_ERROR_CODE.invalidInput, message)
}

/**
 * Reads the EBML variable-length integer and its encoded width. The same
 * bits mean an unknown size only when used in an element size field.
 */
export function readVint(slice: FileSlice) {
  if (!slice.remainingLength) {
    throw invalidMkv('Truncated MKV variable-length integer.')
  }

  const first = readU8(slice)
  const width = Math.clz32(first) - 23

  if (width > 8 || width - 1 > slice.remainingLength) {
    throw invalidMkv('Invalid MKV variable-length integer.')
  }

  const mask = 0xff >> width
  let value = first & mask
  let allOnes = value === mask

  for (let i = 1; i < width; i++) {
    const byte = readU8(slice)

    value = value * 256 + byte
    allOnes &&= byte === 0xff
  }

  return { value, width, allOnes }
}

/**
 * Reads MKV byte ranges with bounded caching and cancellation checkpoints.
 */
export class MkvReader {
  private readonly source: SourceRef<BlobSource>
  private readonly reader: Reader
  private readonly signal: AbortSignal | undefined

  constructor(blob: Blob, signal?: AbortSignal) {
    const source = new BlobSource(blob, { maxCacheSize: 4 * 1024 * 1024 })

    this.source = source.ref()
    this.reader = new Reader(source)
    this.signal = signal
  }

  async slice(start: number, size: number) {
    checkAbort(this.signal)
    const slice = await this.reader.requestSlice(start, size)

    checkAbort(this.signal)

    if (!slice) {
      throw invalidMkv('Truncated MKV element.')
    }

    return slice
  }

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
   * @yields {MkvElement} The next direct child.
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

  private async findClusterEnd(cluster: MkvElement) {
    let offset = cluster.data

    while (offset < cluster.end) {
      const child = await this.element(offset, cluster.end)

      // A cluster of unknown size ends at the next segment-level element.
      if (SEGMENT_BOUNDARIES.has(child.id)) {
        break
      }

      if (child.unknownSize) {
        throw invalidMkv('Unexpected unknown-size MKV cluster child.')
      }

      offset = child.end
    }

    return offset
  }

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

  async text(element: MkvElement) {
    const size = element.end - element.data

    // The fields read here are ASCII identifiers rather than free-form metadata.
    if (size > 64) {
      return ''
    }

    const slice = await this.slice(element.data, size)

    return new TextDecoder().decode(readBytes(slice, size)).split('\0', 1)[0]
  }

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
