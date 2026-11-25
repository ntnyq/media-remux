/**
 * Compares decoder descriptions by length and byte contents.
 *
 * @param left - First decoder description.
 * @param right - Second decoder description.
 * @returns Whether both buffers contain identical bytes.
 */
export function areBytesSame(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  )
}
