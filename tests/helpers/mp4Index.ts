/* oxlint-disable no-bitwise -- Binary media fields require masks, shifts, and flag manipulation. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CustomSource } from './CustomSource'

interface Box {
  name: string
  data: Uint8Array
  payload: Uint8Array
}

/**
 * Concatenates byte arrays in their original order.
 *
 * @param parts - Byte arrays to concatenate.
 * @returns A new array containing all input bytes.
 */
function join(parts: Uint8Array[]) {
  const data = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  )
  let offset = 0
  for (const part of parts) {
    data.set(part, offset)
    offset += part.length
  }
  return data
}

/**
 * Wraps payload bytes in a standard MP4 box.
 *
 * @param name - Four-character MP4 box type.
 * @param payload - Bytes following the box header.
 * @returns The complete box with its 8-byte header.
 */
function box(name: string, payload: Uint8Array) {
  const data = new Uint8Array(8 + payload.length)
  new DataView(data.buffer).setUint32(0, data.length)
  data.set(new TextEncoder().encode(name), 4)
  data.set(payload, 8)
  return data
}

/**
 * Builds an MP4 box header with an extended 64-bit size.
 *
 * @param name - Four-character MP4 box type.
 * @param size - Total box size in bytes, including the 16-byte header.
 * @returns A 16-byte extended box header.
 */
function largeHeader(name: string, size: number) {
  const data = new Uint8Array(16)
  const view = new DataView(data.buffer)
  view.setUint32(0, 1)
  data.set(new TextEncoder().encode(name), 4)
  view.setBigUint64(8, BigInt(size))
  return data
}

/**
 * Parses consecutive MP4 boxes with standard 8-byte headers.
 *
 * @param data - Bytes containing complete sibling boxes.
 * @returns Box types, complete box bytes, and payload bytes in file order.
 * @throws {AssertionError} If a box size is invalid or extends beyond the input.
 */
function boxes(data: Uint8Array): Box[] {
  const result: Box[] = []
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let offset = 0; offset < data.length;) {
    const size = view.getUint32(offset)
    assert.ok(size >= 8 && offset + size <= data.length)
    result.push({
      name: new TextDecoder().decode(data.subarray(offset + 4, offset + 8)),
      data: data.slice(offset, offset + size),
      payload: data.slice(offset + 8, offset + size),
    })
    offset += size
  }
  return result
}

/**
 * A sparse, valid AAC MP4 with deliberately uncompressed sample tables.
 *
 * @param options - Sample table, codec, timing, and sparse layout settings.
 * @param options.samples - Number of samples per track; defaults to 17003.
 * @param options.fieldSize - Compact sample-size width in bits, or 0 for stsz; defaults to 0.
 * @param options.constantSize - Whether sample sizes use a constant value of 5 bytes; defaults to false.
 * @param options.co64 - Whether chunk offsets use 64-bit co64 entries; defaults to false.
 * @param options.padding - Sparse free-box size inside moov, including its header; defaults to 0.
 * @param options.tracks - Number of generated tracks sharing the media payload; defaults to 1.
 * @param options.chunkPattern - Repeating sample counts per chunk; defaults to [1].
 * @param options.deltas - Repeating decode durations in 48 kHz ticks; defaults to [1024].
 * @param options.compositionOffsets - Repeating presentation offsets in 48 kHz ticks; defaults to [0, 10].
 * @param options.compositionSamples - Number of samples covered by ctts; defaults to samples.
 * @param options.cttsVersion - Composition-offset table version; defaults to 0.
 * @param options.keyInterval - Sample interval between sync entries; defaults to 1.
 * @param options.firstKeySample - Zero-based first sync sample index; defaults to 0.
 * @param options.recordReads - Whether source and parser read ranges are recorded; defaults to true.
 * @param options.pcm - Whether to emit PCM metadata and four-byte samples; defaults to false.
 * @returns A virtual MP4 with table ranges, sample probes, and a Blob builder.
 * @throws {AssertionError} If a generated chunk has no samples.
 */
export async function indexedMp4(
  options: {
    samples?: number
    fieldSize?: 0 | 4 | 8 | 16
    constantSize?: boolean
    co64?: boolean
    padding?: number
    tracks?: number
    chunkPattern?: readonly number[]
    deltas?: readonly number[]
    compositionOffsets?: readonly number[]
    compositionSamples?: number
    cttsVersion?: 0 | 1
    keyInterval?: number
    firstKeySample?: number
    recordReads?: boolean
    pcm?: boolean
  } = {},
) {
  const {
    samples = 17_003,
    fieldSize = 0,
    constantSize = false,
    co64 = false,
    padding = 0,
    tracks = 1,
    chunkPattern = [1],
    deltas = [1024],
    compositionOffsets = [0, 10],
    compositionSamples = samples,
    cttsVersion = 0,
    keyInterval = 1,
    firstKeySample = 0,
    recordReads = true,
    pcm = false,
  } = options
  const original = boxes(
    await readFile(new URL('../fixtures/audio.m4a', import.meta.url)),
  )
  const ftyp = original.find(entry => entry.name === 'ftyp')!.data
  const originalMoov = original.find(entry => entry.name === 'moov')!.payload
  const sizes = Array.from({ length: samples }, (_, index) => {
    if (pcm) {
      return 4
    }
    return constantSize ? 5 : (index % 15) + 1
  })
  const offsets: number[] = []
  let mediaSize = 0
  for (const size of sizes) {
    offsets.push(mediaSize)
    mediaSize += size
  }
  const timestamps: number[] = []
  let decodeTime = 0
  for (let index = 0; index < samples; index++) {
    timestamps.push(
      decodeTime +
        (index < compositionSamples && compositionOffsets.length > 0
          ? compositionOffsets[index % compositionOffsets.length]!
          : 0),
    )
    decodeTime += deltas[index % deltas.length]!
  }
  const chunks: { start: number; count: number }[] = []
  for (let index = 0; index < samples;) {
    const count = Math.min(
      chunkPattern[chunks.length % chunkPattern.length]!,
      samples - index,
    )
    assert.ok(count > 0)
    chunks.push({ start: index, count })
    index += count
  }
  const media = new Uint8Array(mediaSize)
  for (let index = 0; index < samples; index++) {
    media.fill(index % 251, offsets[index]!, offsets[index]! + sizes[index]!)
  }

  /**
   * Builds a full sample-table box by writing fixed-width entries.
   *
   * @param name - Four-character sample-table box type.
   * @param width - Size of each table entry in bytes.
   * @param write - Callback receiving the table view, entry byte offset, and zero-based index.
   * @param entries - Entry count; defaults to the configured sample count.
   * @returns A complete table box with version, flags, entry count, and row bytes.
   */
  function table(
    name: string,
    width: number,
    write: (view: DataView, at: number, index: number) => void,
    entries = samples,
  ) {
    const data = new Uint8Array(8 + entries * width)
    const view = new DataView(data.buffer)
    view.setUint32(4, entries)
    if (name === 'ctts') {
      view.setUint8(0, cttsVersion)
    }
    for (let index = 0; index < entries; index++) {
      write(view, 8 + index * width, index)
    }
    return box(name, data)
  }

  /**
   * Encodes sample sizes using the configured compact or standard table layout.
   *
   * @returns A complete stz2 or stsz box.
   */
  function sampleSizes() {
    let payloadSize = 0
    if (fieldSize) {
      payloadSize = Math.ceil((samples * fieldSize) / 8)
    } else if (!constantSize) {
      payloadSize = samples * 4
    }
    const data = new Uint8Array(12 + payloadSize)
    const view = new DataView(data.buffer)
    view.setUint32(4, fieldSize || (constantSize ? 5 : 0))
    view.setUint32(8, samples)
    for (let index = 0; index < samples; index++) {
      if (fieldSize === 4) {
        data[12 + Math.floor(index / 2)]! |=
          sizes[index]! << (index % 2 === 0 ? 4 : 0)
      } else if (fieldSize === 8) {
        view.setUint8(12 + index, sizes[index]!)
      } else if (fieldSize === 16) {
        view.setUint16(12 + index * 2, sizes[index]!)
      } else if (!constantSize) {
        view.setUint32(12 + index * 4, sizes[index]!)
      }
    }
    return box(fieldSize ? 'stz2' : 'stsz', data)
  }

  /**
   * Rebuilds track metadata and sample tables for the synthetic media payload.
   *
   * @param data - Complete sibling boxes from the original initialization metadata.
   * @param mediaOffset - Absolute byte offset of the first media payload byte.
   * @param trackId - One-based track identifier used for the current track.
   * @returns Rewritten boxes with generated sample tables and optional PCM metadata.
   */
  function rewrite(
    data: Uint8Array,
    mediaOffset: number,
    trackId: number,
  ): Uint8Array {
    return join(
      boxes(data).flatMap(entry => {
        if (entry.name === 'edts') {
          return []
        }
        if (entry.name === 'stbl') {
          let stsd = boxes(entry.payload).find(
            child => child.name === 'stsd',
          )!.data
          if (pcm) {
            const pcmEntry = new Uint8Array(8 + 36)
            const view = new DataView(pcmEntry.buffer)
            view.setUint32(4, 1)
            view.setUint32(8, 36)
            pcmEntry.set(new TextEncoder().encode('sowt'), 12)
            view.setUint16(22, 1)
            view.setUint16(32, 2)
            view.setUint16(34, 16)
            view.setUint32(40, 48_000 * 65_536)
            stsd = box('stsd', pcmEntry)
          }
          return [
            box(
              'stbl',
              join([
                stsd,
                table('stts', 8, (view, at, index) => {
                  view.setUint32(at, 1)
                  view.setUint32(at + 4, deltas[index % deltas.length]!)
                }),
                ...(compositionOffsets.length > 0
                  ? [
                      table(
                        'ctts',
                        8,
                        (view, at, index) => {
                          view.setUint32(at, 1)
                          view.setInt32(
                            at + 4,
                            compositionOffsets[
                              index % compositionOffsets.length
                            ]!,
                          )
                        },
                        compositionSamples,
                      ),
                    ]
                  : []),
                sampleSizes(),
                table(
                  'stss',
                  4,
                  (view, at, index) =>
                    view.setUint32(
                      at,
                      firstKeySample + index * keyInterval + 1,
                    ),
                  Math.ceil((samples - firstKeySample) / keyInterval),
                ),
                table(
                  'stsc',
                  12,
                  (view, at, index) => {
                    view.setUint32(at, index + 1)
                    view.setUint32(at + 4, chunks[index]!.count)
                    view.setUint32(at + 8, 1)
                  },
                  chunks.length,
                ),
                table(
                  co64 ? 'co64' : 'stco',
                  co64 ? 8 : 4,
                  (view, at, index) => {
                    const offset = mediaOffset + offsets[chunks[index]!.start]!
                    if (co64) {
                      view.setBigUint64(at, BigInt(offset))
                    } else {
                      view.setUint32(at, offset)
                    }
                  },
                  chunks.length,
                ),
              ]),
            ),
          ]
        }
        if (['mdia', 'minf'].includes(entry.name)) {
          return [box(entry.name, rewrite(entry.payload, mediaOffset, trackId))]
        }
        if (entry.name === 'trak') {
          return Array.from({ length: tracks }, (_, index) =>
            box('trak', rewrite(entry.payload, mediaOffset, index + 1)),
          )
        }
        if (entry.name === 'tkhd') {
          new DataView(entry.payload.buffer).setUint32(12, trackId)
        }
        if (entry.name === 'mdhd') {
          const view = new DataView(entry.payload.buffer)
          view.setUint32(12, 48_000)
          view.setUint32(16, decodeTime)
        }
        return [box(entry.name, entry.payload)]
      }),
    )
  }
  const moovHeaderSize = padding ? 16 : 8
  const contentsSize = rewrite(originalMoov, 0, 1).length
  const moovSize = moovHeaderSize + padding + contentsSize
  const mediaOffset = ftyp.length + moovSize + 8
  const contents = rewrite(originalMoov, mediaOffset, 1)
  const moovHeader = padding
    ? largeHeader('moov', moovSize)
    : box('moov', contents).subarray(0, 8)
  const segments = [
    { start: 0, data: ftyp },
    { start: ftyp.length, data: moovHeader },
    ...(padding
      ? [
          {
            start: ftyp.length + moovHeaderSize,
            data: largeHeader('free', padding),
          },
        ]
      : []),
    { start: ftyp.length + moovHeaderSize + padding, data: contents },
    { start: mediaOffset - 8, data: box('mdat', media).subarray(0, 8) },
    { start: mediaOffset, data: media },
  ]
  const tableRanges: { name: string; start: number; end: number }[] = []

  /**
   * Collects absolute byte ranges of sample tables for read-bound assertions.
   *
   * @param data - Complete sibling boxes to inspect recursively.
   * @param start - Absolute file offset of the first input box.
   * @returns Nothing.
   */
  function collectTables(data: Uint8Array, start: number) {
    let offset = start
    for (const entry of boxes(data)) {
      if (['trak', 'mdia', 'minf', 'stbl'].includes(entry.name)) {
        collectTables(entry.payload, offset + 8)
      } else if (
        [
          'stts',
          'ctts',
          'stsz',
          'stz2',
          'stss',
          'stsc',
          'stco',
          'co64',
        ].includes(entry.name)
      ) {
        tableRanges.push({
          name: entry.name,
          start: offset,
          end: offset + entry.data.length,
        })
      }
      offset += entry.data.length
    }
  }
  collectTables(contents, ftyp.length + moovHeaderSize + padding)
  const size = mediaOffset + mediaSize
  const reads: { start: number; end: number }[] = []
  const requests: { start: number; end: number }[] = []
  const source = new CustomSource({
    /**
     * Reports the virtual file size without materializing its contents.
     *
     * @returns The total file size in bytes.
     */
    getSize: () => size,
    maxCacheSize: 128 * 1024,
    prefetchProfile: 'none',

    /**
     * Reads a bounded sparse range and optionally records the source request.
     *
     * @param start - Inclusive byte offset in the virtual file.
     * @param end - Exclusive byte offset in the virtual file.
     * @returns The requested bytes with zero-filled gaps after an asynchronous boundary.
     * @throws {AssertionError} If the source read exceeds 256 KiB.
     */
    async read(start, end) {
      if (recordReads) {
        reads.push({ start, end })
      }
      assert.ok(
        end - start <= 256 * 1024,
        `Unbounded index read: ${end - start} bytes`,
      )
      // Force an asynchronous boundary to expose shared parser-state races.
      await Promise.resolve()
      const data = new Uint8Array(end - start)
      for (const segment of segments) {
        const from = Math.max(start, segment.start)
        const to = Math.min(end, segment.start + segment.data.length)
        if (from < to) {
          data.set(
            segment.data.subarray(from - segment.start, to - segment.start),
            from - start,
          )
        }
      }
      return data
    },
  })
  // The public declaration hides _read; probe this pinned dependency at the
  // Reader boundary as well as recording actual, coalesced source reads.
  const read: unknown = Reflect.get(source, '_read')
  assert.equal(typeof read, 'function')
  if (typeof read !== 'function') {
    throw new TypeError('Missing source reader')
  }
  Object.defineProperty(source, '_read', {
    configurable: true,

    /**
     * Probes parser reads and enforces bounded request and index-page sizes.
     *
     * @param start - Inclusive byte offset in the virtual file.
     * @param end - Exclusive byte offset in the virtual file.
     * @param args - Additional arguments forwarded to the original source reader.
     * @returns The result of the original source reader.
     * @throws {AssertionError} If a parser request exceeds its allowed size.
     */
    value(start: number, end: number, ...args: unknown[]) {
      if (recordReads) {
        requests.push({ start, end })
      }
      if (
        tableRanges.some(range => start >= range.start + 8 && end <= range.end)
      ) {
        assert.ok(
          end - start <= 16 * 1024,
          `Unbounded table page: ${end - start} bytes`,
        )
      }
      assert.ok(
        end - start <= 64 * 1024,
        `Unbounded parser request: ${end - start} bytes`,
      )
      return Reflect.apply(read, source, [start, end, ...args])
    },
  })
  return {
    source,
    reads,
    requests,
    samples,
    chunks,
    mediaOffset,
    moovSize,
    tableRanges,

    /**
     * Looks up a sample presentation timestamp.
     *
     * @param index - Zero-based sample index.
     * @returns The presentation timestamp in seconds.
     */
    timestamp: (index: number) => timestamps[index]! / 48_000,

    /**
     * Looks up a sample decode duration from the repeating delta pattern.
     *
     * @param index - Zero-based sample index.
     * @returns The decode duration in seconds.
     */
    delta: (index: number) => deltas[index % deltas.length]! / 48_000,

    /**
     * Copies a generated sample payload from the media buffer.
     *
     * @param index - Zero-based sample index.
     * @returns A new byte array containing the sample payload.
     */
    packet: (index: number) =>
      media.slice(offsets[index]!, offsets[index]! + sizes[index]!),

    /**
     * Materializes the sparse file by filling gaps between stored segments.
     *
     * @returns A Blob containing the complete generated MP4 file.
     * @throws {AssertionError} If the configured padding is at least 16 MiB.
     */
    blob() {
      assert.ok(padding < 16 * 1024 * 1024)
      const parts: Uint8Array[] = []
      let position = 0
      for (const segment of segments) {
        if (segment.start > position) {
          parts.push(new Uint8Array(segment.start - position))
        }
        parts.push(segment.data)
        position = segment.start + segment.data.length
      }
      return new Blob(parts.map(part => part.slice()))
    },
  }
}
