/* oxlint-disable no-await-in-loop -- Block headers and lace sizes are read in order. */

import { isInteger, isUndefined } from '@ntnyq/utils'
import { REMUX_ERROR_CODE, MKV_ID } from '../../constants'
import type { BlockGroup, MkvBlock, MkvElement } from '../../types'
import { createRemuxError, invalidMkv, readVint } from '../../utils'
import { readI16Be, readU8 } from '../../vendor/mediabunny/src/reader'
import type { MkvReader } from './MkvReader'

/**
 * Reads block-group metadata by range, leaving the Block payload untouched.
 *
 * @param reader - Range reader for the Matroska input.
 * @param group - BlockGroup element whose direct children are inspected.
 * @returns A promise resolving to group metadata with its required Block element.
 * @throws If the group is malformed or lacks exactly one Block.
 */
async function readBlockGroup(reader: MkvReader, group: MkvElement) {
  const result: BlockGroup = { hasReference: false, hasCodecChanges: false }

  for await (const element of reader.children(group)) {
    switch (element.id) {
      case MKV_ID.block:
        if (result.block) {
          throw invalidMkv('Multiple Block elements in an MKV BlockGroup.')
        }

        result.block = element
        break
      case MKV_ID.blockDuration:
        result.duration = element
        break
      case MKV_ID.referenceBlock:
        result.hasReference = true
        break
      case MKV_ID.discardPadding:
        result.discardPadding = element
        break
      case MKV_ID.codecState:
      case MKV_ID.blockAdditions:
        result.hasCodecChanges = true
        break
    }
  }

  if (!result.block) {
    throw invalidMkv('Missing Block in an MKV BlockGroup.')
  }

  return { ...result, block: result.block }
}

/**
 * Walks one MKV track's blocks in file (decode) order.
 *
 * @param reader - Range reader for the Matroska input.
 * @param segment - Segment containing the clusters and blocks to scan.
 * @param track - Track number, timestamp multiplier, and codec delay (in nanoseconds).
 * @param tick - Segment timestamp scale in nanoseconds per tick.
 * @yields {MkvBlock} Block payload locations and timing in seconds.
 * @throws If block structure, timestamps, or selected block features are invalid or unsupported.
 */
export async function* readMkvBlocks(
  reader: MkvReader,
  segment: MkvElement,
  track: {
    number: number
    timestampScale: number
    codecDelay: number
  },
  tick: number,
) {
  for await (const cluster of reader.children(segment)) {
    if (cluster.id !== MKV_ID.cluster) {
      continue
    }

    let timestamp: number | undefined

    for await (const element of reader.children(cluster)) {
      if (element.id === MKV_ID.timestamp) {
        timestamp = await reader.uint(element)
        break
      }
    }

    if (isUndefined(timestamp)) {
      throw invalidMkv('Missing MKV Cluster timestamp.')
    }

    for await (const element of reader.children(cluster)) {
      if (
        element.id !== MKV_ID.simpleBlock &&
        element.id !== MKV_ID.blockGroup
      ) {
        continue
      }

      const group =
        element.id === MKV_ID.blockGroup
          ? await readBlockGroup(reader, element)
          : undefined
      const block = group?.block ?? element
      const header = await reader.slice(
        block.data,
        Math.min(11, block.end - block.data),
      )
      const number = readVint(header).value

      if (
        !Number.isSafeInteger(number) ||
        number <= 0 ||
        header.remainingLength < 3
      ) {
        throw invalidMkv('Invalid MKV block header.')
      }

      if (number !== track.number) {
        continue
      }

      const relativeTimestamp = readI16Be(header)
      const flags = readU8(header)

      if (
        group?.hasCodecChanges ||
        (group?.discardPadding &&
          (await reader.hasNonzeroInteger(group.discardPadding)))
      ) {
        throw createRemuxError(
          REMUX_ERROR_CODE.unsupportedMediaFeature,
          'MKV block additions, codec state changes, and discard padding are unsupported.',
        )
      }

      const presentationTime =
        Math.round(
          (timestamp + relativeTimestamp * track.timestampScale) * tick -
            track.codecDelay,
        ) / 1e9

      if (!Number.isFinite(presentationTime)) {
        throw invalidMkv('Invalid MKV block timestamp.')
      }

      yield {
        offset: header.filePos,
        end: block.end,
        timestamp: presentationTime,
        isKey: group ? !group.hasReference : (flags & 0x80) !== 0,
        lacing: (flags >> 1) & 3,
        ...(group?.duration
          ? {
              duration:
                ((await reader.uint(group.duration)) *
                  track.timestampScale *
                  tick) /
                1e9,
            }
          : {}),
      } satisfies MkvBlock
    }
  }
}

/**
 * Resolves the byte lengths of the frames in a laced MKV block.
 * The first lace byte gives the frame count minus one. In Xiph and EBML
 * lacing the last frame occupies the remaining bytes.
 *
 * @param reader - Range reader for the block's lace headers.
 * @param block - Block payload bounds and lacing mode.
 * @returns A promise resolving to the first frame's byte offset and all frame sizes.
 * @throws If the block is empty or its lace metadata is invalid.
 */
export async function readMkvFrameLayout(reader: MkvReader, block: MkvBlock) {
  if (block.offset >= block.end) {
    throw invalidMkv('Empty MKV block.')
  }

  if (block.lacing === 0) {
    return { firstFrameOffset: block.offset, sizes: [block.end - block.offset] }
  }

  const count = readU8(await reader.slice(block.offset, 1)) + 1

  if (count === 1) {
    throw invalidMkv('MKV lacing requires at least two frames.')
  }

  let offset = block.offset + 1
  const sizes: number[] = []
  let used = 0
  let previous = 0

  if (block.lacing === 2) {
    const size = (block.end - offset) / count

    if (!isInteger(size) || size <= 0) {
      throw invalidMkv('Invalid fixed-size MKV lace.')
    }

    return { firstFrameOffset: offset, sizes: Array<number>(count).fill(size) }
  }

  for (let index = 0; index < count - 1; index++) {
    let size = 0

    if (block.lacing === 1) {
      let byte: number

      do {
        if (offset + used + size >= block.end) {
          throw invalidMkv('Invalid Xiph MKV lace.')
        }

        byte = readU8(await reader.slice(offset++, 1))
        size += byte
      } while (byte === 255)
    } else {
      const slice = await reader.slice(offset, Math.min(8, block.end - offset))
      const { value } = readVint(slice, index !== 0)

      offset = slice.filePos

      if (!Number.isSafeInteger(value)) {
        throw invalidMkv('Invalid MKV lace size or difference.')
      }

      size = index === 0 ? value : previous + value
    }

    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      offset + used + size >= block.end
    ) {
      throw invalidMkv('Invalid frame size in MKV lace.')
    }

    sizes.push(size)
    used += size
    previous = size
  }

  const remainder = block.end - offset - used

  if (remainder <= 0) {
    throw invalidMkv('Truncated MKV lace.')
  }

  sizes.push(remainder)

  return { firstFrameOffset: offset, sizes }
}
