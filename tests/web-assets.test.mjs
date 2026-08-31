import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(testDirectory, "..");
const paths = {
  html: path.join(rootDirectory, "web", "index.html"),
  script: path.join(rootDirectory, "web", "app.js"),
  styles: path.join(rootDirectory, "web", "styles.css"),
};

async function assets() {
  const [html, script, styles] = await Promise.all([
    readFile(paths.html, "utf8"),
    readFile(paths.script, "utf8"),
    readFile(paths.styles, "utf8"),
  ]);
  return { html, script, styles };
}

test("viewer assets exist and are self-contained", async () => {
  const { html, script, styles } = await assets();

  assert.ok(html.length > 500);
  assert.ok(script.length > 1_000);
  assert.ok(styles.length > 500);
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(styles, /url\s*\(/i);
  assert.doesNotMatch(html, /<(?:img|iframe|audio|video|object|embed)\b/i);
});

test("viewer exposes only read-only controls and GET transports", async () => {
  const { html, script } = await assets();

  assert.doesNotMatch(html, /<(?:form|input|textarea|select)\b/i);
  assert.doesNotMatch(html, /contenteditable/i);
  assert.doesNotMatch(script, /method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
  assert.doesNotMatch(script, /\b(?:WebSocket|sendBeacon)\b/);
  assert.match(script, /method:\s*"GET"/);
  assert.match(script, /new EventSource\(url\)/);
  assert.match(script, /normaliseMessage\(payload\?\.message \|\| payload\)/);
  assert.match(html, /id="retry-button"[^>]*type="button"/);
});

test("untrusted room and message data never enters an HTML sink", async () => {
  const { script } = await assets();

  for (const unsafeSink of [
    /\.innerHTML\b/,
    /\.outerHTML\b/,
    /insertAdjacentHTML\s*\(/,
    /document\.write\s*\(/,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /DOMParser\b/,
  ]) {
    assert.doesNotMatch(script, unsafeSink);
  }

  assert.match(script, /document\.createElement\(/);
  assert.match(script, /\.textContent\s*=/);
  assert.doesNotMatch(script, /localStorage|document\.cookie/);
});

test("token moves to session storage and is removed from the visible URL", async () => {
  const { script } = await assets();

  assert.match(script, /searchParams\.get\("token"\)/);
  assert.match(script, /sessionStorage\.setItem\(key, value\)/);
  assert.match(script, /searchParams\.delete\("token"\)/);
  assert.match(script, /history\.replaceState\(/);
  assert.match(script, /searchParams\.set\("token", state\.token\)/);
});

test("viewer uses required room, message, and SSE cursor contracts", async () => {
  const { script } = await assets();

  assert.match(script, /apiUrl\("\/api\/rooms"\)/);
  assert.match(script, /\/api\/rooms\/\$\{encodeURIComponent\(state\.selectedRoomId\)\}\/messages/);
  assert.match(script, /\/api\/rooms\/\$\{encodeURIComponent\(state\.selectedRoomId\)\}\/events/);
  assert.match(script, /after:\s*state\.lastSeq/);
  assert.match(script, /limit:\s*PAGE_SIZE/);
  assert.match(script, /state\.messageBySeq\.has\(message\.seq\)/);
  assert.match(script, /state\.messageBySeq\.set\(message\.seq, message\)/);
  assert.match(script, /\.sort\(\(left, right\) => left\.seq - right\.seq\)/);
});

test("viewer communicates live, reconnecting, caught-up, empty, and error states", async () => {
  const { html, script } = await assets();

  assert.match(html, /role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="notice"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(script, /kind === "error" \? "alert" : "status"/);
  assert.match(script, /setConnectionState\("live", "Live"\)/);
  assert.match(script, /setConnectionState\("reconnecting", "Reconnecting…"\)/);
  assert.match(script, /setConnectionState\("caught-up", "Caught up"\)/);
  assert.match(script, /showNotice\("empty"/);
  assert.match(script, /showNotice\("error"/);
});

test("selected room, keyboard navigation, and scroll intent survive refreshes", async () => {
  const { html, script } = await assets();

  assert.match(script, /sessionSet\(SELECTED_ROOM_KEY, room\.id\)/);
  assert.match(script, /sessionGet\(SELECTED_ROOM_KEY\)/);
  assert.match(script, /event\.key === "ArrowDown"/);
  assert.match(script, /event\.key === "Home"/);
  assert.match(script, /distanceFromBottom < 96/);
  assert.match(script, /focusedTarget\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(script, /replacementForFocus\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(html, /href="#conversation"/);
  assert.match(html, /aria-label="Available chat rooms"/);
});
