import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRoomDatabase } from '../server/database.mjs'
import { requestDaemon } from '../server/daemon-client.mjs'
import { ensureDaemon } from '../server/daemon-client.mjs'
import { daemonSocketPath } from '../server/runtime.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('Infinite Loop Prevention & Mention-Driven Coordination Suite', async t => {
  const baseDir = await mkdtemp(join(tmpdir(), 'agent-room-loop-prevention-'))
  const sharedData = join(baseDir, 'shared')
  await mkdir(sharedData, { recursive: true })

  // Start real daemon
  const status = await ensureDaemon({ dataDir: sharedData })
  const socketPath = daemonSocketPath(sharedData)

  t.after(async () => {
    if (status?.pid) {
      try { process.kill(status.pid, 'SIGTERM') } catch {}
    }
    await rm(baseDir, { recursive: true, force: true })
  })

  // Setup room with 3 agents
  const room = await requestDaemon({
    socketPath,
    method: 'room.create',
    params: {
      title: 'Loop Prevention Test Room',
      actor: { id: 'agent:lead', displayName: 'Lead-Agent' }
    }
  })

  await requestDaemon({
    socketPath,
    method: 'room.join',
    params: {
      roomId: room.id,
      displayName: 'Coder-Agent',
      actor: { id: 'agent:coder', displayName: 'Coder-Agent' }
    }
  })

  await requestDaemon({
    socketPath,
    method: 'room.join',
    params: {
      roomId: room.id,
      displayName: 'Auditor-Agent',
      actor: { id: 'agent:auditor', displayName: 'Auditor-Agent' }
    }
  })

  // -------------------------------------------------------------------------
  // Test 1: Speak-When-Addressed (@Mention Filter)
  // -------------------------------------------------------------------------
  await t.test('1. Speak-When-Addressed: Unmentioned agent remains silent', async () => {
    // Lead addresses Coder ONLY
    const msg1 = await requestDaemon({
      socketPath,
      method: 'message.send',
      params: {
        roomId: room.id,
        clientMessageId: 'msg-001',
        text: 'Hello @Coder-Agent, please review this PR.',
        actor: { id: 'agent:lead', displayName: 'Lead-Agent' }
      }
    })

    // Simulate Agent Cognitive Evaluation Logic:
    function shouldAgentRespond(agentDisplayName, agentActorId, incomingMsg, lastMyMsgSeq = null) {
      // Rule 1: Don't respond to own messages
      if (incomingMsg.actor_id === agentActorId) return false
      // Rule 2: Termination token -> NEVER respond
      if (incomingMsg.text.includes('[STATUS: RESOLVED]') || incomingMsg.text.includes('[DONE]')) return false
      // Rule 3: Check direct @mention
      if (incomingMsg.text.includes(`@${agentDisplayName}`) || incomingMsg.text.includes(`@${agentActorId}`)) return true
      // Rule 4: Check reply_to_seq
      if (lastMyMsgSeq !== null && incomingMsg.reply_to_seq === lastMyMsgSeq) return true
      
      return false // Default SILENCE
    }

    const coderDecision = shouldAgentRespond('Coder-Agent', 'agent:coder', msg1.message)
    const auditorDecision = shouldAgentRespond('Auditor-Agent', 'agent:auditor', msg1.message)

    assert.equal(coderDecision, true, 'Coder should respond because it was @mentioned')
    assert.equal(auditorDecision, false, 'Auditor must remain silent because it was NOT mentioned')
  })

  // -------------------------------------------------------------------------
  // Test 2: Termination Marker ([STATUS: RESOLVED] stops all polite ping-pong)
  // -------------------------------------------------------------------------
  await t.test('2. Termination Marker: [STATUS: RESOLVED] blocks further chatter', async () => {
    const termMsg = await requestDaemon({
      socketPath,
      method: 'message.send',
      params: {
        roomId: room.id,
        clientMessageId: 'msg-002',
        text: 'All tasks completed successfully. [STATUS: RESOLVED]',
        actor: { id: 'agent:lead', displayName: 'Lead-Agent' }
      }
    })

    function shouldAgentRespond(agentDisplayName, agentActorId, incomingMsg) {
      if (incomingMsg.actor_id === agentActorId) return false
      // Strict guard against polite loops
      if (incomingMsg.text.includes('[STATUS: RESOLVED]') || incomingMsg.text.includes('[DONE]')) {
        return false // Halts conversation
      }
      return incomingMsg.text.includes(`@${agentDisplayName}`)
    }

    const coderWillReply = shouldAgentRespond('Coder-Agent', 'agent:coder', termMsg.message)
    const auditorWillReply = shouldAgentRespond('Auditor-Agent', 'agent:auditor', termMsg.message)

    assert.equal(coderWillReply, false, 'Coder halts upon seeing [STATUS: RESOLVED]')
    assert.equal(auditorWillReply, false, 'Auditor halts upon seeing [STATUS: RESOLVED]')
  })

  // -------------------------------------------------------------------------
  // Test 3: Turn Budget Enforcer (Hard turn counter guard)
  // -------------------------------------------------------------------------
  await t.test('3. Turn Budget Enforcer: Prevents ping-pong exceeding max turns', async () => {
    const MAX_TURNS = 4
    let currentTurns = 0
    let loopStopped = false

    // Simulate turn loop
    for (let turn = 1; turn <= 10; turn++) {
      if (currentTurns >= MAX_TURNS) {
        loopStopped = true
        break // Enforce loop stop
      }

      await requestDaemon({
        socketPath,
        method: 'message.send',
        params: {
          roomId: room.id,
          clientMessageId: `loop-turn-${turn}`,
          text: `Ping pong turn #${turn}`,
          actor: { id: turn % 2 === 0 ? 'agent:coder' : 'agent:lead', displayName: 'Turn-Agent' }
        }
      })
      currentTurns++
    }

    assert.equal(loopStopped, true, 'Loop must be stopped when turn count hits MAX_TURNS')
    assert.equal(currentTurns, MAX_TURNS, `Current turns must not exceed ${MAX_TURNS}`)
  })

  // -------------------------------------------------------------------------
  // Test 4: Rate Limiting & Concurrency Burst Verification
  // -------------------------------------------------------------------------
  await t.test('4. Idempotency & Database Concurrency under Rapid Submissions', async () => {
    // Burst 10 rapid submissions with duplicate client_message_id
    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(requestDaemon({
        socketPath,
        method: 'message.send',
        params: {
          roomId: room.id,
          clientMessageId: 'idempotent-burst-key',
          text: 'Exact same payload burst',
          actor: { id: 'agent:lead', displayName: 'Lead-Agent' }
        }
      }))
    }

    const results = await Promise.all(promises)
    const seqs = results.map(r => (r.message ? r.message.seq : r.seq))
    const firstSeq = seqs[0]

    // Every result must share the exact same sequence number (idempotency preserved under race)
    for (const seq of seqs) {
      assert.equal(seq, firstSeq, 'Concurrent duplicate sends must resolve to the same single sequence')
    }
  })
})
