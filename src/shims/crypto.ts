// Browser stand-in for the few Node `crypto` names the SDK imports. Everything maps onto WebCrypto.
export const webcrypto = globalThis.crypto
export const subtle = globalThis.crypto.subtle
export const randomUUID = () => globalThis.crypto.randomUUID()
export const getRandomValues = <T extends ArrayBufferView>(a: T) => globalThis.crypto.getRandomValues(a as never) as T
export function randomBytes(n: number) {
  const b = new Uint8Array(n)
  globalThis.crypto.getRandomValues(b)
  return b
}
export default { webcrypto, subtle, randomUUID, getRandomValues, randomBytes }
