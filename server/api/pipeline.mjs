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
// ambiguous_chat_id's optional candidates list.
export const ERROR_ENVELOPE_EXTRAS = Object.freeze({
  ambiguous_chat_id: Object.freeze(['candidates']),
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
    if (outcome) context.session = outcome
    return undefined
  }
}

// Budgets stage (AD-7): request budgets per key / per IP. Story 4.2 lands the
// policy's first gate, scoped exactly as its story demands: the enroll route
// only, through the minimal fixed-window limiter injected at startServer (a
// limiter is configured ONLY for that route's admission; every other route is
// untouched until Story 4.4's full budget stage). The gate lives here, in the
// stage — never in a handler — and a refusal is the coded rate_limited (429):
// zero state, nothing consumed, the handler never runs.
export class BudgetStage {
  constructor({ enrollRateLimiter = null, trustedProxy = false } = {}) {
    this.name = 'budgets'
    this.enrollRateLimiter = enrollRateLimiter
    this.trustedProxy = trustedProxy === true
  }

  process(context) {
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
    return undefined
  }
}

// Authorization stage (AD-7): bans and room ACLs. Epics 3-4 own the policy;
// structural pass-through until then.
export class AuthzStage {
  constructor() {
    this.name = 'authz'
  }

  process() {
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
// stage's injects (Story 4.2) default to no limiting — a direct assemblePipeline
// caller gets the structural pass-through; startServer wires the enroll route's
// limiter and its proxy-trust configuration.
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
export async function readRequestFields(context) {
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
  for (const stage of stages) {
    const outcome = await stage.process(context)
    if (outcome !== undefined && outcome !== null) {
      if (outcome.refusal === true) return outcome
      if (isRejection(outcome)) return ensureStatus(outcome)
    }
  }
  const fieldsOutcome = await readRequestFields(context)
  if (fieldsOutcome) return fieldsOutcome
  try {
    const value = await handler(context)
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
}
