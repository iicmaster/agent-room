// The operator viewer command body (Story 5.1, HCI-5/AR-13): the `run*`
// function behind `agent-room viewer rotate`. This family extends the
// operator CLI HOST Story 4.2 established (review MED-1): the same
// `agent-room` bin, the same dispatch, the same JSON-lines grammar — never
// its own entrypoint.
//
// THE OPERATOR BOUNDARY IS THE HOST (AR-13): rotation runs on the server
// host and rewrites the 0600 `viewer-token` file in the shared data dir
// directly. No operator HTTP route exists; the server need not even be
// running. A running server picks the rotation up AT NEXT REQUEST because
// the viewer auth bridge re-reads the file per request (the same uncached
// discipline as the ban gate) — the old token refuses at its next mint and
// every outstanding viewer cookie is invalid at its next presentation.
//
// THE RECEIPT SHOWS THE NEW TOKEN exactly once, in this one line — the
// invite-mint pattern: the operator needs the current token to mint viewer
// cookies (`GET /viewer/auth` with `Authorization: Bearer <token>`), the
// file is 0600 on the operator's own host (the OS-user boundary already
// holds the secret), and nothing else — no listing, no log, no query string,
// no error — ever carries it. The receipt is stdout on the operator's own
// terminal, not a log.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { rotateViewerToken } from '../runtime.mjs'

const line = object => JSON.stringify(object)

function usage(command, message) {
  return { status: 'usage', command, code: 'usage', message }
}

// The current token, read back through the same validated reader discipline
// the runtime loaders use — the receipt's token is what the file now holds.
function currentToken(sharedDataDir) {
  const path = join(sharedDataDir, 'viewer-token')
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8').trim()
}

// The family's dispatch: the command name (`rotate`), the argv after it, the
// injected deps ({sharedDataDir}). Refusals and usage outcomes are returned,
// never printed here — the entrypoint's single JSON-error printer owns the
// stderr line and the exit code (usage → 2, refusal → 1).
export async function runViewerFamilyCommand(command, tokens, deps) {
  if (command !== 'rotate') {
    const attempted = ['viewer', command].filter(part => part !== undefined).join(' ')
    return usage(String(command ?? ''), `"${attempted}" is not a viewer command; viewer commands are: rotate`)
  }
  if (tokens.length > 0) {
    return usage('rotate', `unexpected argument "${tokens[0]}": agent-room viewer rotate takes no arguments`)
  }
  try {
    rotateViewerToken(deps.sharedDataDir)
  } catch (error) {
    return {
      status: 'refusal',
      command: 'viewer rotate',
      code: typeof error?.code === 'string' ? error.code : 'viewer_rotation_failed',
      message: error?.message ?? 'the viewer token could not be rotated',
    }
  }
  const token = currentToken(deps.sharedDataDir)
  return {
    status: 'ok',
    command: 'viewer rotate',
    lines: [line({
      ok: true,
      command: 'viewer rotate',
      viewer: {
        rotated: true,
        // Shown exactly once, in this one line (the invite-mint pattern):
        // present it as the Bearer credential to GET /viewer/auth to mint a
        // fresh viewer cookie. Every prior token and cookie is dead.
        token,
      },
    })],
  }
}
