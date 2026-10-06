import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The v0.2 live-viewer asset contract (Stories 5.1 + 5.2): the shell is
// served from /viewer/ (cookie-gated), authenticates by the HttpOnly cookie
// alone, follows ONE EventSource stream carrying room + presence events, and
// renders every text inert. These rows pin the SOURCE-level discipline the
// wire tests in tests/viewer.test.mjs drive over real HTTP.

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

test("viewer assets exist and are self-contained under /viewer/", async () => {
  const { html, script, styles } = await assets();

  assert.ok(html.length > 500);
  assert.ok(script.length > 1_000);
  assert.ok(styles.length > 500);
  assert.match(html, /href="\/viewer\/styles\.css"/);
  assert.match(html, /src="\/viewer\/app\.js"/);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(styles, /url\s*\(/i);
  assert.doesNotMatch(html, /<(?:img|iframe|audio|video|object|embed)\b/i);
});

test("the viewer carries the restrictive CSP in the document and renders only read-only GET transports", async () => {
  const { html, script } = await assets();

  // The document-level CSP backstops the served header (both are asserted on
  // the wire in tests/viewer.test.mjs).
  assert.match(
    html,
    /default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'/,
  );
  assert.doesNotMatch(html, /<(?:form|input|textarea|select)\b/i);
  assert.doesNotMatch(html, /contenteditable/i);
  assert.doesNotMatch(script, /method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
  assert.doesNotMatch(script, /\b(?:WebSocket|sendBeacon)\b/);
  assert.match(script, /method: "GET"/);
  assert.match(script, /new EventSource\(/);
  assert.match(script, /\/viewer\/api\/rooms\/\$\{encodeURIComponent\(state\.broadcastRoomId\)\}\/events/);
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
  // Message bodies land in textContent exactly once, as data.
  assert.match(script, /body\.textContent = message\.text;/);
  assert.doesNotMatch(script, /localStorage|document\.cookie/);
});

test("no credential ever rides a URL: the viewer reads no token and builds no query string", async () => {
  const { script, html } = await assets();

  // The word the old v0.1 shell lived on is gone from the client entirely:
  // the credential is the HttpOnly cookie the browser attaches by itself.
  assert.doesNotMatch(script, /token/i);
  assert.doesNotMatch(script, /searchParams/i);
  assert.doesNotMatch(script, /location.search/i);
  assert.doesNotMatch(script, /\?token=|&token=/);
  assert.doesNotMatch(html, /\?token=|&token=/);
  // The boot fetch and the EventSource are bare same-origin paths.
  assert.match(script, /getJson\("\/viewer\/boot\.json"\)/);
});

test("the viewer follows one SSE stream carrying room and presence events", async () => {
  const { script } = await assets();

  assert.match(script, /addEventListener\("presence"/);
  assert.match(script, /addEventListener\("message"/);
  assert.match(script, /applyPresenceSnapshot\(/);
  assert.match(script, /offline_recently/);
  assert.match(script, /state\.messagesBySeq\.has\(seq\)/);
  assert.match(script, /state\.messagesBySeq\.set\(seq,/);
  assert.match(script, /\.sort\(\(left, right\) => left\.seq - right\.seq\)/);
});

test("viewer communicates the full FR-18 state set", async () => {
  const { html, script } = await assets();

  assert.match(html, /role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="notice"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(script, /kind === "error" \? "alert" : "status"/);
  for (const stateName of ["loading", "live", "empty", "reconnecting", "unreachable", "expired"]) {
    assert.match(script, new RegExp(`${stateName}: "`), `state label for ${stateName}`);
  }
  assert.match(script, /setConnectionState\("loading"\)/);
  assert.match(script, /setConnectionState\("live"\)|setConnectionState\(state\.messagesBySeq\.size === 0 \? "empty" : "live"\)/);
  assert.match(script, /setConnectionState\("reconnecting"\)/);
  assert.match(script, /setConnectionState\("unreachable"\)/);
  assert.match(script, /setConnectionState\("expired"\)/);
  assert.match(script, /showNotice\("empty"/);
  assert.match(script, /showNotice\("error"/);
});
