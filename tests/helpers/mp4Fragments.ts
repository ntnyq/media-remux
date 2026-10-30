import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CustomSource } from './CustomSource'

/**
 * Concatenates byte arrays in their original order.
 *
 * @param parts - Byte arrays to concatenate.
 * @returns A new array containing all input bytes.
 */
function join(parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  )
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

/**
 * Encodes numbers as consecutive big-endian 32-bit words.
 *
 * @param values - Numbers to encode using unsigned 32-bit representation.
 * @returns Four bytes per input value.
 */
function words(...values: number[]) {
  const result = new Uint8Array(values.length * 4)
  const view = new DataView(result.buffer)
  for (const [index, value] of values.entries()) {
    view.setUint32(index * 4, value)
  }
  return result
}

/**
 * Wraps payload bytes in a standard MP4 box.
 *
 * @param name - Four-character MP4 box type.
 * @param data - Payload bytes following the box header.
 * @returns The complete box with its 8-byte header.
 */
function box(name: string, data: Uint8Array) {
  return join([words(8 + data.length), new TextEncoder().encode(name), data])
}

/**
 * Builds an MP4 box header, using a 64-bit size when necessary.
 *
 * @param name - Four-character MP4 box type.
 * @param size - Total box size in bytes, including its header.
 * @returns An 8-byte standard header or a 16-byte extended header.
 */
function header(name: string, size: number) {
  if (size <= 0xff_ff_ff_ff) {
    return join([words(size), new TextEncoder().encode(name)])
  }
  const data = join([
    words(1),
    new TextEncoder().encode(name),
    new Uint8Array(8),
  ])
  new DataView(data.buffer).setBigUint64(8, BigInt(size))
  return data
}

/**
 * Parses consecutive MP4 boxes with standard 8-byte headers.
 *
 * @param data - Bytes containing complete sibling boxes.
 * @returns Box types, complete box bytes, and payload bytes in file order.
 * @throws {AssertionError} If a box size is invalid or extends beyond the input.
 */
function boxes(data: Uint8Array) {
  const entries: { name: string; data: Uint8Array; payload: Uint8Array }[] = []
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let offset = 0; offset < data.length;) {
    const size = view.getUint32(offset)
    assert.ok(size >= 8 && offset + size <= data.length)
    entries.push({
      name: new TextDecoder().decode(data.subarray(offset + 4, offset + 8)),
      data: data.slice(offset, offset + size),
      payload: data.slice(offset + 8, offset + size),
    })
    offset += size
  }
  return entries
}

/**
 * Generates fragments and TFRA rows on demand, without per-fragment arrays.
 *
 * @param options - Fragment layout, track, index, and timing settings.
 * @param options.fragments - Number of fragments in the first track; defaults to 4099.
 * @param options.indexed - Whether to append an mfra index; defaults to true.
 * @param options.tfdt - Whether fragments include decode-time boxes; defaults to true.
 * @param options.version - TFRA version controlling time and offset widths; defaults to 1.
 * @param options.trunVersion - Sample-run version for composition offsets; defaults to 1.
 * @param options.widths - TFRA traf, trun, and sample number widths in bytes; defaults to [1, 1, 1].
 * @param options.tracks - Number of interleaved tracks; defaults to 1.
 * @param options.shorterTrackFragments - Second-track fragment count; defaults to fragments.
 * @param options.padding - Sparse free-box size before fragments, including its header; defaults to 0.
 * @param options.indexPadding - Sparse free-box size before TFRA tables, including its header; defaults to 0.
 * @param options.reordered - Whether each fragment uses reordered presentation times; defaults to false.
 * @param options.multipleRuns - Whether each fragment has two sample runs; defaults to false.
 * @param options.recordReads - Whether source and parser read ranges are recorded; defaults to true.
 * @param options.indexReference - Zero-based sample within a fragment referenced by TFRA; defaults to 0.
 * @param options.compositionShift - Presentation-time shift in 48 kHz ticks; defaults to 0.
 * @returns A sparse fixture with a virtual source, byte probes, and Blob builders.
 * @throws {AssertionError} If a track fragment count is outside 1 through fragments.
 */
export async function fragmentedMp4(
  options: {
    fragments?: number
    indexed?: boolean
    tfdt?: boolean
    version?: 0 | 1
    trunVersion?: 0 | 1
    widths?: readonly [number, number, number]
    tracks?: 1 | 2
    shorterTrackFragments?: number
    padding?: number
    indexPadding?: number
    reordered?: boolean
    multipleRuns?: boolean
    recordReads?: boolean
    indexReference?: number
    compositionShift?: number
  } = {},
) {
  const {
    fragments = 4099,
    indexed = true,
    tfdt = true,
    version = 1,
    trunVersion = 1,
    widths = [1, 1, 1],
    tracks = 1,
    shorterTrackFragments = fragments,
    padding = 0,
    indexPadding = 0,
    reordered = false,
    multipleRuns = false,
    recordReads = true,
    indexReference = 0,
    compositionShift = 0,
  } = options
  const samplesPerFragment = 3
  const original = boxes(
    new Uint8Array(
      await readFile(new URL('../fixtures/audio.m4a', import.meta.url)),
    ),
  )
  const ftyp = original.find(entry => entry.name === 'ftyp')!.data
  const originalMoov = original.find(entry => entry.name === 'moov')!.payload
  const trackCounts =
    tracks === 1 ? [fragments] : [fragments, shorterTrackFragments]
  assert.ok(trackCounts.every(count => count > 0 && count <= fragments))

  /**
   * Rewrites initialization boxes for fragmented tracks with empty sample tables.
   *
   * @param data - Complete sibling boxes from the original initialization metadata.
   * @param trackId - One-based track identifier used for the current track.
   * @returns Rebuilt boxes with edit lists removed and track timing reset.
   */
  function rewrite(data: Uint8Array, trackId: number): Uint8Array {
    return join(
      boxes(data).flatMap(entry => {
        if (entry.name === 'edts') {
          return []
        }
        if (entry.name === 'stbl') {
          const stsd = boxes(entry.payload).find(
            child => child.name === 'stsd',
          )!.data
          return [
            box(
              'stbl',
              join([
                stsd,
                box('stts', words(0, 0)),
                box('stsc', words(0, 0)),
                box('stsz', words(0, 0, 0)),
                box('stco', words(0, 0)),
              ]),
            ),
          ]
        }
        if (entry.name === 'trak') {
          return trackCounts.map((_, index) =>
            box('trak', rewrite(entry.payload, index + 1)),
          )
        }
        if (['mdia', 'minf'].includes(entry.name)) {
          return [box(entry.name, rewrite(entry.payload, trackId))]
        }
        const view = new DataView(entry.payload.buffer)
        if (entry.name === 'mvhd') {
          view.setUint32(16, 0)
        }
        if (entry.name === 'tkhd') {
          view.setUint32(12, trackId)
          view.setUint32(20, 0)
        }
        if (entry.name === 'mdhd') {
          view.setUint32(12, 48_000)
          view.setUint32(16, 0)
        }
        return [box(entry.name, entry.payload)]
      }),
    )
  }
  const moov = box(
    'moov',
    join([
      rewrite(originalMoov, 1),
      box(
        'mvex',
        join(
          trackCounts.map((_, index) =>
            box('trex', words(0, index + 1, 1, 1024, 4, 0)),
          ),
        ),
      ),
    ]),
  )
  const init = join([ftyp, moov])
  const fragmentStart = init.length + padding
  const totalFragments = trackCounts.reduce((sum, count) => sum + count, 0)
  const entrySize =
    (version === 1 ? 16 : 8) + widths.reduce((sum, value) => sum + value, 0)

  /**
   * Maps a track-local fragment index to the interleaved file order.
   *
   * @param track - One-based track identifier.
   * @param index - Zero-based fragment index within the track.
   * @returns The zero-based physical fragment index.
   */
  function physicalIndex(track: number, index: number) {
    if (tracks === 1) {
      return index
    }
    if (track === 2) {
      return index * 2 + 1
    }
    return index < shorterTrackFragments
      ? index * 2
      : index + shorterTrackFragments
  }

  /**
   * Resolves a physical fragment to its track and track-local index.
   *
   * @param index - Zero-based fragment index in file order.
   * @returns The one-based track identifier and zero-based track-local fragment index.
   */
  function location(index: number) {
    if (tracks === 1) {
      return { track: 1, index }
    }
    if (index < shorterTrackFragments * 2) {
      return { track: (index % 2) + 1, index: Math.floor(index / 2) }
    }
    return { track: 1, index: index - shorterTrackFragments }
  }

  /**
   * Encodes a track and sample index into a recognizable synthetic packet.
   *
   * @param track - One-based track identifier.
   * @param index - Zero-based sample index within the track.
   * @returns A four-byte packet containing the track and sample marker.
   */
  const packet = (track: number, index: number) =>
    words(track * 0x01_00_00_00 + index)

  /**
   * Calculates a sample presentation offset within a fragment.
   *
   * @param index - Zero-based sample index within a three-sample fragment.
   * @returns The presentation offset in 48 kHz ticks, including compositionShift.
   */
  const relativeTimestamp = (index: number) =>
    compositionShift + (reordered ? [2048, 0, 1024][index]! : index * 1024)

  /**
   * Builds one fragment with track metadata, sample runs, and media bytes.
   *
   * @param globalIndex - Zero-based fragment index in physical file order.
   * @returns The concatenated moof and mdat boxes.
   */
  function fragment(globalIndex: number) {
    const { track, index } = location(globalIndex)
    const tfhd = box('tfhd', words(0x02_00_00, track))
    const decode = new Uint8Array(8)
    new DataView(decode.buffer).setBigUint64(
      0,
      BigInt(index * samplesPerFragment * 1024),
    )
    const tfdtBox = tfdt
      ? box('tfdt', join([words(0x01_00_00_00), decode]))
      : new Uint8Array(0)

    /**
     * Builds a sample run with flags and composition offsets.
     *
     * @param from - Zero-based first sample index within the fragment.
     * @param count - Number of samples in this run.
     * @param offset - Byte offset from the moof start to this run's media bytes.
     * @returns A complete trun box using the configured version.
     */
    function trun(from: number, count: number, offset: number) {
      const entries = Array.from({ length: count }, (_, at) => {
        const sample = from + at
        return words(
          sample === 1 ? 0x00_01_00_00 : 0,
          relativeTimestamp(sample) - sample * 1024,
        )
      })
      return box(
        'trun',
        join([
          words(trunVersion * 0x01_00_00_00 + 0x0c_01, count, offset),
          ...entries,
        ]),
      )
    }

    /**
     * Builds fragment metadata with one or two sample runs.
     *
     * @param offset - Byte offset from the moof start to the first sample payload.
     * @returns A complete moof box with sequence, track, and optional decode-time metadata.
     */
    function moof(offset: number) {
      const runs = multipleRuns
        ? [trun(0, 1, offset), trun(1, 2, offset + 4)]
        : [trun(0, 3, offset)]
      return box(
        'moof',
        join([
          box('mfhd', words(0, globalIndex + 1)),
          box('traf', join([tfhd, tfdtBox, ...runs])),
        ]),
      )
    }
    const data = box(
      'mdat',
      join(
        Array.from({ length: samplesPerFragment }, (_, at) =>
          packet(track, index * samplesPerFragment + at),
        ),
      ),
    )
    const movie = moof(moof(0).length + 8)
    return join([movie, data])
  }
  const stride = fragment(0).length
  const mfraStart = fragmentStart + totalFragments * stride
  let indexOffset = mfraStart + 8 + indexPadding
  const indexes = trackCounts.map((count, at) => {
    const size = 24 + count * entrySize
    const offset = indexOffset
    indexOffset += size
    return {
      track: at + 1,
      count,
      start: offset,
      end: offset + size,
      entries: offset + 24,
    }
  })
  const mfraSize = indexed ? indexOffset + 16 - mfraStart : 0
  const size = mfraStart + mfraSize
  const reads: { start: number; end: number }[] = []
  const requests: { start: number; end: number }[] = []
  const patches = new Map<number, Uint8Array>()

  /**
   * Generates a requested range of the sparse file and applies byte patches.
   *
   * @param start - Inclusive byte offset in the virtual file.
   * @param end - Exclusive byte offset in the virtual file.
   * @returns Exactly end minus start bytes, with sparse gaps filled with zeros.
   */
  function readRange(start: number, end: number) {
    const result = new Uint8Array(end - start)

    /**
     * Copies the overlapping portion of a segment into the current range buffer.
     *
     * @param offset - Inclusive byte offset of the segment in the virtual file.
     * @param data - Segment bytes to intersect with the requested range.
     * @returns Nothing.
     */
    function copy(offset: number, data: Uint8Array) {
      const from = Math.max(start, offset)
      const to = Math.min(end, offset + data.length)
      if (from < to) {
        result.set(data.subarray(from - offset, to - offset), from - start)
      }
    }
    copy(0, init)
    if (padding) {
      copy(init.length, header('free', padding))
    }
    const first = Math.max(0, Math.floor((start - fragmentStart) / stride))
    const last = Math.min(
      totalFragments,
      Math.ceil((end - fragmentStart) / stride),
    )
    for (let at = first; at < last; at++) {
      copy(fragmentStart + at * stride, fragment(at))
    }
    if (indexed) {
      copy(mfraStart, header('mfra', mfraSize))
      if (indexPadding) {
        copy(mfraStart + 8, header('free', indexPadding))
      }
      for (const table of indexes) {
        const word = (widths[0] - 1) * 16 + (widths[1] - 1) * 4 + widths[2] - 1
        copy(
          table.start,
          join([
            header('tfra', table.end - table.start),
            words(version * 0x01_00_00_00, table.track, word, table.count),
          ]),
        )
        const from = Math.max(
          0,
          Math.floor((start - table.entries) / entrySize),
        )
        const to = Math.min(
          table.count,
          Math.ceil((end - table.entries) / entrySize),
        )
        for (let entry = from; entry < to; entry++) {
          const data = new Uint8Array(entrySize)
          let offset = 0

          /**
           * Appends a fixed-width big-endian integer to the current TFRA entry.
           *
           * @param value - Nonnegative integer to encode.
           * @param width - Number of bytes reserved for the integer.
           * @returns Nothing.
           */
          const write = (value: number, width: number) => {
            let remaining = value
            for (let at = width - 1; at >= 0; at--) {
              data[offset + at] = remaining % 256
              remaining = Math.floor(remaining / 256)
            }
            offset += width
          }
          write(
            entry * 3072 + relativeTimestamp(indexReference),
            version === 1 ? 8 : 4,
          )
          write(
            fragmentStart + physicalIndex(table.track, entry) * stride,
            version === 1 ? 8 : 4,
          )
          write(1, widths[0])
          write(multipleRuns && indexReference > 0 ? 2 : 1, widths[1])
          write(
            multipleRuns && indexReference > 0
              ? indexReference
              : indexReference + 1,
            widths[2],
          )
          copy(table.entries + entry * entrySize, data)
        }
      }
      copy(size - 16, box('mfro', words(0, mfraSize)))
    }
    for (const [offset, data] of patches) {
      copy(offset, data)
    }
    return result
  }
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
     * Generates a bounded source read and optionally records its byte range.
     *
     * @param start - Inclusive byte offset in the virtual file.
     * @param end - Exclusive byte offset in the virtual file.
     * @returns The requested virtual file bytes after an asynchronous boundary.
     * @throws {AssertionError} If the source read exceeds 256 KiB.
     */
    async read(start, end) {
      if (recordReads) {
        reads.push({ start, end })
      }
      assert.ok(
        end - start <= 256 * 1024,
        `Unbounded source read: ${end - start}`,
      )
      await Promise.resolve()
      return readRange(start, end)
    },
  })
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
      assert.ok(
        end - start <= 64 * 1024,
        `Unbounded parser read: ${end - start}`,
      )
      if (indexes.some(table => start >= table.entries && end <= table.end)) {
        assert.ok(end - start <= 16 * 1024)
      }
      return Reflect.apply(read, source, [start, end, ...args])
    },
  })
  return {
    source,
    reads,
    requests,
    patches,
    indexes,
    entrySize,
    size,
    fragmentStart,
    stride,
    mfraStart,
    fragments,
    trackCounts,
    samplesPerFragment,
    packet,

    /**
     * Materializes the initialization segment.
     *
     * @returns A Blob containing the ftyp and moov boxes.
     */
    initBlob: () => new Blob([init]),

    /**
     * Materializes all media fragments without initialization or trailing indexes.
     *
     * @returns A Blob containing the generated moof and mdat boxes.
     */
    segmentBlob: () => new Blob([readRange(fragmentStart, mfraStart)]),

    /**
     * Calculates a sample presentation timestamp across fragments.
     *
     * @param index - Zero-based sample index within a track.
     * @returns The presentation timestamp in seconds.
     */
    timestamp: (index: number) =>
      (Math.floor(index / 3) * 3072 + relativeTimestamp(index % 3)) / 48_000,

    /**
     * Resolves the absolute byte offset of a track fragment.
     *
     * @param track - One-based track identifier.
     * @param index - Zero-based fragment index within the track.
     * @returns The byte offset of the fragment's moof box.
     */
    fragmentOffset: (track: number, index: number) =>
      fragmentStart + physicalIndex(track, index) * stride,

    /**
     * Materializes the complete virtual file for small fixtures.
     *
     * @returns A Blob containing initialization, fragments, indexes, and patches.
     * @throws {AssertionError} If the virtual file size is at least 64 MiB.
     */
    blob() {
      assert.ok(size < 64 * 1024 * 1024)
      return new Blob([readRange(0, size)])
    },
  }
}
