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
 * Reads an EBML variable-length integer and its encoded width. All value bits
 * being set denotes an unknown size only when reading an element size.
 *
 * @param slice - Input slice positioned at the first byte of the integer.
 * @param signed - Whether to apply the signed EBML lacing bias.
 * @returns The decoded value, byte width, and whether all value bits are set.
 * @throws If the integer is truncated or has an invalid encoded width.
 */
export function readVint(slice: FileSlice, signed = false) {
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

  if (signed) {
    // Subtract the bias's power-of-two part before accumulating the remaining
    // bytes so small lace differences stay exact even with an eight-byte VINT.
    value -= 2 ** (7 - width)
  }

  for (let i = 1; i < width; i++) {
    const byte = readU8(slice)

    value = value * 256 + byte
    allOnes &&= byte === 0xff
  }

  return { value: signed ? value + 1 : value, width, allOnes }
}
