/** Reject offsets and lengths that cannot be represented exactly by file and HTTP APIs. */
export function validateReadRange(start: number, length: number): void {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    start + length > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError('invalid storage byte range');
  }
}
