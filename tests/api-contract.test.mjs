// Contract pins for the frozen wire surface (spine AD-8/AD-9, Story 1.3).
// The AD-8 route list, field vocabulary, and envelope sentence are parsed from
// the LIVE spine document in the repository — if server/api/routes.mjs, the
// constants module, or the spine's frozen wire contract drift apart, these
// assertions fail.

import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  INTERNAL_ERROR_CODES,
  PROTOCOL_HEADER,
  PUBLIC_ERRORS,
  PUBLIC_ERROR_STATUS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../server/constants.mjs'
import {
  REQUEST_FIELD_VOCABULARY,
  RESPONSE_FIELD_VOCABULARY,
  ROUTE_CLASSES,
  ROUTE_TABLE,
  matchRoute,
  routeKey,
} from '../server/api/routes.mjs'
import {
  ERROR_ENVELOPE_EXTRAS,
  PIPELINE_STAGE_ORDER,
  errorEnvelope,
  reject,
  successEnvelope,
} from '../server/api/pipeline.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SPINE_PATH = join(
  ROOT,
  'docs',
  'architecture',
  'architecture-agent-room-2026-09-20',
  'ARCHITECTURE-SPINE.md',
)

// --- Live spine AD-8 parsing ---------------------------------------------------

function ad8Section() {
  const spine = readFileSync(SPINE_PATH, 'utf8')
  const start = spine.indexOf('### AD-8')
  const end = spine.indexOf('### AD-9')
  assert.ok(start !== -1 && end > start, 'the spine must contain the AD-8 wire-API decision')
  return spine.slice(start, end)
}

// Parse the AD-8 route list into ordered (method, path, class) triples.
function parseAd8Routes(section) {
  const triples = []
  for (const line of section.split('\n')) {
    const classMatch = /^\s*-\s*\*\*([a-z-]+):\*\*(.*)$/.exec(line)
    if (!classMatch) continue
    const routeClass = classMatch[1]
    for (const match of classMatch[2].matchAll(/`([A-Z]+(?:\|[A-Z]+)?) (\/[^`]+)`/g)) {
      for (const method of match[1].split('|')) {
        triples.push({ method, path: match[2], class: routeClass })
      }
    }
  }
  return triples
}

// Parse the AD-8 vocabulary sentence into the request and response name lists.
// The requests segment's "(added ...)" amendment mentions tool names in
// backticks and is stripped (globally — every dated amendment in the requests
// segment is stripped, so additive amendments never leak names); the responses
// segment's amendments name only response fields, so they stay in and their
// names are extracted in order.
function parseAd8Vocabulary(section) {
  const start = section.indexOf('**Frozen field vocabulary**')
  const end = section.indexOf('**Read semantics')
  assert.ok(start !== -1 && end > start, 'AD-8 must carry the frozen vocabulary sentence')
  const sentence = section.slice(start, end)
  const splitAt = sentence.indexOf('; responses ')
  assert.ok(splitAt > 0, 'the vocabulary sentence lost its requests/responses split')
  const requestsPart = sentence.slice(0, splitAt).replace(/\*\(added .*?\)\*/g, '')
  const responsesPart = sentence.slice(splitAt)
  const names = part => [...part.matchAll(/`([^`]+)`/g)].map(match => match[1].replace(/\[\]$/, ''))
  return { requests: names(requestsPart), responses: names(responsesPart), sentence }
}

const section = ad8Section()

test('the route table is the live spine AD-8 wire surface, verbatim and in order', () => {
  const expected = parseAd8Routes(section)
  assert.ok(expected.length >= 18, `expected the full AD-8 route list, parsed ${expected.length}`)
  assert.deepEqual(
    ROUTE_TABLE.map(route => ({ method: route.method, path: route.path, class: route.class })),
    expected,
  )
})

test('the field vocabulary is the live spine AD-8 vocabulary, verbatim', () => {
  const expected = parseAd8Vocabulary(section)
  assert.deepEqual([...REQUEST_FIELD_VOCABULARY], expected.requests)
  assert.deepEqual([...RESPONSE_FIELD_VOCABULARY], expected.responses)
  assert.ok(Object.isFrozen(REQUEST_FIELD_VOCABULARY))
  assert.ok(Object.isFrozen(RESPONSE_FIELD_VOCABULARY))
})

test('the AD-8 envelope sentence pins the wire shape and the fallback code', () => {
  assert.match(section, /JSON envelope `\{ok, result\|error:\{code,message\}\}`/)
  assert.match(section, /unknown → `request_failed`/)
  assert.deepEqual(successEnvelope({ a: 1 }), { ok: true, result: { a: 1 } })
  assert.deepEqual(successEnvelope(null), { ok: true, result: null })
  const failure = { ok: false, code: 'protocol_required', message: 'Agent-Room-Protocol header is required', status: 400 }
  assert.deepEqual(errorEnvelope(failure), {
    ok: false,
    error: { code: 'protocol_required', message: 'Agent-Room-Protocol header is required' },
  })
})

test('error-envelope extras are a declared allowlist gated by code and can never clobber fixed fields', () => {
  // The Story 1.7 amendment declared ambiguous_chat_id's optional candidates
  // list; the Story 4.4 amendment added rate_limited's retry_after_ms — the
  // rate-limited refusal always names its retry delay (FR-17).
  assert.deepEqual(Object.keys(ERROR_ENVELOPE_EXTRAS), ['ambiguous_chat_id', 'rate_limited'])
  assert.deepEqual([...ERROR_ENVELOPE_EXTRAS.ambiguous_chat_id], ['candidates'])
  assert.deepEqual([...ERROR_ENVELOPE_EXTRAS.rate_limited], ['retry_after_ms'])

  // Fixed fields are construction-time protected: no declared extra may be
  // named ok, code, message, or status, and a spread of unlisted extras is
  // dropped.
  const fixed = new Set(['ok', 'code', 'message', 'status'])
  for (const [code, names] of Object.entries(ERROR_ENVELOPE_EXTRAS)) {
    for (const name of names) {
      assert.equal(fixed.has(name), false, `${code} declares envelope-clobbering extra "${name}"`)
    }
  }

  // The coded path carries the declared extra; an undeclared code's extras
  // never reach the envelope, and no extra can overwrite the fixed fields.
  const ambiguous = reject('ambiguous_chat_id', 'ambiguous', {
    candidates: [{ fingerprint: 'sha256:' + 'a'.repeat(64), last_seen: new Date(0).toISOString() }],
    ok: false,
    code: 'smuggled',
    message: 'smuggled',
    status: 500,
  })
  assert.equal(ambiguous.candidates.length, 1)
  assert.equal(ambiguous.code, 'ambiguous_chat_id')
  assert.equal(ambiguous.message, 'ambiguous')
  assert.equal(ambiguous.status, 409)
  assert.equal(ambiguous.ok, false)
  assert.deepEqual(errorEnvelope(ambiguous), {
    ok: false,
    error: { code: 'ambiguous_chat_id', message: 'ambiguous', candidates: ambiguous.candidates },
  })

  const undeclared = reject('chat_id_taken', 'taken', { candidates: [{ fingerprint: 'x', last_seen: 'y' }] })
  assert.equal(undeclared.candidates, undefined, 'extras on undeclared codes are dropped')
  assert.deepEqual(errorEnvelope(undeclared), { ok: false, error: { code: 'chat_id_taken', message: 'taken' } })
})

test('the route table is deep-frozen immutable data', () => {
  assert.ok(Object.isFrozen(ROUTE_TABLE))
  assert.ok(Object.isFrozen(ROUTE_CLASSES))
  for (const route of ROUTE_TABLE) {
    assert.ok(Object.isFrozen(route), route.path)
    assert.ok(Object.isFrozen(route.requestFields), `${route.path} requestFields`)
    assert.throws(() => {
      route.requestFields.push('nope')
    }, TypeError, `${route.path} requestFields must be frozen`)
  }
  assert.throws(() => {
    ROUTE_TABLE[0].method = 'BROKEN'
  }, TypeError)
})

test('every route declares exactly one AD-7 class and only vocabulary fields', () => {
  assert.deepEqual([...ROUTE_CLASSES], ['actor', 'pre-auth', 'viewer', 'health'])
  const classForPath = path => {
    if (path.startsWith('/api/auth/')) return 'pre-auth'
    if (path.startsWith('/viewer')) return 'viewer'
    if (path === '/health') return 'health'
    return 'actor'
  }
  for (const route of ROUTE_TABLE) {
    assert.equal(route.class, classForPath(route.path), route.path)
    assert.ok(route.requestFields.every(field => REQUEST_FIELD_VOCABULARY.includes(field)),
      `${route.path} accepts a field outside the frozen vocabulary`)
  }
})

test('route matching resolves the exact class per method and path', () => {
  // Health.
  assert.equal(matchRoute('GET', '/health')?.route.class, 'health')
  // Paths are exact: no trailing-slash leniency on frozen routes.
  assert.equal(matchRoute('GET', '/health/'), null)
  // Parameter capture.
  const messages = matchRoute('GET', '/api/rooms/abc123/messages')
  assert.equal(messages?.route.class, 'actor')
  assert.deepEqual(messages?.params, { id: 'abc123' })
  // Method is part of the contract.
  assert.equal(matchRoute('PUT', '/api/session'), null)
  assert.equal(matchRoute('POST', '/health'), null)
  // Specific viewer patterns win over the static-assets wildcard.
  assert.equal(matchRoute('GET', '/viewer/auth')?.route.class, 'viewer')
  assert.equal(matchRoute('GET', '/viewer/api/rooms/r1/messages')?.params.id, 'r1')
  assert.equal(matchRoute('GET', '/viewer/')?.route.wildcard, true)
  assert.equal(matchRoute('GET', '/viewer/assets/app.js')?.route.wildcard, true)
  // Unknown paths are unmatched (they answer 404 route_not_found).
  assert.equal(matchRoute('GET', '/api/nope'), null)
  assert.equal(matchRoute('GET', '/'), null)
  // Malformed percent-encoding never matches leniently.
  assert.equal(matchRoute('GET', '/api/rooms/%FF/messages'), null)
})

test('route keys are stable method/path pairs', () => {
  assert.equal(routeKey(ROUTE_TABLE[ROUTE_TABLE.length - 1]), 'GET /health')
})

test('the implemented mark covers exactly the live frozen routes', () => {
  // The implemented mark is the startup contract's data side (server.mjs
  // asserts every marked route has a registered handler and vice versa).
  // GET /health went live in Story 1.3, POST /api/auth/local in 1.4, the
  // session connect surface (POST/PATCH/DELETE /api/session) in 1.5, the
  // presence + status reads (GET /api/presence, GET /api/status) in 1.6, the
  // conversation surface (POST /api/rooms/direct and the messages pair) in
  // 1.7, the enumeration read (GET /api/rooms) in Story 2.2, the remote
  // challenge pair (POST /api/auth/challenge, POST /api/auth/answer) in
  // Story 4.1, the invite-gated enrollment route (POST /api/auth/enroll) in
  // Story 4.2, and the whole viewer surface — the auth bridge, the static
  // live view, the broadcast read, and the SSE stream — in Stories 5.1+5.2;
  // with Epic 5's viewer stories landed every frozen route is live.
  const implemented = ROUTE_TABLE.filter(route => route.implemented === true)
  assert.deepEqual(implemented.map(routeKey), [
    'POST /api/session',
    'PATCH /api/session',
    'DELETE /api/session',
    'GET /api/presence',
    'GET /api/rooms',
    'POST /api/rooms/direct',
    'GET /api/rooms/:id/messages',
    'POST /api/rooms/:id/messages',
    'GET /api/status',
    'POST /api/auth/enroll',
    'POST /api/auth/challenge',
    'POST /api/auth/answer',
    'POST /api/auth/local',
    'GET /viewer/auth',
    'GET /viewer/',
    'GET /viewer/api/rooms/:id/messages',
    'GET /viewer/api/rooms/:id/events',
    'GET /health',
  ])
  // Story 5.1: the viewer surface takes NO credential field anywhere — the
  // bridge's Bearer rides the Authorization header, the cookie rides
  // Set-Cookie, and an empty request-field set makes a query-string
  // credential structurally impossible (any query key is unknown_field).
  const viewerAuth = ROUTE_TABLE.find(route => routeKey(route) === 'GET /viewer/auth')
  const viewerSurface = ROUTE_TABLE.find(route => routeKey(route) === 'GET /viewer/')
  const viewerEvents = ROUTE_TABLE.find(route => routeKey(route) === 'GET /viewer/api/rooms/:id/events')
  assert.deepEqual([...viewerAuth.requestFields], [])
  assert.deepEqual([...viewerSurface.requestFields], [])
  assert.deepEqual([...viewerEvents.requestFields], [])
  const viewerMessages = ROUTE_TABLE.find(route => routeKey(route) === 'GET /viewer/api/rooms/:id/messages')
  assert.deepEqual([...viewerMessages.requestFields], ['after_seq', 'limit'])
  const local = ROUTE_TABLE.find(route => routeKey(route) === 'POST /api/auth/local')
  assert.deepEqual([...local.requestFields], ['public_key'])
  // Story 4.1: identity binds at challenge — the challenge takes exactly the
  // key field; the answer takes exactly nonce and signature, no public_key to
  // substitute with.
  const challenge = ROUTE_TABLE.find(route => routeKey(route) === 'POST /api/auth/challenge')
  const answer = ROUTE_TABLE.find(route => routeKey(route) === 'POST /api/auth/answer')
  assert.deepEqual([...challenge.requestFields], ['public_key'])
  assert.deepEqual([...answer.requestFields], ['nonce', 'signature'])
  // Story 4.2: the invite-gated enrollment takes exactly the token, the raw
  // key whose DERIVED fingerprint enrolls (identity is never claimed), and
  // the possession-proof signature over the exact token bytes.
  const enroll = ROUTE_TABLE.find(route => routeKey(route) === 'POST /api/auth/enroll')
  assert.deepEqual([...enroll.requestFields], ['invite_token', 'public_key', 'signature'])
  // The session surface: chat_id plus the 1.6 closed-set client_type
  // declaration on connect and rename, none on disconnect — actor identity
  // always comes from the token, never the body.
  const connect = ROUTE_TABLE.find(route => routeKey(route) === 'POST /api/session')
  const rename = ROUTE_TABLE.find(route => routeKey(route) === 'PATCH /api/session')
  const disconnect = ROUTE_TABLE.find(route => routeKey(route) === 'DELETE /api/session')
  assert.deepEqual([...connect.requestFields], ['chat_id', 'client_type'])
  assert.deepEqual([...rename.requestFields], ['chat_id', 'client_type'])
  assert.deepEqual([...disconnect.requestFields], [])
  // The Story 1.6 reads: the presence query allowlist is exactly the one
  // boolean flag; status takes no fields at all.
  const presence = ROUTE_TABLE.find(route => routeKey(route) === 'GET /api/presence')
  const status = ROUTE_TABLE.find(route => routeKey(route) === 'GET /api/status')
  assert.deepEqual([...presence.requestFields], ['include_offline'])
  assert.deepEqual([...status.requestFields], [])
  // Story 2.2: the enumeration read takes no request fields either — any
  // query key is an unknown_field rejection, duplicate keys invalid_request.
  const rooms = ROUTE_TABLE.find(route => routeKey(route) === 'GET /api/rooms')
  assert.deepEqual([...rooms.requestFields], [])
})

test('the fixed pipeline order is the AD-7 order', () => {
  assert.deepEqual([...PIPELINE_STAGE_ORDER], ['protocol', 'transport', 'auth', 'budgets', 'authz'])
})

test('protocol gate constants are the frozen header and its supported versions', () => {
  assert.equal(PROTOCOL_HEADER, 'Agent-Room-Protocol')
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['1'])
})

test('story 1.3 error codes are registered once with their canonical statuses', () => {
  const expected = {
    protocol_required: [400, 'Agent-Room-Protocol header is required'],
    invalid_protocol: [400, 'Agent-Room-Protocol header version is not supported'],
    route_not_found: [404, 'route was not found'],
    request_failed: [500, 'agent-room request failed'],
    unauthorized: [401, 'session authentication is required'],
    unknown_field: [400, 'request contains an unknown field'],
    invalid_request: [400, 'request shape is invalid'],
    // Story 4.1 additions: the challenge path's three codes — an unanswerable
    // or spent nonce, a failed verification against the challenge-recorded
    // key, and the answer route's enrollment gate.
    challenge_invalid: [401, 'challenge nonce is invalid, expired, or already used'],
    signature_invalid: [401, 'signature verification failed'],
    not_enrolled: [403, 'this public key is not enrolled on this server'],
    // Story 4.2 additions: the invite gate (unknown/expired/revoked → 403,
    // spent by other keys → 409, revoke-prefix miss → 404) and the enroll
    // route's admission refusal (429 — the send-status code's HTTP face).
    invite_invalid: [403, 'invite token is unknown, expired, or revoked'],
    invite_exhausted: [409, 'invite has no uses remaining'],
    invite_not_found: [404, 'no invite matches this digest prefix'],
    rate_limited: [429, 'request rate limit exceeded'],
    // Story 4.5 addition: the operator ban's refusal — every send, read, or
    // re-enroll from a banned key answers 403 (the send-status code's face).
    banned: [403, 'this key is banned by the operator'],
  }
  for (const [code, [status, message]] of Object.entries(expected)) {
    assert.equal(PUBLIC_ERROR_STATUS[code], status, code)
    assert.equal(PUBLIC_ERRORS[code], message, code)
  }
  // Every public code has exactly one status; the tables move together.
  assert.deepEqual(Object.keys(PUBLIC_ERROR_STATUS).sort(), Object.keys(PUBLIC_ERRORS).sort())
})

// Symlink-safe walk mirroring tests/constants.test.mjs.
function listModules(directory) {
  const found = []
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }
  for (const name of names.sort()) {
    const path = join(directory, name)
    let info
    try {
      info = lstatSync(path)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) found.push(...listModules(path))
    else if (name.endsWith('.mjs')) found.push(path)
  }
  return found
}

test('every coded error in api and core is declared in the constants module', () => {
  const declared = new Set([...Object.keys(PUBLIC_ERRORS), ...INTERNAL_ERROR_CODES])
  const thrown = new Set()
  for (const directory of ['api', 'core']) {
    for (const path of listModules(join(ROOT, 'server', directory))) {
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/\b(?:reject|fail)\(\s*'([A-Za-z0-9_]+)'/g)) {
        thrown.add(match[1])
      }
      for (const match of source.matchAll(/AgentRoomRuntimeError\(\s*'([A-Za-z0-9_]+)'/g)) {
        thrown.add(match[1])
      }
    }
  }
  assert.ok(thrown.size >= 5, `expected a real vocabulary scan, found ${thrown.size} codes`)
  const undeclared = [...thrown].filter(code => !declared.has(code)).sort()
  assert.deepEqual(undeclared, [])
})
