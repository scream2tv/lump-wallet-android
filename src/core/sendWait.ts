// How a send ends.
//
// The SDK answers a send when the node reports the transaction final. That report comes over a connection of its
// own, and a phone that was put aside for a moment can lose it for good: the transaction is in a block, and the send
// is still "waiting". So the wallet's own sync is asked as well, every few seconds. Once it has recorded the
// transaction in a block the send is over. With neither after the limit the send ends as "not confirmed yet": the
// transaction may still land, so nothing it booked is released (sync, or the transaction's own time limit, settles it).

/** A send that was handed to the network and has not been seen in a block within the limit. */
export class NotConfirmedYet extends Error {
  constructor() { super('sent, but the network has not confirmed it yet') }
}

/** A send normally ends in about 20 s (the node reports it final). */
export const SEND_LIMIT_MS = 90_000
const LOOK_EVERY_MS = 3_000

/**
 * `send`: the SDK's own answer (the transaction's id). `landed`: what this wallet's sync has recorded for the
 * transaction, its id when it is in a block, else null; a look that fails is a look that saw nothing.
 * Resolves with the id from whichever comes first, rejects with the send's own error, or with NotConfirmedYet.
 */
export async function sendSettled(send: Promise<string>, landed: () => Promise<string | null>, limitMs = SEND_LIMIT_MS, everyMs = LOOK_EVERY_MS): Promise<string> {
  let over = false
  const bySync = (async (): Promise<string> => {
    const until = Date.now() + limitMs
    while (!over && Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(everyMs, Math.max(0, until - Date.now()))))
      if (over) break
      const id = await landed().catch(() => null)
      if (id) return id
    }
    // the send answered meanwhile: this side says nothing more
    if (over) return new Promise<string>(() => {})
    throw new NotConfirmedYet()
  })()
  try {
    return await Promise.race([send, bySync])
  } finally {
    over = true
    // whichever is still open may end later; that is nobody's error any more
    send.catch(() => {})
    bySync.catch(() => {})
  }
}
