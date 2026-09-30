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
  // token. Story 1.6 (additive spine amendment): client_type joins the bind
  // vocabulary — the connecting session may declare its client type from the
  // closed set in the constants module; an omitted declaration stays null
  // (the server never derives one).
  Object.freeze({ method: 'POST', path: '/api/session', class: 'actor', implemented: true, requestFields: Object.freeze(['chat_id', 'client_type']) }),
  Object.freeze({ method: 'PATCH', path: '/api/session', class: 'actor', implemented: true, requestFields: Object.freeze(['chat_id', 'client_type']) }),
  Object.freeze({ method: 'DELETE', path: '/api/session', class: 'actor', implemented: true, requestFields: Object.freeze([]) }),
  // Story 1.6: the presence read is live — one row per live Session within
  // the TTL, plus a separately-labeled offline-recently group from the durable
  // claims index when include_offline is set (query allowlist: this one
  // boolean flag; anything else is rejected, never ignored).
  Object.freeze({ method: 'GET', path: '/api/presence', class: 'actor', implemented: true, requestFields: Object.freeze(['include_offline']) }),
  // Story 2.2: the enumeration read is live — one row per room the reading
  // Actor belongs to: the Broadcast Room with its implicit AD-14 membership
  // plus every Direct Room whose direct_members row names the Actor, in the
  // store's deterministic created-then-id order, each projected to exactly
  // {room_id, kind}. It takes no request fields at all: any query key is an
  // unknown_field rejection.
  Object.freeze({ method: 'GET', path: '/api/rooms', class: 'actor', implemented: true, requestFields: Object.freeze([]) }),
  // Story 1.7: the direct-open and conversation surface is live (handlers in
  // server.mjs). POST /api/rooms/direct resolves the chat id through the
  // durable claims index — zero claims answer chat_id_not_found, several
  // answer ambiguous_chat_id with the candidates list in the error envelope,
  // and target_fingerprint completes disambiguation (never a guess). The
  // messages pair long-polls reads (wait_ms server hold, deadline = a normal
  // possibly-empty page with next_after_seq/head_seq) over idempotent appends
  // (status committed, or the coded client_message_id_conflict).
  Object.freeze({ method: 'POST', path: '/api/rooms/direct', class: 'actor', implemented: true, requestFields: Object.freeze(['chat_id', 'target_fingerprint']) }),
  Object.freeze({ method: 'GET', path: '/api/rooms/:id/messages', class: 'actor', implemented: true, requestFields: Object.freeze(['after_seq', 'limit', 'wait_ms']) }),
  Object.freeze({ method: 'POST', path: '/api/rooms/:id/messages', class: 'actor', implemented: true, requestFields: Object.freeze(['chat_id', 'client_message_id', 'text', 'reply_to_seq']) }),
  // Story 1.6: GET /api/status is live — {realm_id, version, broadcast_room_id}
  // for FR-21 and the Story 1.8 checkpoint (broadcast_room_id joined the
  // response vocabulary by the dated 2026-09-25 spine amendment).
  Object.freeze({ method: 'GET', path: '/api/status', class: 'actor', implemented: true, requestFields: Object.freeze([]) }),

  // pre-auth (AD-8): POST /api/auth/enroll · POST /api/auth/challenge ·
  // POST /api/auth/answer · POST /api/auth/local
  //
  // Story 4.2: the invite-gated enrollment route is live (handler in
  // server.mjs), by the dated 2026-09-29 spine amendment growing its frozen
  // request fields from invite_token alone to invite_token + public_key +
  // signature (all three already in the frozen vocabulary — additions only,
  // NFR-8). The presented token must match the ar_inv1_ shape; the raw
  // 32-byte public key DERIVES the enrolled fingerprint (identity is never
  // a claim); the Ed25519 signature over the exact token bytes is the
  // possession proof the store validates inside the single enrollment
  // transaction before anything is consumed. The budgets stage paces this
  // route at 5/min per client identity (burst 5) with forwarded addresses
  // trusted only from an explicitly configured proxy.
  Object.freeze({ method: 'POST', path: '/api/auth/enroll', class: 'pre-auth', implemented: true, requestFields: Object.freeze(['invite_token', 'public_key', 'signature']) }),
  // Story 4.1: the remote credential path's pair is live (handlers in
  // server.mjs). The challenge stays OPEN to any well-formed 32-byte public
  // key — issuing a nonce is privilegeless, and Story 4.2's invite
  // enrollment is itself a challenge-response consumer — while the answer is
  // GATED on the durable enrolled_actors record. Identity binds at challenge
  // time: the answer's frozen field set carries no public_key, so the
  // signature always verifies against the key the nonce was issued to.
  Object.freeze({ method: 'POST', path: '/api/auth/challenge', class: 'pre-auth', implemented: true, requestFields: Object.freeze(['public_key']) }),
  Object.freeze({ method: 'POST', path: '/api/auth/answer', class: 'pre-auth', implemented: true, requestFields: Object.freeze(['nonce', 'signature']) }),
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
// requirement plus health/status self-description), session_token joined
// by the Story 1.4 amendment (the local credential exchange's response), the
// Story 1.6 amendments add client_type to the requests (the closed-set
// client type declared at bind time) and — by the Story 1.6 review
// amendment — broadcast_room_id, the two presence group labels, and the
// presence row fields chat_id and client_type to the responses, and the
// Story 1.7 amendment adds candidates to the responses (the optional
// candidate list the ambiguous_chat_id error carries for target_fingerprint
// disambiguation — never a guess), the Story 2.2 amendment adds rooms
// (the enumeration list GET /api/rooms returns — one row per room the reading
// Actor belongs to, each carrying the room id and kind), and the Story 4.1
// amendment adds nonce (the single-use challenge nonce POST /api/auth/challenge
// issues and POST /api/auth/answer spends — see the spine's dated amendment).
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
  'client_type',
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
  'broadcast_room_id',
  'online',
  'offline_recently',
  'chat_id',
  'client_type',
  'candidates',
  'rooms',
  'nonce',
  // Story 4.4 (additive, dated spine amendment): original_seq is the original
  // room-local sequence a duplicate_dropped send names (FR-17's explicit
  // notice), and retry_after_ms is the retry delay every rate_limited refusal
  // carries in its error envelope (the extras are declared in the pipeline's
  // ERROR_ENVELOPE_EXTRAS — a code carries only its declared extras).
  'original_seq',
  'retry_after_ms',
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
