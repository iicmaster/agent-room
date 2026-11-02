// Test-only child for a configured HTTPS wait. This process is spawned with
// NODE_EXTRA_CA_CERTS set BEFORE Node initializes TLS; it then calls the real
// CLI entrypoint, preserving default hostname/chain verification.
import { main } from '../server/cli/agent-room.mjs'

const chunks = []
const output = { write(value) { chunks.push(String(value)) } }
const errorChunks = []
const errorOutput = { write(value) { errorChunks.push(String(value)) } }

const outcome = await main(['wait', ...process.argv.slice(2)], {
  input: process.stdin,
  output,
  errorOutput,
  sharedDataDir: process.env.AGENT_ROOM_DATA_DIR,
  pluginDataDir: process.env.PLUGIN_DATA,
  env: process.env,
})
for (const line of chunks) process.stdout.write(line)
for (const line of errorChunks) process.stderr.write(line)
if (outcome.status === 'usage') process.exitCode = 2
else if (outcome.status === 'refusal') process.exitCode = 1
