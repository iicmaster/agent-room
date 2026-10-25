// The one middleware pipeline (spine AD-7, Story 1.3): protocol → transport →
// auth → budgets → authz → handler, assembled per route class from the frozen
// route table. Actor and pre-auth classes run all stages; viewer and health
// classes skip the protocol stage. The order is a fixed construction: the
// assembly asserts it, runPipeline re-asserts it before every run, and a
// reordered pipeline fails the order assertion.
//
// Invariants proven by tests/api-host.test.mjs: a rejection at any stage — in
// any class — never reaches the handler, never runs a later stage, and never
// mutates the store; handlers contain no gate logic; unknown request fields
// are rejected, not ignored; every error's HTTP status comes from
// PUBLIC_ERROR_STATUS in ../constants.mjs, never per-route.

import {
  FRAME_MAX_BYTES,
  PROTOCOL_HEADER,
  PUBLIC_ERRORS,
  PUBLIC_ERROR_STATUS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'
import { FORWARDED_FOR_HEADER, enrollClientIdentity } from './enroll-rate-limit.mjs'

// Canonical stage order (AD-7). The handler is not a stage; it runs after the
// last stage and only if every stage passed.
export const PIPELINE_STAGE_ORDER = Object.freeze([
  'protocol',
  'transport',
  'auth',
  'budgets',
  'authz',
])

// Stage classes that skip the protocol header check (AD-7: browsers and
// EventSource cannot set custom headers).
const PROTOCOL_APPLIES_TO = Object.freeze(['actor', 'pre-auth'])

// Classes with no session token to verify: pre-auth routes perform their own
// credential checks (Story 1.4) and health is unauthenticated by definition.
const AUTH_PASSES_THROUGH = Object.freeze(['pre-auth', 'health'])

// Loopback transport (AD-10: Local Mode is configuration). The host binds
// loopback only; this stage is defense in depth for that configuration.
const LOOPBACK_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const BODY_METHODS = new Set(['POST', 'PATCH'])

// Declared per-code extras for the error envelope (the additive AD-8
// vocabulary): a code may carry ONLY the extra field names listed here, and a
// name that would clobber one of the envelope's fixed fields is a
// construction-time error — extras can never overwrite ok, code, message, or
// status. Story 1.7's amendment declared exactly one entry:
// ambiguous_chat_id's optional candidates list. Story 4.4's amendment adds
// the second: rate_limited's retry_after_ms — FR-17's demand that the
// rate_limited refusal always names its retry delay.
export const ERROR_ENVELOPE_EXTRAS = Object.freeze({
  ambiguous_chat_id: Object.freeze(['candidates']),
  rate_limited: Object.freeze(['retry_after_ms']),
})

const ENVELOPE_FIXED_FIELDS = new Set(['ok', 'code', 'message', 'status'])

for (const [code, names] of Object.entries(ERROR_ENVELOPE_EXTRAS)) {
  for (const name of names) {
    if (ENVELOPE_FIXED_FIELDS.has(name)) {
      throw new AgentRoomRuntimeError(
        'invalid_argument',
        `error-envelope extra "${name}" for ${code} would clobber a fixed envelope field`,
      )
    }
  }
}

function declaredExtras(code, source) {
  const allowed = ERROR_ENVELOPE_EXTRAS[code]
  if (allowed === undefined || source === undefined || source === null) return {}
  const picked = {}
  for (const name of allowed) {
    if (source[name] !== undefined) picked[name] = source[name]
  }
  return picked
}

// Shared reject helper: builds the failure outcome for a wire-visible error.
// The HTTP status always comes from PUBLIC_ERROR_STATUS (AD-9); a code that is
// not whitelisted falls back to `request_failed` per AD-8 ("unknown →
// request_failed", v0.1 ratified) and never leaks its raw name or message.
// request_failed is 500: an internal fault must not masquerade as a missing
// route, and the 5xx class must stay reachable. The optional extra object
// contributes only the extras declared for the code (see
// ERROR_ENVELOPE_EXTRAS) — anything else is dropped, so a rejection keeps its
// exact pre-declaration shape unless the code declared the field.
export function reject(code, message, extra) {
  const status = PUBLIC_ERROR_STATUS[code]
  if (status === undefined) {
    return {
      ok: false,
      code: 'request_failed',
      message: PUBLIC_ERRORS.request_failed,
      status: PUBLIC_ERROR_STATUS.request_failed,
    }
  }
  return {
    ok: false,
    code,
    message: message ?? PUBLIC_ERRORS[code],
    status,
    ...declaredExtras(code, extra),
  }
}

export function successEnvelope(result) {
  return { ok: true, result }
}

// Story 5.2: the one handler outcome that is neither a result nor a rejection
// — the SSE stream handler has written (or begun writing) the response itself,
// so the envelope and the JSON writer must stand down. The gates all ran
// normally (the stream is as gated as any route); only the response encoding
// differs. A handler returns this sentinel only after it has taken over the
// response; any handler error BEFORE the first byte still maps through the
// normal coded-failure path, and the transport guard destroys a socket whose
// failure path fires after the stream started.
export const HANDLER_STREAMED = Object.freeze({ streamed: true })

// The error envelope is {ok, error:{code,message}} plus, additively, only the
// extras the failure's code declares (currently ambiguous_chat_id's optional
// candidates). The fixed fields can never be clobbered: extras are picked by
// declared name, never spread.
export function errorEnvelope(failure) {
  return {
    ok: false,
    error: {
      code: failure.code,
      message: failure.message,
      ...declaredExtras(failure.code, failure),
    },
  }
}

function isRejection(outcome) {
  return Boolean(outcome) && typeof outcome === 'object' && outcome.ok === false
}

// Rejection outcomes arriving without a status (from later stories' stages or
// injected verifiers) fall back to the declared table — never an undefined
// status on the wire.
function ensureStatus(outcome) {
  if (outcome.status !== undefined) return outcome
  const status = PUBLIC_ERROR_STATUS[outcome.code] ?? PUBLIC_ERROR_STATUS.request_failed
  return { ...outcome, status }
}

// One bounded, single-line diagnostic for internal-fallback failures. It goes
// to stderr only — the wire response carries the canonical fallback message —
// and credential-shaped substrings are redacted so secrets never reach logs.
const SECRET_PATTERN = /((?:pass(?:word)?|passwd|secret|token|authorization|api[-_ ]?key|private[-_ ]?key)\s*[=:]\s*)\S+/gi

export function internalDetailOf(error) {
  const code = typeof error?.code === 'string' && error.code.length > 0
    ? error.code
    : typeof error?.name === 'string' && error.name.length > 0
      ? error.name
      : 'unknown'
  const message = typeof error?.message === 'string' ? error.message : ''
  const redacted = message.replace(SECRET_PATTERN, '$1[redacted]')
  return `${code}: ${redacted.replace(/[\r\n]+/g, ' ')}`.slice(0, 300)
}

// Protocol stage (actor and pre-auth classes only): requires the
// Agent-Room-Protocol header with a supported version. A missing header is
// `protocol_required`; a present-but-mangled/unsupported version is
// `invalid_protocol` naming the supported versions. On success the accepted
// version is recorded so the response echoes it.
export class ProtocolStage {
  constructor() {
    this.name = 'protocol'
  }

  process(context) {
    const headers = context.headers ?? {}
    const raw = headers[PROTOCOL_HEADER.toLowerCase()] ?? headers[PROTOCOL_HEADER]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (value === undefined || value === null || value === '') {
      return reject('protocol_required', `${PROTOCOL_HEADER} header is required`)
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(value)) {
      return reject(
        'invalid_protocol',
        `unsupported ${PROTOCOL_HEADER} version "${String(value)}"; supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`,
      )
    }
    context.protocolVersion = value
    return undefined
  }
}

// Transport stage: HTTPS is required off-loopback (AD-7). The loopback-only
// bind keeps every accepted request on the trusted transport; anything else is
// refused at the connection (no JSON envelope, per the spine's "refused"
// outcome — the reason travels nowhere on the wire).
export class TransportStage {
  constructor() {
    this.name = 'transport'
  }

  process(context) {
    const loopback = LOOPBACK_REMOTE_ADDRESSES.has(String(context.remoteAddress ?? ''))
    if (!loopback && context.encrypted !== true) {
      return {
        refusal: true,
        reason: 'insecure_transport',
        message: 'requests are accepted only over loopback or TLS',
      }
    }
    return undefined
  }
}

// The injectable verifiers that reject until their stories provide the real
// policies: Story 1.4 owns session auth (actor class), Epic 5 owns the viewer
// cookie. Canonical messages — no per-callsite overrides.
export function defaultSessionVerifier() {
  return reject('unauthorized')
}

export function defaultViewerVerifier() {
  return reject('unauthorized')
}

// Verifier outcome shape: undefined/null passes without a session; a plain
// object is the principal; a rejection object is normalized with a coded
// fallback; anything else (non-object truthy values, arrays, malformed
// rejections) becomes a coded unauthorized rejection — never a crash and
// never a bogus session.
function normalizeVerifierOutcome(outcome) {
  if (outcome === undefined || outcome === null) return undefined
  if (typeof outcome !== 'object' || Array.isArray(outcome)) {
    return reject('unauthorized')
  }
  if (outcome.ok === false) {
    const code = typeof outcome.code === 'string' && PUBLIC_ERROR_STATUS[outcome.code] !== undefined
      ? outcome.code
      : 'unauthorized'
    const status = outcome.status ?? PUBLIC_ERROR_STATUS[code]
    return { ok: false, code, message: outcome.message ?? PUBLIC_ERRORS[code], status }
  }
  return outcome
}

// Authentication stage: runs the class's injectable verifier. Session tokens
// (actor class) and viewer cookies (viewer class) come from two separate
// verifier slots — AD-7's mutual exclusion means the credentials of one class
// can never authenticate the other. Pre-auth and health classes carry no
// session token and pass through.
export class AuthStage {
  constructor({ sessionVerifier = defaultSessionVerifier, viewerVerifier = defaultViewerVerifier } = {}) {
    this.name = 'auth'
    this.sessionVerifier = sessionVerifier
    this.viewerVerifier = viewerVerifier
  }

  process(context) {
    const routeClass = context.route?.class
    if (AUTH_PASSES_THROUGH.includes(routeClass)) return undefined
    const verifier = routeClass === 'viewer' ? this.viewerVerifier : this.sessionVerifier
    const outcome = normalizeVerifierOutcome(verifier(context))
    if (isRejection(outcome)) return ensureStatus(outcome)
    if (outcome) {
      context.session = outcome
      // The in-flight pin (Story 7.1, the fence's retention guarantee),
      // acquired HERE — synchronously with successful verification, before
      // any post-authentication await — because the send route's budget
      // stage awaits the request body INSIDE the stage sequence: a request
      // can be authenticated and suspended before the loop ends, and its
      // displaced key's fence entry must already be pinned by then. The pin
      // runs only when a runPipeline owns this request's pin lifecycle
      // (pipelinePinManaged) — a standalone `new AuthStage().process()` in
      // a unit test never pins, so it never leaks a count. runPipeline's
      // finally releases the pin exactly once on every exit path.
      if (context.pipelinePinManaged === true && routeClass === 'actor') {
        const sessionRegistry = context.sessionRegistry
        const sessionKey = context.session?.sessionKey
        if (sessionRegistry && typeof sessionRegistry.enterInFlight === 'function'
          && typeof sessionKey === 'string' && sessionKey.length > 0) {
          sessionRegistry.enterInFlight(sessionKey)
          context.pinnedSessionKey = sessionKey
        }
      }
    }
    return undefined
  }
}

// Budgets stage (AD-7): request budgets per key / per IP. Story 4.2 landed
// the policy's first gate, scoped exactly as its story demanded: the enroll
// route only, through the minimal fixed-window limiter injected at
// startServer. Story 4.4 completes the stage with the two per-Actor token
// buckets (server/api/rate-gates.mjs): the request budget — every
// authenticated (actor-class) request consumes one token at admission,
// whatever it later answers (failed and replayed attempts count, FR-16; a
// long-poll is one request and counts once, at admission, never per poll
// iteration) — and the send bucket on the send route, which is
// idempotency-aware: the stage consults the store's idempotency index FIRST,
// so an exact retry (an existing (room, actor, client_message_id) tuple)
// passes without consuming even from an empty bucket, and only a NEW send
// spends a token. The AC's gate ordering is structural: idempotency tuple →
// send bucket → duplicate gate (the duplicate gate lives inside the store's
// append transaction, after the same idempotency lookup — see room-log.mjs).
//
// For the send route the stage also performs the request-field read (the one
// body parse every POST gets), because the idempotency probe needs the
// body's client_message_id; readRequestFields is re-entrant (a context flag
// makes runPipeline's later read a no-op), the field gate's rejections are
// unchanged, and every other route still reads fields after the stages as
// before. A refusal is the coded rate_limited (429) carrying the
// declared retry_after_ms extra: zero state, nothing further consumed, the
// handler never runs. Gate logic lives here — never in a handler.
export class BudgetStage {
  constructor({
    enrollRateLimiter = null,
    trustedProxy = false,
    requestBudgetGate = null,
    sendBucketGate = null,
  } = {}) {
    this.name = 'budgets'
    this.enrollRateLimiter = enrollRateLimiter
    this.trustedProxy = trustedProxy === true
    this.requestBudgetGate = requestBudgetGate
    this.sendBucketGate = sendBucketGate
  }

  async process(context) {
    if (this.enrollRateLimiter !== null && context.route?.path === '/api/auth/enroll') {
      const rawForwarded = context.headers?.[FORWARDED_FOR_HEADER]
      const forwardedFor = Array.isArray(rawForwarded) ? rawForwarded[0] : rawForwarded
      const identity = enrollClientIdentity({
        remoteAddress: context.remoteAddress,
        forwardedFor,
        trustedProxy: this.trustedProxy,
      })
      if (this.enrollRateLimiter.check(identity) !== true) {
        return reject('rate_limited')
      }
    }

    const actorKey = context.session?.actorFingerprint
    const actorKeyUsable = typeof actorKey === 'string' && actorKey.length > 0

    // The request budget: one token per authenticated request, at admission,
    // before anything else about the request can refuse it — failed and
    // replayed attempts count (FR-16). Pre-auth routes have no key yet (the
    // enroll route keeps its own per-identity limiter above); viewer and
    // health carry no Actor budget.
    if (this.requestBudgetGate !== null && context.route?.class === 'actor' && actorKeyUsable) {
      const verdict = this.requestBudgetGate.check(actorKey)
      if (verdict.ok !== true) {
        return reject('rate_limited', undefined, { retry_after_ms: verdict.retryAfterMs })
      }
    }

    // The send bucket: per Actor, on the send route only. The idempotency
    // probe runs BEFORE the bucket consumes: a tuple the store already holds
    // is a retry — it passes free (the handler resolves it as the original
    // or the coded conflict) whatever the bucket's state, so an exact retry
    // during a rate-limited period still returns the original and consumes
    // nothing. Only a NEW send spends a token.
    if (
      this.sendBucketGate !== null
      && context.method === 'POST'
      && context.route?.path === '/api/rooms/:id/messages'
    ) {
      // The probe reads the body's client_message_id, so the send route's
      // one field read happens here (re-entrant; runPipeline will not
      // re-read). A field-gate rejection is the request's answer, exactly as
      // if it had been read after the stages.
      const fieldsOutcome = await readRequestFields(context)
      if (fieldsOutcome) return fieldsOutcome

      const clientMessageId = context.body?.client_message_id
      const roomId = context.params?.id
      const probeable = actorKeyUsable
        && typeof roomId === 'string' && roomId.length > 0
        && typeof clientMessageId === 'string' && clientMessageId.length > 0
      if (probeable) {
        try {
          const existing = context.store?.findIdempotentSend?.({
            roomId,
            actorFingerprint: actorKey,
            clientMessageId,
          })
          // An existing tuple is a retry: admit free, consume nothing.
          if (existing) return undefined
        } catch (error) {
          // A tuple that cannot be proven existing is a new admission: any
          // coded store refusal here (a malformed id among them) would fail
          // the send later anyway, and the request budget already counted
          // this attempt — fall through to the bucket like a first send.
          // Anything that is not a coded store failure is a real fault and
          // propagates.
          if (!(error instanceof AgentRoomRuntimeError)) throw error
        }
      }
      const verdict = this.sendBucketGate.check(actorKey)
      if (verdict.ok !== true) {
        return reject('rate_limited', undefined, { retry_after_ms: verdict.retryAfterMs })
      }
    }
    return undefined
  }
}

// Authorization stage (AD-7): bans and room ACLs. Story 4.5 lands the ban
// half: every actor-class route — the session-authenticated surface, so
// every send, read, session, presence, and enumeration request — is refused
// `banned` when the session token's Actor fingerprint holds a row in the
// store's durable ban registry. The check is a direct indexed query per
// request on the request's own store connection, deliberately NOT a cached
// in-process set: the operator CLI (Story 4.2's host, AR-13) commits bans
// from a SEPARATE process directly into the same SQLite file, and the ban
// must hold "at next request" — a per-request read of the WAL-connected
// store is the only state that can never go stale. There is no ban check
// outside the actor class here: pre-auth credential routes derive identity
// in their handlers (the enroll route's post-proof gate lives inside the
// store's enrollment transaction), the challenge route stays
// privilegeless-open by design (gating it would leak ban state to
// unauthenticated callers), and viewer/health carry no Actor identity.
// Room ACLs remain the store's boundary checks (room_not_found /
// actor_not_member), unchanged. A stage whose context carries no store (or
// a store without the ban surface — a direct assemblePipeline caller) stays
// the structural pass-through.
export class AuthzStage {
  constructor() {
    this.name = 'authz'
  }

  process(context) {
    if (context.route?.class !== 'actor') return undefined
    // The handoff fence (Story 6.4, the v0.2.0 reconnect recovery; Story 7.1,
    // its completion). A session displaced by an explicit same-Actor
    // replacement loses its authority WITH the handoff: its token stops
    // authenticating, and this stage refuses a displaced request at the
    // earliest point the stage sequence reaches it — for most routes that is
    // before the server reads the body; for the send route the budget stage
    // reads the body first, and the post-input revalidation in runPipeline
    // still catches the request before its handler. Admission alone is never
    // authority.
    //
    // WHERE THIS CHECK SITS, exactly: this is the LAST stage of the sequence,
    // so on a body-carrying route the body may already have been read (the
    // send route's budget stage reads it) or still be arriving — which is why
    // runPipeline runs a SECOND fence look-up (the post-input revalidation)
    // after the request fields resolve and directly before the handler: every
    // request the handover displaced is refused at one of the two, whichever
    // it has reached. This stage keeps the early refusal so an
    // already-displaced request never costs more than it must.
    const sessionRegistry = context.sessionRegistry
    const sessionKey = context.session?.sessionKey
    if (sessionRegistry
      && typeof sessionRegistry.isSuperseded === 'function'
      && typeof sessionKey === 'string'
      && sessionKey.length > 0
      && sessionRegistry.isSuperseded(sessionKey)) {
      return reject('unauthorized')
    }
    const store = context.store
    if (!store || typeof store.isActorBanned !== 'function') return undefined
    const actorFingerprint = context.session?.actorFingerprint
    if (typeof actorFingerprint !== 'string' || actorFingerprint.length === 0) return undefined
    if (store.isActorBanned(actorFingerprint)) {
      return reject('banned')
    }
    return undefined
  }
}

// One fixed construction: assert the stage list runs in canonical order with
// no duplicates and no unknown stages. A reordered gate fails here.
export function assertStageOrder(stages) {
  let previous = -1
  for (const stage of stages) {
    const index = PIPELINE_STAGE_ORDER.indexOf(stage?.name)
    if (index === -1) {
      throw new AgentRoomRuntimeError('invalid_argument', `unknown pipeline stage "${String(stage?.name)}"`)
    }
    if (index <= previous) {
      throw new AgentRoomRuntimeError(
        'invalid_argument',
        `pipeline stage "${stage.name}" is out of order: expected ${PIPELINE_STAGE_ORDER.join(' -> ')}`,
      )
    }
    previous = index
  }
}

// Per-class assembly: the identical-gate door for Stories 1.4-1.8. Actor and
// pre-auth classes run all stages; viewer and health skip the protocol stage.
// The two verifier slots keep actor and viewer credentials apart. The budget
// stage's injects (Stories 4.2 and 4.4) default to no limiting — a direct
// assemblePipeline caller gets the structural pass-through; startServer wires
// the enroll route's limiter, its proxy-trust configuration, and the two
// per-Actor token buckets (request budget + send bucket).
export function assemblePipeline(routeClass, options = {}) {
  if (!PROTOCOL_APPLIES_TO.includes(routeClass) && routeClass !== 'viewer' && routeClass !== 'health') {
    throw new AgentRoomRuntimeError('invalid_argument', `unknown route class "${String(routeClass)}"`)
  }
  const stages = []
  if (PROTOCOL_APPLIES_TO.includes(routeClass)) stages.push(new ProtocolStage())
  stages.push(
    new TransportStage(),
    new AuthStage({
      sessionVerifier: options.sessionVerifier,
      viewerVerifier: options.viewerVerifier,
    }),
    new BudgetStage({
      enrollRateLimiter: options.enrollRateLimiter ?? null,
      trustedProxy: options.trustedProxy,
      requestBudgetGate: options.requestBudgetGate ?? null,
      sendBucketGate: options.sendBucketGate ?? null,
    }),
    new AuthzStage(),
  )
  assertStageOrder(stages)
  return stages
}

function parseContentLength(headers) {
  const raw = headers?.['content-length']
  if (raw === undefined) return null
  const value = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

async function readBodyStream(stream, maxBytes) {
  // A context without a stream carries no body (the HTTP adapter always
  // provides the raw request stream; bodyless calls may provide nothing).
  if (stream === undefined || stream === null) return { buffer: Buffer.alloc(0) }
  const chunks = []
  let total = 0
  try {
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += data.length
      if (total > maxBytes) return { tooLarge: true }
      chunks.push(data)
    }
  } catch (error) {
    // A client abort mid-body is a cancelled request, never a server fault.
    if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE') return { cancelled: true }
    return { cancelled: true }
  }
  return { buffer: Buffer.concat(chunks) }
}

// The field gate: unknown request fields are rejected, not ignored (AD-8).
// Query parameters and JSON bodies are validated against the route's
// allowed-field set, which is drawn from the frozen AD-8 vocabulary. Bodies
// are bounded by FRAME_MAX_BYTES; value parsing belongs to handlers, never
// here. Returns a rejection outcome or undefined (context.body populated).
// Re-entrant (Story 4.4): the budgets stage reads the send route's fields
// before its idempotency probe, so a context whose fields were already read
// returns immediately — the one body parse per request still holds.
export async function readRequestFields(context) {
  if (context.requestFieldsRead === true) return undefined
  context.requestFieldsRead = true
  const allowed = context.route?.requestFields ?? []

  // Duplicate query keys are a malformed request, not a last-key-wins shorthand.
  const queryKeys = context.queryKeys ?? Object.keys(context.query ?? {})
  if (new Set(queryKeys).size !== queryKeys.length) {
    return reject('invalid_request')
  }
  for (const field of queryKeys) {
    if (!allowed.includes(field)) {
      return reject('unknown_field', `unknown request field "${field}"`)
    }
  }

  // GET/DELETE carry no body in this API: a declared non-empty body (or a
  // chunked one) is a malformed request.
  if (!BODY_METHODS.has(context.method)) {
    const declared = parseContentLength(context.headers) ?? 0
    const chunked = Array.isArray(context.headers?.['transfer-encoding'])
      ? context.headers['transfer-encoding'].length > 0
      : Boolean(context.headers?.['transfer-encoding'])
    if (declared > 0 || chunked) {
      return reject('invalid_request')
    }
    return undefined
  }

  const declared = parseContentLength(context.headers)
  if (declared !== null && declared > FRAME_MAX_BYTES) {
    return reject('request_too_large')
  }
  const read = await readBodyStream(context.bodyStream, FRAME_MAX_BYTES)
  if (read.cancelled) {
    return reject('request_cancelled')
  }
  if (read.tooLarge) {
    return reject('request_too_large')
  }
  const text = read.buffer.toString('utf8')
  if (text.length === 0) {
    context.body = {}
    return undefined
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return reject('invalid_request')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return reject('invalid_request')
  }
  for (const field of Object.keys(parsed)) {
    if (!allowed.includes(field)) {
      return reject('unknown_field', `unknown request field "${field}"`)
    }
  }
  context.body = parsed
  return undefined
}

// Run one request through the pipeline. Every stage sees the same shared
// context; the first rejection (or refusal) is returned immediately — no
// later stage and never the handler runs. The handler receives the context
// and returns a plain result value (wrapped in the success envelope) or a
// rejection; gate logic never lives in handlers.
export async function runPipeline(stages, context, handler) {
  assertStageOrder(stages)
  // This pipeline owns the request's pin lifecycle (see AuthStage): the pin
  // is acquired synchronously with authentication, and the finally below
  // releases it exactly once on EVERY exit path — stage refusals and
  // rejections, input rejections, the post-input refusal, handler
  // rejections and throws, and every normal return. The fence's guarantee
  // covers the admission→handler-entry window; a live SSE stream (the only
  // streaming route, a viewer-class route with no session key) is never
  // pinned in the first place.
  context.pipelinePinManaged = true
  try {
    for (const stage of stages) {
      const outcome = await stage.process(context)
      if (outcome !== undefined && outcome !== null) {
        if (outcome.refusal === true) return outcome
        if (isRejection(outcome)) return ensureStatus(outcome)
      }
    }
    const fieldsOutcome = await readRequestFields(context)
    if (fieldsOutcome) return fieldsOutcome
    // The post-input handoff-fence revalidation (Story 7.1): the LAST fence
    // look-up of the request, run synchronously after the request fields
    // resolve and DIRECTLY before the handler is invoked — with no await
    // between this check and the mutating handlers, all of which commit
    // synchronously, so no handoff can interleave between the check and the
    // commit. FENCE-ONLY by recorded contract: the ban check is not re-run
    // here (FR-15: in-flight requests are refused at next request; the ban's
    // enforcement boundary is Story 4.5's, not this fence's). Gated on the
    // actor class and the presence of an authz stage so partial-pipeline
    // unit tests without one are unaffected.
    if (context.route?.class === 'actor' && stages.some((stage) => stage.name === 'authz')) {
      const sessionRegistry = context.sessionRegistry
      const sessionKey = context.session?.sessionKey
      if (sessionRegistry && typeof sessionRegistry.isSuperseded === 'function'
        && typeof sessionKey === 'string' && sessionKey.length > 0
        && sessionRegistry.isSuperseded(sessionKey)) {
        return reject('unauthorized')
      }
    }
    try {
      const value = await handler(context)
      if (value === HANDLER_STREAMED) return value
      if (isRejection(value)) return ensureStatus(value)
      return successEnvelope(value ?? null)
    } catch (error) {
      // Coded errors map through the status table; anything else — including
      // internal-only codes — falls back to `request_failed` (500) per AD-8.
      // The failing detail travels to stderr via internalDetail, never to the
      // wire: the envelope keeps the canonical fallback message.
      const failure = reject(error?.code, error?.message)
      failure.internalDetail = internalDetailOf(error)
      return failure
    }
  } finally {
    if (typeof context.pinnedSessionKey === 'string' && context.pinnedSessionKey.length > 0) {
      context.sessionRegistry?.leaveInFlight?.(context.pinnedSessionKey)
      context.pinnedSessionKey = null
    }
    context.pipelinePinManaged = false
  }
}
