// Frozen wire contract (spine AD-8): the route table and the field vocabulary
// are data, cited verbatim from the architecture spine's wire-API decision —
// tests/api-contract.test.mjs parses the LIVE spine document and fails on
// drift. Names never rename; additions only (NFR-8). Stories 1.4-1.8 register
// handlers for their routes without touching this table's shape.
//
// Route classes (AD-7): every route declares exactly one class, which fixes
// how the middleware stages apply:
//   actor    — session-token authenticated (auth stage runs the session
//              verifier slot; viewer credentials can never authenticate here)
//   pre-auth — /api/auth/*, no session token (auth stage passes through)
//   viewer   — /viewer/*, cookie-authenticated via the viewer verifier slot in
//              Epic 5, protocol-exempt
//   health   — GET /health, unauthenticated liveness, protocol-exempt

export const ROUTE_CLASSES = Object.freeze(['actor', 'pre-auth', 'viewer', 'health'])

// Request fields each route accepts, drawn ONLY from the frozen request
// vocabulary below (asserted by the contract test). Field sets are derived
// from the epic's route semantics and extend additively; a request carrying
// any other field is rejected with `unknown_field`, never ignored. Every
// array is deep-frozen — the table is immutable data.
export const ROUTE_TABLE = Object.freeze([
  // actor (AD-8): POST /api/session · PATCH /api/session · DELETE /api/session
  // · GET /api/presence · GET /api/rooms · POST /api/rooms/direct ·
  // GET|POST /api/rooms/:id/messages · GET /api/status
  //
  // Story 1.5: the session connect surface is live (handlers in server.mjs).
  // POST binds the authenticated Actor to a Chat ID for the session's
  // lifetime; PATCH renames immediately (the old name freed in the same
  // instant); DELETE releases the live name (the durable claim row stays).
  // chat_id always comes from the body; actor identity always comes from the
  // token.
  Object.freeze({ method: 'POST', path: '/api/session', class: 'actor', implemented: true, requestFields: Object.freeze(['chat_id']) }),
  Object.freeze({ method: 'PATCH', path: '/api/session', class: 'actor', implemented: true, requestFields: Object.freeze(['chat_id']) }),
  Object.freeze({ method: 'DELETE', path: '/api/session', class: 'actor', implemented: true, requestFields: Object.freeze([]) }),
  Object.freeze({ method: 'GET', path: '/api/presence', class: 'actor', requestFields: Object.freeze(['include_offline']) }),
  Object.freeze({ method: 'GET', path: '/api/rooms', class: 'actor', requestFields: Object.freeze([]) }),
  Object.freeze({ method: 'POST', path: '/api/rooms/direct', class: 'actor', requestFields: Object.freeze(['chat_id', 'target_fingerprint']) }),
  Object.freeze({ method: 'GET', path: '/api/rooms/:id/messages', class: 'actor', requestFields: Object.freeze(['after_seq', 'limit', 'wait_ms']) }),
  Object.freeze({ method: 'POST', path: '/api/rooms/:id/messages', class: 'actor', requestFields: Object.freeze(['chat_id', 'client_message_id', 'text', 'reply_to_seq']) }),
  Object.freeze({ method: 'GET', path: '/api/status', class: 'actor', requestFields: Object.freeze([]) }),

  // pre-auth (AD-8): POST /api/auth/enroll · POST /api/auth/challenge ·
  // POST /api/auth/answer · POST /api/auth/local
  Object.freeze({ method: 'POST', path: '/api/auth/enroll', class: 'pre-auth', requestFields: Object.freeze(['invite_token']) }),
  Object.freeze({ method: 'POST', path: '/api/auth/challenge', class: 'pre-auth', requestFields: Object.freeze(['public_key']) }),
  Object.freeze({ method: 'POST', path: '/api/auth/answer', class: 'pre-auth', requestFields: Object.freeze(['nonce', 'signature']) }),
  // Story 1.4: the local credential path is live (issuer/verifier wiring in
  // server.mjs). `implemented` marks registration status for the frozen
  // table's readers; unmarked routes stay unregistered until their stories.
  // The route accepts the frozen-vocabulary field public_key (additive AD-8
  // amendment): Local Mode auto-enrollment under the OS-user boundary — the
  // local token remains the bootstrap credential; presentation is not
  // possession proof (no signature check locally; challenge-response is
  // Epic 4's remote path).
  Object.freeze({ method: 'POST', path: '/api/auth/local', class: 'pre-auth', implemented: true, requestFields: Object.freeze(['public_key']) }),

  // viewer (AD-8): GET /viewer/auth · GET /viewer/ + static assets ·
  // GET /viewer/api/rooms/:id/messages · GET /viewer/api/rooms/:id/events (SSE)
  Object.freeze({ method: 'GET', path: '/viewer/auth', class: 'viewer', requestFields: Object.freeze([]) }),
  Object.freeze({ method: 'GET', path: '/viewer/', class: 'viewer', wildcard: true, requestFields: Object.freeze([]) }),
  Object.freeze({ method: 'GET', path: '/viewer/api/rooms/:id/messages', class: 'viewer', requestFields: Object.freeze(['after_seq', 'limit']) }),
  Object.freeze({ method: 'GET', path: '/viewer/api/rooms/:id/events', class: 'viewer', requestFields: Object.freeze([]) }),

  // health (AD-8): GET /health — live since Story 1.3.
  Object.freeze({ method: 'GET', path: '/health', class: 'health', implemented: true, requestFields: Object.freeze([]) }),
])

// Frozen field vocabulary (AD-8, verbatim names — "additive fields may join,
// names never rename"). The contract test parses the live spine document and
// pins these arrays against it; version and realm_id joined the response
// vocabulary by the spine's 2026-09-25 amendment (AD-14's GET /api/status
// requirement plus health/status self-description), and session_token joined
// by the Story 1.4 amendment (the local credential exchange's response).
export const REQUEST_FIELD_VOCABULARY = Object.freeze([
  'chat_id',
  'client_message_id',
  'text',
  'reply_to_seq',
  'after_seq',
  'limit',
  'wait_ms',
  'include_offline',
  'invite_token',
  'public_key',
  'nonce',
  'signature',
  'realm_id',
  'target_fingerprint',
])

export const RESPONSE_FIELD_VOCABULARY = Object.freeze([
  'messages',
  'seq',
  'next_after_seq',
  'head_seq',
  'room_id',
  'kind',
  'fingerprint',
  'last_seen',
  'connected_since',
  'status',
  'version',
  'realm_id',
  'session_token',
])

// Matching: specific patterns first, wildcard (`/viewer/` + static assets)
// last, so the wildcard entry can never shadow a concrete sibling. `:name`
// segments capture one non-empty path segment; percent-decoding failures make
// the request unmatched rather than lenient. Wildcard entries match their own
// path and everything below it (AD-8: "GET /viewer/ + static assets").
export function matchRoute(method, pathname) {
  const routes = ROUTE_TABLE
  for (const wildcardPass of [false, true]) {
    for (const route of routes) {
      if (route.method !== method || Boolean(route.wildcard) !== wildcardPass) continue
      if (route.wildcard) {
        if (pathname === route.path || pathname.startsWith(route.path)) {
          return { route, params: {} }
        }
        continue
      }
      const params = matchPattern(route.path, pathname)
      if (params) return { route, params }
    }
  }
  return null
}

function matchPattern(pattern, pathname) {
  const patternSegments = pattern.split('/')
  const pathSegments = pathname.split('/')
  if (patternSegments.length !== pathSegments.length) return null
  const params = {}
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index]
    const actual = pathSegments[index]
    if (expected.startsWith(':')) {
      if (actual.length === 0) return null
      const name = expected.slice(1)
      try {
        params[name] = decodeURIComponent(actual)
      } catch {
        return null
      }
    } else if (expected !== actual) {
      return null
    }
  }
  return params
}

export function routeKey(route) {
  return `${route.method} ${route.path}`
}
