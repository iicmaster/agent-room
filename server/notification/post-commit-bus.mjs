// Story 3.1: the post-commit fan-out bus. The store calls publish() ONLY
// after a batch's COMMIT FULL, once per genuinely new message insert. This
// module owns no SQL, no connection, no transaction — it is a pure in-memory
// fan-out with a bounded byte queue per subscriber.
//
// Two invariants make it safe on the commit path:
//   1. A listener fault NEVER propagates out of publish() — the receipt is
//      already committed and must not be rolled back by a downstream error.
//   2. Each subscriber's queue is bounded (maxQueueBytes). A subscriber that
//      does not drain fast enough is evicted and told to rescan, rather than
//      growing memory without limit or blocking the commit.
//
// Listener signature: listener(event, control) where control exposes drain()
// (drop the just-delivered entry from this subscriber's queue) and
// queuedBytes(). A synchronous listener that does not call drain() is drained
// automatically after it returns; an async listener's entry stays queued
// until its promise settles. That is what bounds a stalled/slow consumer.

import { WATCH_OUTBOUND_BUFFER_MAX_BYTES } from '../constants.mjs'

export { WATCH_OUTBOUND_BUFFER_MAX_BYTES }

export function createPostCommitBus({ maxQueueBytes = WATCH_OUTBOUND_BUFFER_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxQueueBytes) || maxQueueBytes < 1) {
    throw new TypeError('maxQueueBytes must be a positive safe integer')
  }
  // id -> { id, listener, queue: [{ event, bytes }] }
  const subscribers = new Map()

  function evict(sub, reason) {
    if (subscribers.get(sub.id) !== sub) return
    subscribers.delete(sub.id)
    sub.queue.length = 0
    // Notify through the listener itself so subscribe() stays a two-arg
    // surface; a rescan event is the one exception to the "message" event.
    try {
      sub.listener({ event: 'rescan_required', reason, ts: new Date().toISOString() })
    } catch {
      // Listener faults never propagate (invariant 1).
    }
  }

  return Object.freeze({
    subscribe(id, listener, { manualDrain = false } = {}) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('subscriber id must be a non-empty string')
      }
      if (typeof listener !== 'function') {
        throw new TypeError('listener must be a function')
      }
      const sub = { id, listener, queue: [], manualDrain: manualDrain === true }
      subscribers.set(id, sub)
      let active = true
      return function unsubscribe() {
        if (!active) return
        active = false
        if (subscribers.get(id) === sub) subscribers.delete(id)
        sub.queue.length = 0
      }
    },

    publish(event) {
      let bytes = 0
      try {
        bytes = Buffer.byteLength(JSON.stringify(event))
      } catch {
        bytes = 0
      }
      for (const sub of [...subscribers.values()]) {
        const entry = { event, bytes }
        sub.queue.push(entry)
        if (sub.queue.reduce((sum, item) => sum + item.bytes, 0) > maxQueueBytes) {
          evict(sub, 'slow_consumer')
          continue
        }
        const control = {
          drain() {
            const index = sub.queue.indexOf(entry)
            if (index !== -1) sub.queue.splice(index, 1)
          },
          queuedBytes() {
            return sub.queue.reduce((sum, item) => sum + item.bytes, 0)
          },
        }
        let result
        try {
          result = sub.listener(event, control)
        } catch {
          // Listener faults never propagate (invariant 1).
        }
        if (result && typeof result.then === 'function') {
          // Async listener: keep the entry queued until it settles, then
          // drain. A reject is swallowed — never a commit-path throw.
          result.then(control.drain, control.drain)
        } else if (!sub.manualDrain && sub.queue.includes(entry)) {
          // Sync listener without manualDrain opt-in drains immediately; slow
          // stream consumers opt into manualDrain so socket backpressure stays
          // accounted against maxQueueBytes.
          control.drain()
        }
      }
    },

    subscriberCount() {
      return subscribers.size
    },

    clear() {
      subscribers.clear()
    },
  })
}
