import { REMUX_ERROR_CODE } from '../constants'
import { readU8 } from '../vendor/mediabunny/src/reader'
import type { FileSlice } from '../vendor/mediabunny/src/reader'
import { createRemuxError } from './errors'

/**
 * Creates the remux error used for malformed or truncated Matroska data.
 *
 * @param message - Diagnostic describing the invalid data.
 * @returns An error carrying the invalid-input remux code.
 */
export function invalidMkv(message: string) {
  return createRemuxError(REMUX_ERROR_CODE.invalidInput, message)
}

/**
 * Reads the EBML variable-length integer and its encoded width. The same
 * bits mean an unknown size only when used in an element size field.
 *
 * @param slice - Input slice positioned at the first byte of the integer.
 * @returns The marker-stripped value, byte width, and whether all value bits are set.
 * @throws If the integer is truncated or has an invalid encoded width.
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
