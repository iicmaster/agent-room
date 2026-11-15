// Bounded main-thread write queue (Story 1.1): fair per-session batching,
// optional coalescing (e.g. session-principal heartbeats), cap enforcement,
// async SQLite busy backoff, and bounded shutdown draining.
//
// Pure queue / scheduling module: imports only constants from ../constants.mjs
// so store, domain, and API layers share one dependency-free WriteQueuePort.

import {
  WRITE_QUEUE_BATCH_MAX,
  WRITE_QUEUE_BUSY_BUDGET_MS,
  WRITE_QUEUE_DRAIN_MS,
  WRITE_QUEUE_FLUSH_MS,
  WRITE_QUEUE_MAX_BYTES,
  WRITE_QUEUE_MAX_OPS,
  WRITE_QUEUE_PER_SESSION_MAX,
  WRITE_QUEUE_RETRY_BASE_MS,
  WRITE_QUEUE_RETRY_MAX_MS,
} from '../constants.mjs'

const SQLITE_BUSY_CODE = 5

function invalidArgument(message) {
  const error = new Error(message)
  error.code = 'invalid_argument'
  return error
}

export function createQueueFullError(
  retryAfterMs,
  message = 'write queue capacity exceeded; retry after backoff',
) {
  const error = new Error(message)
  error.code = 'queue_full'
  error.retry_after_ms = Math.max(1, Math.trunc(retryAfterMs))
  return error
}

export function isDatabaseBusyError(error) {
  if (!error || typeof error !== 'object') return false
  if (error.code === 'database_busy') return true
  if (typeof error.errcode === 'number' && (error.errcode & 0xff) === SQLITE_BUSY_CODE) {
    return true
  }
  return false
}

function assertPositiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidArgument(`${name} must be a positive safe integer`)
  }
}

export function createWriteQueue({
  runBatch,
  nowMs = Date.now,
  flushMs = WRITE_QUEUE_FLUSH_MS,
  batchMax = WRITE_QUEUE_BATCH_MAX,
  maxOps = WRITE_QUEUE_MAX_OPS,
  maxBytes = WRITE_QUEUE_MAX_BYTES,
  perSessionMax = WRITE_QUEUE_PER_SESSION_MAX,
  retryBaseMs = WRITE_QUEUE_RETRY_BASE_MS,
  retryMaxMs = WRITE_QUEUE_RETRY_MAX_MS,
  busyBudgetMs = WRITE_QUEUE_BUSY_BUDGET_MS,
  drainMs = WRITE_QUEUE_DRAIN_MS,
} = {}) {
  if (typeof runBatch !== 'function') {
    throw invalidArgument('write queue requires a runBatch function')
  }
  if (typeof nowMs !== 'function') {
    throw invalidArgument('write queue nowMs must be a function')
  }
  assertPositiveInt(flushMs, 'flushMs')
  assertPositiveInt(batchMax, 'batchMax')
  assertPositiveInt(maxOps, 'maxOps')
  assertPositiveInt(maxBytes, 'maxBytes')
  assertPositiveInt(perSessionMax, 'perSessionMax')
  assertPositiveInt(retryBaseMs, 'retryBaseMs')
  assertPositiveInt(retryMaxMs, 'retryMaxMs')
  assertPositiveInt(busyBudgetMs, 'busyBudgetMs')
  assertPositiveInt(drainMs, 'drainMs')

  // sessionKey -> Entry[]
  const sessionQueues = new Map()
  // FIFO order of sessionKeys with >= 1 pending entry for fair round-robin
  const activeSessions = []
  // sessionKey -> count of in-flight entries currently executing/retrying
  const sessionInFlight = new Map()

  let pendingOps = 0
  let pendingBytes = 0
  let inFlightOps = 0
  let inFlightBytes = 0

  let maxDepth = 0
  let batchesTotal = 0
  let committedTotal = 0
  let rejectedTotal = 0
  let busyRetriesTotal = 0
  let coalescedTotal = 0

  let running = false
  let draining = false
  let closed = false

  // Active timer tracking (either scheduled flush or busy-backoff sleep)
  let flushTimer = null // { kind: 'immediate' | 'timeout', handle }
  let backoffTimer = null
  let resolveBackoffSleep = null

  let drainWaiters = []
  let activeDrainPromise = null

  function currentDepth() {
    return pendingOps + inFlightOps
  }

  function currentBytes() {
    return pendingBytes + inFlightBytes
  }

  function updateHighWater() {
    const depth = currentDepth()
    if (depth > maxDepth) maxDepth = depth
  }

  function computeRetryAfterMs() {
    const queuedBatches = Math.max(1, Math.ceil((currentDepth() + 1) / batchMax))
    return Math.min(busyBudgetMs, Math.max(flushMs, queuedBatches * flushMs))
  }

  function clearFlushTimer() {
    if (!flushTimer) return
    if (flushTimer.kind === 'immediate') clearImmediate(flushTimer.handle)
    else clearTimeout(flushTimer.handle)
    flushTimer = null
  }

  function clearBackoffSleep(cancelled = false) {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer)
      backoffTimer = null
    }
    const wake = resolveBackoffSleep
    resolveBackoffSleep = null
    if (wake) wake(!cancelled)
  }

  function schedulePump(immediate) {
    if (closed || running || pendingOps === 0) return
    const kind = immediate ? 'immediate' : 'timeout'
    if (flushTimer) {
      if (flushTimer.kind === kind || flushTimer.kind === 'immediate') return
      clearFlushTimer()
    }
    if (immediate) {
      const handle = setImmediate(() => {
        flushTimer = null
        void pump()
      })
      flushTimer = { kind: 'immediate', handle }
    } else {
      const handle = setTimeout(() => {
        flushTimer = null
        void pump()
      }, flushMs)
      flushTimer = { kind: 'timeout', handle }
    }
  }

  function dequeueBatch() {
    const batch = []
    while (batch.length < batchMax && activeSessions.length > 0) {
      const sessionKey = activeSessions.shift()
      const queue = sessionQueues.get(sessionKey)
      if (!queue || queue.length === 0) {
        sessionQueues.delete(sessionKey)
        continue
      }
      const entry = queue.shift()
      pendingOps -= 1
      pendingBytes -= entry.bytes
      inFlightOps += 1
      inFlightBytes += entry.bytes
      sessionInFlight.set(sessionKey, (sessionInFlight.get(sessionKey) ?? 0) + 1)
      batch.push(entry)
      if (queue.length > 0) {
        activeSessions.push(sessionKey)
      } else {
        sessionQueues.delete(sessionKey)
      }
    }
    return batch
  }

  function releaseBatchAccounting(batch) {
    for (const entry of batch) {
      inFlightOps -= 1
      inFlightBytes -= entry.bytes
      const prev = sessionInFlight.get(entry.sessionKey) ?? 0
      if (prev <= 1) sessionInFlight.delete(entry.sessionKey)
      else sessionInFlight.set(entry.sessionKey, prev - 1)
    }
  }

  function rejectBatchEntries(batch, error) {
    releaseBatchAccounting(batch)
    for (const entry of batch) {
      rejectedTotal += 1
      for (const waiter of entry.waiters) waiter.reject(error)
    }
  }

  function rejectAllPending(error) {
    clearFlushTimer()
    while (activeSessions.length > 0) {
      const sessionKey = activeSessions.shift()
      const queue = sessionQueues.get(sessionKey)
      sessionQueues.delete(sessionKey)
      if (!queue) continue
      for (const entry of queue) {
        pendingOps -= 1
        pendingBytes -= entry.bytes
        rejectedTotal += 1
        for (const waiter of entry.waiters) waiter.reject(error)
      }
    }
  }

  function sleepBackoff(delayMs) {
    return new Promise(resolve => {
      resolveBackoffSleep = resolve
      backoffTimer = setTimeout(() => {
        backoffTimer = null
        const wake = resolveBackoffSleep
        resolveBackoffSleep = null
        if (wake) wake(true)
      }, delayMs)
    })
  }

  function notifyDrained() {
    if (pendingOps > 0 || running || inFlightOps > 0) return
    const waiters = drainWaiters
    drainWaiters = []
    for (const finish of waiters) {
      finish({ drained: true, timedOut: false, remaining: 0 })
    }
  }

  async function executeBatch(batch) {
    const startedAt = nowMs()
    let attempt = 0

    while (true) {
      if (closed) {
        rejectBatchEntries(batch, createQueueFullError(retryMaxMs, 'write queue closed; retry after backoff'))
        return
      }
      try {
        const outcomes = runBatch(batch)
        if (!Array.isArray(outcomes) || outcomes.length !== batch.length) {
          throw new Error('runBatch must return one outcome per queued op')
        }
        releaseBatchAccounting(batch)
        batchesTotal += 1
        for (let i = 0; i < batch.length; i += 1) {
          const entry = batch[i]
          const outcome = outcomes[i]
          if (outcome?.ok) {
            committedTotal += 1
            for (const waiter of entry.waiters) waiter.resolve(outcome.result)
          } else {
            const err = outcome?.error ?? new Error('queued write failed')
            for (const waiter of entry.waiters) waiter.reject(err)
          }
        }
        return
      } catch (error) {
        if (!isDatabaseBusyError(error)) {
          rejectBatchEntries(batch, error)
          return
        }
        const elapsed = Math.max(0, nowMs() - startedAt)
        const remainingBudget = busyBudgetMs - elapsed
        if (remainingBudget <= 0 || closed) {
          rejectBatchEntries(
            batch,
            createQueueFullError(
              retryMaxMs,
              'database write lock remained busy beyond retry budget; retry after backoff',
            ),
          )
          return
        }
        const expDelay = Math.min(retryMaxMs, retryBaseMs * (2 ** attempt))
        const delayMs = Math.max(1, Math.min(expDelay, remainingBudget))
        attempt += 1
        busyRetriesTotal += 1
        const shouldContinue = await sleepBackoff(delayMs)
        if (!shouldContinue || closed) {
          rejectBatchEntries(
            batch,
            createQueueFullError(retryMaxMs, 'write queue interrupted during busy backoff'),
          )
          return
        }
      }
    }
  }

  async function pump() {
    if (running || closed) return
    running = true
    try {
      if (!closed && pendingOps > 0) {
        const batch = dequeueBatch()
        if (batch.length > 0) {
          await executeBatch(batch)
        }
      }
    } finally {
      running = false
      if (!closed && pendingOps > 0) {
        schedulePump(draining || pendingOps >= batchMax)
      } else {
        notifyDrained()
      }
    }
  }

  function enqueue(op) {
    if (!op || typeof op !== 'object') {
      throw invalidArgument('enqueue requires an operation descriptor object')
    }
    const {
      sessionKey,
      bytes = 0,
      coalesceKey = null,
      payload,
      validateFence,
      execute,
    } = op

    if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
      throw invalidArgument('enqueue requires a non-empty sessionKey')
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw invalidArgument('enqueue requires non-negative integer bytes')
    }
    if (coalesceKey !== null && (typeof coalesceKey !== 'string' || coalesceKey.length === 0)) {
      throw invalidArgument('coalesceKey must be null or a non-empty string')
    }
    if (typeof execute !== 'function') {
      throw invalidArgument('enqueue requires an execute function')
    }

    if (draining || closed) {
      rejectedTotal += 1
      return Promise.reject(createQueueFullError(retryMaxMs, 'server is shutting down; retry after backoff'))
    }

    const existingQueue = sessionQueues.get(sessionKey)
    if (coalesceKey !== null && existingQueue) {
      const existing = existingQueue.find(entry => entry.coalesceKey === coalesceKey)
      if (existing) {
        if (existing.waiters.length >= maxOps) {
          rejectedTotal += 1
          return Promise.reject(createQueueFullError(computeRetryAfterMs()))
        }
        const projectedTotalBytes = currentBytes() - existing.bytes + bytes
        if (projectedTotalBytes > maxBytes) {
          rejectedTotal += 1
          return Promise.reject(createQueueFullError(computeRetryAfterMs()))
        }
        pendingBytes += bytes - existing.bytes
        existing.bytes = bytes
        existing.payload = payload
        existing.validateFence = validateFence
        existing.execute = execute
        coalescedTotal += 1
        return new Promise((resolve, reject) => {
          existing.waiters.push({ resolve, reject })
        })
      }
    }

    const sessionDepth = (existingQueue ? existingQueue.length : 0) + (sessionInFlight.get(sessionKey) ?? 0)
    if (
      currentDepth() >= maxOps
      || currentBytes() + bytes > maxBytes
      || sessionDepth >= perSessionMax
    ) {
      rejectedTotal += 1
      return Promise.reject(createQueueFullError(computeRetryAfterMs()))
    }

    return new Promise((resolve, reject) => {
      const wasEmpty = currentDepth() === 0
      const entry = {
        sessionKey,
        bytes,
        coalesceKey,
        payload,
        validateFence,
        execute,
        waiters: [{ resolve, reject }],
      }
      if (existingQueue) {
        existingQueue.push(entry)
      } else {
        sessionQueues.set(sessionKey, [entry])
        activeSessions.push(sessionKey)
      }
      pendingOps += 1
      pendingBytes += bytes
      updateHighWater()
      if (!running) {
        schedulePump(wasEmpty || draining || pendingOps >= batchMax)
      }
    })
  }

  function drain(timeoutMs = drainMs) {
    assertPositiveInt(timeoutMs, 'timeoutMs')
    draining = true
    if (pendingOps === 0 && !running && inFlightOps === 0) {
      closed = true
      clearFlushTimer()
      return Promise.resolve({ drained: true, timedOut: false, remaining: 0 })
    }
    if (activeDrainPromise) return activeDrainPromise

    // Speed up any pending partial-batch timer during shutdown.
    if (!running && pendingOps > 0) {
      clearFlushTimer()
      schedulePump(true)
    }

    activeDrainPromise = new Promise(resolve => {
      let settled = false
      const deadline = setTimeout(() => {
        if (settled) return
        settled = true
        closed = true
        clearBackoffSleep(true)
        const remaining = currentDepth()
        rejectAllPending(createQueueFullError(retryMaxMs, 'write queue drain deadline exceeded'))
        drainWaiters = drainWaiters.filter(fn => fn !== finish)
        resolve({ drained: remaining === 0, timedOut: true, remaining })
      }, timeoutMs)

      function finish(outcome) {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        closed = true
        resolve(outcome)
      }

      drainWaiters.push(finish)
      if (pendingOps === 0 && !running && inFlightOps === 0) {
        notifyDrained()
      }
    })
    return activeDrainPromise
  }

  function abort() {
    closed = true
    draining = true
    clearFlushTimer()
    clearBackoffSleep(true)
    const abortError = createQueueFullError(retryMaxMs, 'write queue closed; retry after backoff')
    rejectAllPending(abortError)
    const waiters = drainWaiters
    drainWaiters = []
    const remaining = currentDepth()
    for (const finish of waiters) {
      finish({ drained: remaining === 0, timedOut: false, remaining })
    }
  }

  function getMetrics() {
    return {
      depth: currentDepth(),
      max_depth: maxDepth,
      bytes: currentBytes(),
      batches_total: batchesTotal,
      committed_total: committedTotal,
      rejected_total: rejectedTotal,
      busy_retries_total: busyRetriesTotal,
      coalesced_total: coalescedTotal,
    }
  }

  return Object.freeze({
    enqueue,
    drain,
    abort,
    getMetrics,
  })
}
