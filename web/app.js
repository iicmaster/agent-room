"use strict";

const TOKEN_KEY = "agent-room.viewer-token";
const SELECTED_ROOM_KEY = "agent-room.selected-room";
const PAGE_SIZE = 100;
const MAX_RECONNECT_DELAY_MS = 10_000;

const elements = Object.freeze({
  connectionStatus: document.getElementById("connection-status"),
  connectionLabel: document.getElementById("connection-label"),
  retryButton: document.getElementById("retry-button"),
  roomCount: document.getElementById("room-count"),
  roomList: document.getElementById("room-list"),
  conversationHeading: document.getElementById("conversation-heading"),
  conversationCursor: document.getElementById("conversation-cursor"),
  notice: document.getElementById("notice"),
  messageList: document.getElementById("message-list"),
});

const state = {
  token: "",
  rooms: [],
  selectedRoomId: null,
  messageBySeq: new Map(),
  lastSeq: 0,
  stream: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  roomLoadVersion: 0,
  requestController: null,
  busy: false,
};

class ViewerError extends Error {}

function sessionGet(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // The in-memory value still supports this page when storage is unavailable.
  }
}

function readTokenAndCleanAddress() {
  const currentUrl = new URL(window.location.href);
  const tokenFromUrl = currentUrl.searchParams.get("token");

  if (tokenFromUrl) {
    sessionSet(TOKEN_KEY, tokenFromUrl);
  }

  currentUrl.searchParams.delete("token");
  const cleanAddress = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
  window.history.replaceState(window.history.state, "", cleanAddress);

  return tokenFromUrl || sessionGet(TOKEN_KEY) || "";
}

function apiUrl(pathname, parameters = {}) {
  const url = new URL(pathname, window.location.origin);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("token", state.token);
  return url;
}

async function getJson(url, signal) {
  const response = await window.fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });

  if (!response.ok) {
    throw new ViewerError(`The server returned HTTP ${response.status}.`);
  }

  try {
    return await response.json();
  } catch {
    throw new ViewerError("The server returned an unreadable response.");
  }
}

function safeSequence(value, allowZero = false) {
  const sequence = Number(value);
  const minimum = allowZero ? 0 : 1;
  return Number.isSafeInteger(sequence) && sequence >= minimum ? sequence : null;
}

function safeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normaliseRooms(payload) {
  const candidates = Array.isArray(payload) ? payload : payload?.rooms;
  if (!Array.isArray(candidates)) {
    throw new ViewerError("The room list has an unexpected shape.");
  }

  const seen = new Set();
  const rooms = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const id = safeText(candidate.id || candidate.roomId || candidate.room_id).trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    rooms.push({
      id,
      title: safeText(candidate.title).trim() || `Room ${id}`,
      createdAt: safeText(candidate.createdAt || candidate.created_at),
    });
  }
  return rooms;
}

function rawMessagesFrom(payload) {
  const candidates = Array.isArray(payload) ? payload : payload?.messages;
  if (!Array.isArray(candidates)) {
    throw new ViewerError("The message list has an unexpected shape.");
  }
  return candidates;
}

function normaliseMessage(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const seq = safeSequence(candidate.seq);
  if (seq === null || typeof candidate.text !== "string") {
    return null;
  }

  const actor = candidate.actor && typeof candidate.actor === "object" ? candidate.actor : {};
  const actorId = safeText(actor.id || candidate.actorId || candidate.actor_id, "unknown");
  const actorName = safeText(
    actor.name || candidate.actorDisplayName || candidate.actor_display_name,
    actorId || "Unknown actor",
  );
  const replyValue = candidate.replyToSeq ?? candidate.reply_to_seq;

  return {
    seq,
    roomId: safeText(candidate.roomId || candidate.room_id),
    actorId,
    actorName: actorName || "Unknown actor",
    text: candidate.text,
    replyToSeq: replyValue === null || replyValue === undefined ? null : safeSequence(replyValue),
    createdAt: safeText(candidate.createdAt || candidate.created_at),
  };
}

function setConnectionState(kind, label) {
  elements.connectionStatus.dataset.state = kind;
  elements.connectionLabel.textContent = label;
}

function setBusy(busy) {
  state.busy = busy;
  elements.retryButton.disabled = busy;
  elements.messageList.setAttribute("aria-busy", String(busy));
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

function renderRooms() {
  const fragment = document.createDocumentFragment();
  const focusedRoomId = document.activeElement?.dataset?.roomId || null;
  let replacementForFocus = null;

  for (const room of state.rooms) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const isSelected = room.id === state.selectedRoomId;

    button.type = "button";
    button.className = "room-button";
    button.dataset.roomId = room.id;
    button.textContent = room.title;
    button.setAttribute("aria-current", String(isSelected));
    button.setAttribute("aria-label", `Open room ${room.title}`);
    button.addEventListener("click", () => {
      if (room.id !== state.selectedRoomId || state.messageBySeq.size === 0) {
        void openRoom(room.id);
      }
    });
    if (room.id === focusedRoomId) {
      replacementForFocus = button;
    }

    item.append(button);
    fragment.append(item);
  }

  elements.roomList.replaceChildren(fragment);
  elements.roomCount.textContent = String(state.rooms.length);
  replacementForFocus?.focus({ preventScroll: true });
}

function actorTone(actorId) {
  let hash = 0;
  for (const character of actorId) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return String(hash % 4);
}

function actorInitial(actorName) {
  const initial = Array.from(actorName.trim())[0];
  return initial ? initial.toLocaleUpperCase() : "?";
}

function formattedTime(rawTimestamp) {
  const date = new Date(rawTimestamp);
  if (!rawTimestamp || Number.isNaN(date.getTime())) {
    return { machine: "", human: "Unknown time" };
  }
  return {
    machine: date.toISOString(),
    human: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  };
}

function renderInlineMarkdown(text, parent) {
  const pattern = /(`[^`\n]+`|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("***") && token.endsWith("***")) {
      const strong = document.createElement("strong");
      const em = document.createElement("em");
      em.textContent = token.slice(3, -3);
      strong.append(em);
      parent.append(strong);
    } else if (token.startsWith("**") && token.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      const em = document.createElement("em");
      em.textContent = token.slice(1, -1);
      parent.append(em);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    parent.append(document.createTextNode(text.slice(lastIndex)));
  }
}

function renderMarkdownBody(rawText) {
  const container = document.createElement("div");
  container.className = "message-text markdown-body";

  const lines = rawText.split("\n");
  let inCodeBlock = false;
  let codeLines = [];
  let codeLang = "";
  let currentList = null;
  let currentListType = null;
  let currentParagraph = null;

  function flushParagraph() {
    if (currentParagraph) {
      container.append(currentParagraph);
      currentParagraph = null;
    }
  }

  function flushList() {
    if (currentList) {
      container.append(currentList);
      currentList = null;
      currentListType = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fenceMatch = line.match(/^```(\w+)?/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        flushParagraph();
        flushList();
        inCodeBlock = true;
        codeLang = fenceMatch[1] || "";
        codeLines = [];
      } else {
        inCodeBlock = false;
        const pre = document.createElement("pre");
        pre.className = "code-block";
        if (codeLang) pre.dataset.lang = codeLang;
        const code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.append(code);
        container.append(pre);
        codeLines = [];
        codeLang = "";
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.min(headingMatch[1].length + 2, 6);
      const heading = document.createElement(`h${level}`);
      renderInlineMarkdown(headingMatch[2], heading);
      container.append(heading);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      const blockquote = document.createElement("blockquote");
      renderInlineMarkdown(quoteMatch[1], blockquote);
      container.append(blockquote);
      continue;
    }

    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      flushParagraph();
      if (!currentList || currentListType !== "ul") {
        flushList();
        currentList = document.createElement("ul");
        currentListType = "ul";
      }
      const li = document.createElement("li");
      renderInlineMarkdown(ulMatch[1], li);
      currentList.append(li);
      continue;
    }

    const olMatch = line.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      flushParagraph();
      if (!currentList || currentListType !== "ol") {
        flushList();
        currentList = document.createElement("ol");
        currentListType = "ol";
      }
      const li = document.createElement("li");
      renderInlineMarkdown(olMatch[1], li);
      currentList.append(li);
      continue;
    }

    flushList();
    if (!currentParagraph) {
      currentParagraph = document.createElement("p");
      renderInlineMarkdown(line, currentParagraph);
    } else {
      currentParagraph.append(document.createElement("br"));
      renderInlineMarkdown(line, currentParagraph);
    }
  }

  if (inCodeBlock && codeLines.length > 0) {
    const pre = document.createElement("pre");
    pre.className = "code-block";
    const code = document.createElement("code");
    code.textContent = codeLines.join("\n");
    pre.append(code);
    container.append(pre);
  }
  flushParagraph();
  flushList();

  return container;
}

function messageCard(message) {
  const item = document.createElement("li");
  const article = document.createElement("article");
  const meta = document.createElement("header");
  const identity = document.createElement("div");
  const avatar = document.createElement("span");
  const actor = document.createElement("span");
  const time = document.createElement("time");
  const content = renderMarkdownBody(message.text);
  const sequence = document.createElement("p");
  const timestamp = formattedTime(message.createdAt);

  article.id = `message-${message.seq}`;
  article.className = "message-card";
  article.dataset.seq = String(message.seq);

  meta.className = "message-meta";
  identity.className = "actor-identity";
  avatar.className = "actor-avatar";
  avatar.dataset.tone = actorTone(message.actorId);
  avatar.textContent = actorInitial(message.actorName);
  avatar.setAttribute("aria-hidden", "true");
  actor.className = "actor-name";
  actor.textContent = message.actorName;
  time.className = "message-time";
  time.dateTime = timestamp.machine;
  time.textContent = timestamp.human;

  identity.append(avatar, actor);
  meta.append(identity, time);
  article.append(meta);

  if (message.replyToSeq !== null) {
    const targetExists = state.messageBySeq.has(message.replyToSeq);
    const reply = document.createElement(targetExists ? "a" : "span");
    reply.className = targetExists ? "reply-reference" : "reply-reference missing";
    reply.textContent = `Reply to message #${message.replyToSeq}`;
    if (targetExists) {
      reply.href = `#message-${message.replyToSeq}`;
    }
    article.append(reply);
  }

  sequence.className = "message-sequence";
  sequence.textContent = `#${message.seq}`;
  article.append(content, sequence);
  item.append(article);
  return item;
}

function renderMessages({ forceBottom = false } = {}) {
  const priorScrollTop = elements.messageList.scrollTop;
  const distanceFromBottom =
    elements.messageList.scrollHeight - elements.messageList.scrollTop - elements.messageList.clientHeight;
  const wasNearBottom = distanceFromBottom < 96;
  const focusedCard = document.activeElement?.closest?.(".message-card");
  const focusedSeq = focusedCard?.dataset.seq || null;
  const messages = [...state.messageBySeq.values()].sort((left, right) => left.seq - right.seq);
  const fragment = document.createDocumentFragment();

  for (const message of messages) {
    fragment.append(messageCard(message));
  }
  elements.messageList.replaceChildren(fragment);

  elements.conversationCursor.textContent = state.lastSeq > 0 ? `Caught up through #${state.lastSeq}` : "No messages yet";

  if (messages.length === 0) {
    showNotice("empty", "No messages in this room yet.");
  } else {
    hideNotice();
  }

  if (forceBottom || wasNearBottom) {
    elements.messageList.scrollTop = elements.messageList.scrollHeight;
  } else {
    elements.messageList.scrollTop = priorScrollTop;
  }

  if (focusedSeq) {
    const focusedTarget = document.getElementById(`message-${focusedSeq}`)?.querySelector("a");
    focusedTarget?.focus({ preventScroll: true });
  }
}

function addMessage(message) {
  if (message.roomId && message.roomId !== state.selectedRoomId) {
    return false;
  }
  if (state.messageBySeq.has(message.seq)) {
    return false;
  }
  state.messageBySeq.set(message.seq, message);
  state.lastSeq = Math.max(state.lastSeq, message.seq);
  return true;
}

function closeStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

async function catchUp(version, signal) {
  let cursor = state.lastSeq;

  for (;;) {
    const requestCursor = cursor;
    const url = apiUrl(`/api/rooms/${encodeURIComponent(state.selectedRoomId)}/messages`, {
      after: requestCursor,
      limit: PAGE_SIZE,
    });
    const payload = await getJson(url, signal);
    if (version !== state.roomLoadVersion) {
      return;
    }

    const candidates = rawMessagesFrom(payload);
    let validCount = 0;
    for (const candidate of candidates) {
      const message = normaliseMessage(candidate);
      if (!message) {
        continue;
      }
      validCount += 1;
      cursor = Math.max(cursor, message.seq);
      addMessage(message);
    }

    if (candidates.length > 0 && validCount === 0) {
      throw new ViewerError("The server returned messages with an unexpected shape.");
    }

    const responseCursor = safeSequence(payload?.nextSeq ?? payload?.next_seq, true);
    if (responseCursor !== null) {
      cursor = Math.max(cursor, responseCursor);
      state.lastSeq = Math.max(state.lastSeq, responseCursor);
    }

    if (candidates.length < PAGE_SIZE) {
      break;
    }
    if (cursor <= requestCursor) {
      throw new ViewerError("The message cursor did not advance.");
    }
  }
}

function reconnectDelay() {
  const delay = Math.min(1_000 * 2 ** state.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
  state.reconnectAttempt += 1;
  return delay;
}

function scheduleReconnect(version) {
  if (version !== state.roomLoadVersion || state.reconnectTimer !== null) {
    return;
  }
  setConnectionState("reconnecting", "Reconnecting…");
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    if (version === state.roomLoadVersion) {
      void resumeRoom();
    }
  }, reconnectDelay());
}

function openStream(version) {
  if (version !== state.roomLoadVersion || !state.selectedRoomId) {
    return;
  }

  if (state.stream) {
    state.stream.close();
  }

  const url = apiUrl(`/api/rooms/${encodeURIComponent(state.selectedRoomId)}/events`, {
    after: state.lastSeq,
  });
  const stream = new EventSource(url);
  state.stream = stream;

  stream.addEventListener("open", () => {
    if (stream !== state.stream || version !== state.roomLoadVersion) {
      return;
    }
    state.reconnectAttempt = 0;
    setConnectionState("live", "Live");
  });

  stream.addEventListener("message", (event) => {
    if (stream !== state.stream || version !== state.roomLoadVersion) {
      return;
    }
    try {
      const payload = JSON.parse(event.data);
      const message = normaliseMessage(payload?.message || payload);
      if (!message) {
        throw new ViewerError("The live stream returned an unexpected message.");
      }
      if (addMessage(message)) {
        renderMessages();
      }
      setConnectionState("live", "Live");
    } catch {
      stream.close();
      if (stream === state.stream) {
        state.stream = null;
      }
      showNotice("error", "A live update was unreadable. Reconnecting from the last message…");
      scheduleReconnect(version);
    }
  });

  stream.addEventListener("error", () => {
    if (stream !== state.stream || version !== state.roomLoadVersion) {
      return;
    }
    stream.close();
    state.stream = null;
    scheduleReconnect(version);
  });
}

function errorMessage(error, fallback) {
  return error instanceof ViewerError ? error.message : fallback;
}

async function openRoom(roomId) {
  const room = state.rooms.find((candidate) => candidate.id === roomId);
  if (!room) {
    return;
  }

  state.roomLoadVersion += 1;
  const version = state.roomLoadVersion;
  state.requestController?.abort();
  state.requestController = new AbortController();
  closeStream();

  state.selectedRoomId = room.id;
  state.messageBySeq.clear();
  state.lastSeq = 0;
  sessionSet(SELECTED_ROOM_KEY, room.id);
  renderRooms();
  elements.conversationHeading.textContent = room.title;
  elements.conversationCursor.textContent = "Loading messages…";
  elements.messageList.replaceChildren();
  showNotice("loading", "Loading messages…");
  setConnectionState("reconnecting", "Connecting…");
  setBusy(true);

  try {
    await catchUp(version, state.requestController.signal);
    if (version !== state.roomLoadVersion) {
      return;
    }
    renderMessages({ forceBottom: true });
    setConnectionState("caught-up", "Caught up");
    openStream(version);
  } catch (error) {
    if (error?.name === "AbortError" || version !== state.roomLoadVersion) {
      return;
    }
    setConnectionState("error", "Needs retry");
    showNotice("error", errorMessage(error, "Could not load this room."));
  } finally {
    if (version === state.roomLoadVersion) {
      setBusy(false);
    }
  }
}

async function resumeRoom() {
  if (!state.selectedRoomId) {
    await loadRooms();
    return;
  }

  state.roomLoadVersion += 1;
  const version = state.roomLoadVersion;
  state.requestController?.abort();
  state.requestController = new AbortController();
  closeStream();
  setBusy(true);
  setConnectionState("reconnecting", "Reconnecting…");
  hideNotice();

  try {
    await catchUp(version, state.requestController.signal);
    if (version !== state.roomLoadVersion) {
      return;
    }
    renderMessages();
    setConnectionState("caught-up", "Caught up");
    openStream(version);
  } catch (error) {
    if (error?.name === "AbortError" || version !== state.roomLoadVersion) {
      return;
    }
    setConnectionState("error", "Needs retry");
    showNotice("error", errorMessage(error, "Could not reconnect to this room."));
  } finally {
    if (version === state.roomLoadVersion) {
      setBusy(false);
    }
  }
}

async function loadRooms() {
  state.requestController?.abort();
  state.requestController = new AbortController();
  closeStream();
  setBusy(true);
  setConnectionState("reconnecting", "Connecting…");
  showNotice("loading", "Loading rooms…");

  try {
    const payload = await getJson(apiUrl("/api/rooms"), state.requestController.signal);
    state.rooms = normaliseRooms(payload);

    const savedRoomId = sessionGet(SELECTED_ROOM_KEY);
    const selected = state.rooms.find((room) => room.id === savedRoomId) || state.rooms[0] || null;
    state.selectedRoomId = selected?.id || null;
    renderRooms();

    if (!selected) {
      state.messageBySeq.clear();
      state.lastSeq = 0;
      elements.conversationHeading.textContent = "No room selected";
      elements.conversationCursor.textContent = "No rooms available";
      elements.messageList.replaceChildren();
      showNotice("empty", "No rooms are available yet.");
      setConnectionState("caught-up", "Caught up");
      return;
    }

    await openRoom(selected.id);
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }
    setConnectionState("error", "Needs retry");
    showNotice("error", errorMessage(error, "Could not load rooms."));
  } finally {
    setBusy(false);
  }
}

function handleRoomListKeys(event) {
  const buttons = [...elements.roomList.querySelectorAll("button")];
  if (buttons.length === 0) {
    return;
  }

  const currentIndex = buttons.indexOf(document.activeElement);
  let targetIndex = null;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    targetIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % buttons.length;
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    targetIndex = currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1;
  } else if (event.key === "Home") {
    targetIndex = 0;
  } else if (event.key === "End") {
    targetIndex = buttons.length - 1;
  }

  if (targetIndex !== null) {
    event.preventDefault();
    buttons[targetIndex].focus();
  }
}

async function initialise() {
  state.token = readTokenAndCleanAddress();
  if (!state.token) {
    setBusy(false);
    setConnectionState("error", "Token required");
    showNotice("error", "Open this viewer with a ?token=… link from agent-roomd.");
    return;
  }
  await loadRooms();
}

elements.retryButton.addEventListener("click", () => {
  if (state.busy || !state.token) {
    return;
  }
  void (state.selectedRoomId ? resumeRoom() : loadRooms());
});

elements.roomList.addEventListener("keydown", handleRoomListKeys);

window.addEventListener("online", () => {
  if (!state.busy && state.token && state.selectedRoomId && elements.connectionStatus.dataset.state !== "live") {
    void resumeRoom();
  }
});

window.addEventListener("pagehide", () => {
  state.requestController?.abort();
  closeStream();
});

void initialise();
