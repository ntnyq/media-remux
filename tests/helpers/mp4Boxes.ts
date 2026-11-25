import assert from 'node:assert/strict'

/**
 * Reads ordinary sibling boxes from the small remux output.
 *
 * @param bytes - Complete MP4 boxes.
 * @param type - Box FourCC to select.
 * @returns Payloads of matching boxes in file order.
 */
export function boxPayloads(bytes: Buffer, type: string) {
  const payloads: Buffer[] = []

  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset)

    assert.ok(size >= 8 && offset + size <= bytes.length)

    if (bytes.toString('ascii', offset + 4, offset + 8) === type) {
      payloads.push(bytes.subarray(offset + 8, offset + size))
    }

    offset += size
  }

  return payloads
}
