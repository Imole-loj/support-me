/** UTF-8 byte length used by the Soroban donation memo limit. */
export function memoByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
