"use strict";

// The Agent Room live viewer (Story 5.2, FR-18/HCI-5). Cookie-authenticated
// only: the browser got its HttpOnly SameSite=Strict session cookie from
// GET /viewer/auth (Story 5.1's Bearer→cookie bridge) before this page ever
// loaded, so every request below — the boot descriptor and the one
// EventSource stream — presents it automatically and NO credential ever
// appears in a URL, a query string, or storage. All room text renders inert:
// this script builds the DOM exclusively with createElement/textContent and
// the served CSP (default-src 'self', no inline script) backstops it.

const elements = Object.freeze({
  connectionStatus: document.getElementById("connection-status"),
  connectionLabel: document.getElementById("connection-label"),
  retryButton: document.getElementById("retry-button"),
  presenceCount: document.getElementById("presence-count"),
  presenceOnline: document.getElementById("presence-online"),
  presenceOffline: document.getElementById("presence-offline"),
  conversationCursor: document.getElementById("conversation-cursor"),
  notice: document.getElementById("notice"),
  messageList: document.getElementById("message-list"),
});

// The viewer session's states (FR-18's full set). Each has one defined cause
// and one label; tests/pin the causes server-side and this mapping in the
// asset contract:
//   loading        — the page is open, the boot descriptor not yet answered
//   live           — the SSE stream is open and current (authenticated)
//   empty          — live, and the Broadcast Room has no messages yet
//   reconnecting   — the stream dropped; EventSource is re-establishing it
//   unreachable    — the server would not answer at all (connection refused,
//                    a network failure) — reported unreachable, never
//                    "everyone offline"
//   expired        — the server answered 401: the viewer session is no
//                    longer valid (the operator rotated the viewer
//                    credential); a new cookie must be minted via
//                    GET /viewer/auth
const STATE_LABELS = Object.freeze({
  loading: "Loading…",
  live: "Live",
  empty: "Live · no messages yet",
  reconnecting: "Reconnecting…",
  unreachable: "Room server unreachable",
  expired: "Viewer session invalid — mint a new one",
});

const state = {
  stream: null,
  streamGeneration: 0,
  broadcastRoomId: null,
  messagesBySeq: new Map(),
  presence: { online: [], offline_recently: [] },
  expired: false,
};

class ViewerError extends Error {}

function setConnectionState(kind) {
  elements.connectionStatus.dataset.state = kind;
  elements.connectionLabel.textContent = STATE_LABELS[kind] ?? kind;
  elements.retryButton.hidden = kind !== "unreachable" && kind !== "expired";
}

function showNotice(kind, message) {
  elements.notice.dataset.kind = kind;
  elements.notice.setAttribute("role", kind === "error" ? "alert" : "status");
  elements.notice.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  elements.notice.textContent = message;
  elements.notice.hidden = false;
}

function hideNotice() {
  elements.notice.hidden = true;
  elements.notice.textContent = "";
  delete elements.notice.dataset.kind;
}

async function getJson(path) {
  let response;
  try {
    response = await window.fetch(path, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    // A fetch that cannot even complete is an unreachable server — the
    // caller distinguishes it from an answered refusal.
    throw new ViewerError("unreachable");
  }
  if (response.status === 401) {
    // The cookie no longer authenticates: rotation or expiry server-side.
    throw new ViewerError("expired");
  }
  if (!response.ok) {
    throw new ViewerError("unreachable");
  }
  try {
    return await response.json();
  } catch {
    throw new ViewerError("unreachable");
  }
}

// One credential-free discovery step: the generated descriptor names the
// Broadcast Room (and only the Broadcast Room — Direct Rooms are learnable
// from nothing the viewer serves).
async function loadBoot() {
  const boot = await getJson("/viewer/boot.json");
  const roomId = typeof boot?.broadcast_room_id === "string" ? boot.broadcast_room_id : "";
  if (!roomId) {
    throw new ViewerError("unreachable");
  }
  return roomId;
}

function safeSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
}

function safeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

// Inert rendering: text never becomes markup. Every field lands in
// textContent — hostile text (tags, event handlers, pseudo-markdown) is
// displayed as the characters it is, nothing more.
function renderMessage(message) {
  const item = document.createElement("li");
  const article = document.createElement("article");
  article.className = "message-card";
  article.id = `message-${message.seq}`;
  article.dataset.seq = String(message.seq);

  const meta = document.createElement("header");
  meta.className = "message-meta";
  const actor = document.createElement("span");
  actor.className = "actor-name";
  actor.textContent = message.chatId;
  const time = document.createElement("time");
  const moment = new Date(message.createdAt);
  if (!Number.isNaN(moment.getTime())) {
    time.dateTime = moment.toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(moment);
  } else {
    time.textContent = "unknown time";
  }
  meta.append(actor, time);

  const sequence = document.createElement("span");
  sequence.className = "message-sequence";
  sequence.textContent = `#${message.seq}`;

  const body = document.createElement("p");
  body.className = "message-text";
  body.textContent = message.text;

  article.append(meta, body, sequence);
  item.append(article);
  return item;
}

function renderMessages() {
  const ordered = [...state.messagesBySeq.values()].sort((left, right) => left.seq - right.seq);
  const fragment = document.createDocumentFragment();
  for (const message of ordered) {
    fragment.append(renderMessage(message));
  }
  elements.messageList.replaceChildren(fragment);
  elements.messageList.setAttribute("aria-busy", "false");
  elements.conversationCursor.textContent = ordered.length > 0
    ? `Caught up through #${ordered[ordered.length - 1].seq}`
    : "No messages yet";
  if (ordered.length === 0) {
    setConnectionState("empty");
    showNotice("empty", "No messages in the Broadcast Room yet — they will appear here live.");
  } else {
    if (elements.connectionStatus.dataset.state === "empty") setConnectionState("live");
    hideNotice();
    elements.messageList.scrollTop = elements.messageList.scrollHeight;
  }
}

function presenceRow(entry, seenLabel) {
  const item = document.createElement("li");
  const name = document.createElement("span");
  name.className = "presence-name";
  name.textContent = safeText(entry.chat_id, "unknown");
  const detail = document.createElement("span");
  detail.className = "presence-detail";
  const type = entry.client_type ? ` · ${String(entry.client_type)}` : "";
  detail.textContent = `${seenLabel}${type}`;
  item.append(name, detail);
  return item;
}

function renderPresence() {
  const online = Array.isArray(state.presence.online) ? state.presence.online : [];
  const offline = Array.isArray(state.presence.offline_recently) ? state.presence.offline_recently : [];
  const onlineFragment = document.createDocumentFragment();
  for (const entry of online) {
    onlineFragment.append(presenceRow(entry, "online now"));
  }
  elements.presenceOnline.replaceChildren(onlineFragment);
  const offlineFragment = document.createDocumentFragment();
  for (const entry of offline) {
    offlineFragment.append(presenceRow(entry, "seen recently"));
  }
  elements.presenceOffline.replaceChildren(offlineFragment);
  elements.presenceCount.textContent = String(online.length);
}

function applyPresenceSnapshot(raw) {
  const snapshot = raw && typeof raw === "object" ? raw : {};
  state.presence = {
    online: Array.isArray(snapshot.online) ? snapshot.online : [],
    offline_recently: Array.isArray(snapshot.offline_recently) ? snapshot.offline_recently : [],
  };
  renderPresence();
}

function handleStreamError() {
  const generation = state.streamGeneration;
  const stream = state.stream;
  if (state.expired) return;
  if (stream && stream.readyState === 2) {
    // EventSource gave up (CLOSED): the server refused the reconnection.
    // Distinguish a rotated/invalidated session from a dead server with one
    // boot probe, then settle into the matching terminal state.
    state.stream = null;
    void getJson("/viewer/boot.json").then(
      () => {
        // The cookie is fine and the server answers: a transient drop —
        // re-open the stream ourselves.
        if (generation === state.streamGeneration) openStream();
      },
      (error) => {
        if (generation !== state.streamGeneration) return;
        if (error instanceof ViewerError && error.message === "expired") {
          setConnectionState("expired");
          showNotice("error", "The viewer session is no longer valid. Run “agent-room viewer rotate”, mint a new cookie via GET /viewer/auth, and reload.");
        } else {
          setConnectionState("unreachable");
          showNotice("error", "The room server is unreachable. It will reconnect when the server answers; use Retry to try now.");
        }
      },
    );
    return;
  }
  // readyState 0 (CONNECTING): EventSource is retrying on its own.
  setConnectionState("reconnecting");
}

function openStream() {
  if (!state.broadcastRoomId) return;
  if (state.stream) state.stream.close();
  state.streamGeneration += 1;
  const generation = state.streamGeneration;

  // ONE stream for everything (DR-3): room-message events and presence
  // snapshots ride the same text/event-stream response. The cookie rides
  // automatically; there is nothing to append to this URL, ever.
  const stream = new EventSource(`/viewer/api/rooms/${encodeURIComponent(state.broadcastRoomId)}/events`);
  state.stream = stream;

  stream.addEventListener("open", () => {
    if (generation !== state.streamGeneration) return;
    setConnectionState(state.messagesBySeq.size === 0 ? "empty" : "live");
  });

  stream.addEventListener("presence", (event) => {
    if (generation !== state.streamGeneration) return;
    try {
      applyPresenceSnapshot(JSON.parse(event.data));
    } catch {
      // A malformed frame is skipped, not fatal: the next snapshot re-syncs.
    }
  });

  stream.addEventListener("message", (event) => {
    if (generation !== state.streamGeneration) return;
    let raw;
    try {
      raw = JSON.parse(event.data);
    } catch {
      return;
    }
    const seq = safeSequence(raw?.seq);
    const text = typeof raw?.text === "string" ? raw.text : null;
    if (seq === null || text === null || state.messagesBySeq.has(seq)) return;
    state.messagesBySeq.set(seq, {
      seq,
      text,
      chatId: safeText(raw.chat_id, "unknown"),
      createdAt: safeText(raw.created_at, ""),
    });
    renderMessages();
  });

  stream.addEventListener("error", handleStreamError);
}

async function initialise() {
  setConnectionState("loading");
  try {
    state.broadcastRoomId = await loadBoot();
    openStream();
  } catch (error) {
    if (error instanceof ViewerError && error.message === "expired") {
      state.expired = true;
      setConnectionState("expired");
      showNotice("error", "The viewer session is no longer valid. Run “agent-room viewer rotate”, mint a new cookie via GET /viewer/auth, and reload.");
    } else {
      setConnectionState("unreachable");
      showNotice("error", "The room server is unreachable. It reported no status — retrying keeps trying.");
    }
  }
}

elements.retryButton.addEventListener("click", () => {
  state.expired = false;
  setConnectionState("reconnecting");
  void initialise();
});

window.addEventListener("pagehide", () => {
  if (state.stream) state.stream.close();
  state.stream = null;
});

void initialise();
