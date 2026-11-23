// Browser stand-in for Node's `assert`, which the SCALE codec packages import. Vite maps `assert` here.
function assert(cond: unknown, msg?: string | Error): asserts cond {
  if (!cond) throw msg instanceof Error ? msg : new Error(msg ?? 'assertion failed')
}
assert.ok = assert
assert.strictEqual = (a: unknown, b: unknown, msg?: string) => assert(a === b, msg ?? `expected ${String(a)} === ${String(b)}`)
assert.notStrictEqual = (a: unknown, b: unknown, msg?: string) => assert(a !== b, msg ?? `expected ${String(a)} !== ${String(b)}`)
assert.equal = assert.strictEqual
assert.notEqual = assert.notStrictEqual
assert.fail = (msg?: string): never => { throw new Error(msg ?? 'assertion failed') }
assert.deepStrictEqual = (a: unknown, b: unknown, msg?: string) => assert(JSON.stringify(a) === JSON.stringify(b), msg ?? 'expected deep equality')
export default assert
export { assert }
