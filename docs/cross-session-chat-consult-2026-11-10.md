# agent-room v0.8.0 — Cross-Session Chat: วินิจฉัย 4 lane + งานส่งต่อ

**วันที่:** 2026-11-10 · **Branch:** `agent-addressability-v0.8.0` · **Tag:** `v0.8.0` (commit `2e80db1`)
**Server:** ngs-2 `43.229.78.103:18444` (docker `agroom-rel1-64b-v080`) · **Client:** `~/.local/share/agent-room/releases/0.8.0`
**ผู้ถาม:** Master · **ผู้รวบรวม:** agent-room-zcode-1 (ZCode session บน Mac)

> ที่มาของเอกสารนี้: 4 advisory lanes (codex / agy / oc / claude) ตอบ brief เดียวกัน
> (`.tmux-teams/brief-cross-session-20261110.md` + `brief-claude-v2.md`)
> outbox ดิบทั้งสี่อยู่ใน `.mailbox-out/consult-cross-session-{codex,agy,oc,claude2}`
> เอกสารนี้ **ไม่หลอมรวม** verdict — ที่ขัดกันเก็บไว้ตามที่ lane พูด

---

## 1. ปัญหาที่ Master รายงาน (ถ้อยคำเดิม)

> "เรื่องมันควรจะง่าย
> 1) ระบุ server
> 2) ระบุ session name ของตัวเอง
> 3) ระบุ session name ของปลายทาง
> 4) ส่งข้อความ"

> "แล้วประเด็นเรื่องแย่งชื่อหล่ะ มันไม่ควรเกิด อย่างที่บอก บนเครื่องเดียวกันต่อให้มันพันเซสชั่นบน 10 harness มันก็ต้องคุยกันได้"

---

## 2. ข้อเท็จจริงที่ตรวจจาก source (ไม่ใช่ความเห็น)

### 2.1 Wire contract — frozen, NFR-8 additive only

`server/api/routes.mjs:72-74`

```js
POST /api/rooms/direct          requestFields: ['chat_id', 'target_fingerprint']   // ← มี target-by-name
GET  /api/rooms/:id/messages    requestFields: ['after_seq', 'limit', 'wait_ms']
POST /api/rooms/:id/messages    requestFields: ['chat_id','client_message_id','text','reply_to_seq']  // ← ไม่มี field ปลายทาง
```

**การส่งข้อความ = append ลงห้อง ไม่มีแนวคิด "ส่งถึงใคร"** ปลายทางถูก encode ใน `room_id`

### 2.2 ห้อง DM เป็นคู่ **fingerprint** ไม่ใช่คู่ chat id

`server/messaging/rooms.mjs:43-63` · `server/api/server.mjs:662` · `server/messaging/direct-room.mjs:7`

- `canonicalDirectPair(fp1, fp2)` → `pair_key` มี `UNIQUE` constraint
- `room_id` จริง = random base64url; `pair_key` ซ่อนจาก wire
- **ผลลัพธ์: ชื่อ A และชื่อ B ที่ใช้ key เดียวกัน → ห้องเดียวกัน**
- ✅ **ไม่มีการสร้าง DM ขยะ** — open ซ้ำคืนห้องเดิมแบบ idempotent 100% (agy/Winston, codex/Winston ยืนยันตรงกัน)

### 2.3 Identity ผูกกับ **directory** ไม่ใช่ session

`server/runtime.mjs:100-105`

```js
export function instanceDataDirectory(env, cwd) {
  const configured = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA
  return configured ? explicitAbsolutePath(...) : join(homedir(), '.agent-room','client-data','manual')
}
```

- `identity.key` (Ed25519) เก็บใน directory นั้น → **หนึ่ง directory = หนึ่ง fingerprint**
- ไม่มีมิติ session ในชั้นนี้เลย
- บนเครื่องนี้มี identity แค่ 2 ชุดใน `~/.agent-room/client-data/`: `manual`, `mcop-exec-secretary`
- ทุก session ที่รัน CLI จาก shell เปล่า (ไม่ตั้ง `PLUGIN_DATA`) = identity `manual` ตัวเดียวกันหมด

### 2.4 ชื่อถูกแย่ง — doctrine ที่ตั้งใจให้ชน

`server/core/session-registry.mjs:13`

> "live-name uniqueness among connected sessions … A live collision is refused with the canonical coded error (`chat_id_taken`): **never suffixed, never auto-mangled**"

`CHANGELOG.md:13` (v0.8.0)

> "**Per-session provisioning**: one independent session is one identity — its own `PLUGIN_DATA` directory, keypair, Chat ID, cursors, trust state and wake ledger."

**ทั้งสองประโยคขัดกันเองในทางปฏิบัติ:** v0.8.0 สัญญา "หนึ่ง session = หนึ่ง identity" แต่ `PLUGIN_DATA` มาจาก **env ของ host** ซึ่ง harness ตั้งเป็นค่าคงที่ต่อ plugin ไม่ใช่ต่อ session
→ **10 sessions บน harness เดียว = คีย์เดียว = ชื่อเดียว = ชนกันแบบ deterministic** ตาม doctrine

### 2.5 notifier/wait กรองด้วย **fingerprint** ไม่ใช่ชื่อ

`server/notification/notifier.mjs:313` · `server/cli/wait-commands.mjs:197`

- สองชื่อบน key เดียวกัน: อ่านด้วยมือได้ แต่ **ไม่ปลุกกันผ่าน notifier/wait**
- นี่คือกับดักของ shared-key case ที่ `--to` ต้องไม่สัญญาเกินจริง

### 2.6 CLI ไม่มีคำสั่งเปิด DM เลย

คำสั่งทั้งหมดจาก `agent-room help` (v0.8.0):

```
setup · held list|show · allow · allow-all · invite mint|list|revoke · ban · unban
capacity · viewer rotate · remote set|show|clear|enroll · session verify|replace
send --room <room_id> · read --room <room_id> · wait
```

→ ผู้ใช้ต้องถือ `room_id` (random base64url) ที่ไม่มีทางรู้ได้เอง เว้นแต่เรียก MCP `room_direct_open` ก่อน

### 2.7 สภาพแวดล้อมระหว่างทดสอบ 2 วัน (ตรวจสดบนเครื่อง)

- `mcp-stdio.mjs` 4 process โดย **2 ตัวอยู่ใต้ parent PID เดียวกัน** = host spawn ซ้ำจริงทุก restart
- `server/api/server.mjs` กำพร้า (PPID 1) ~50 ตัว ส่วนใหญ่จาก temp dirs ของ release smoke tests
- `agent-room-zcode-2` **offline ตั้งแต่ 2026-11-09 07:10** ไม่กลับมา
- `mcop-coo` แสดง online แต่ไม่ตอบ DM 3 ครั้ง (seq 3, 5, 6 ในห้อง `XkllS4oXsvL-jHH2MHv-5w`)

---

## 3. Verdict ของแต่ละ lane — วางเทียบ ไม่หลอมรวม

### 3.1 Identity ของ lane (receipt-verified)

| Lane | effective_identity | identity_status | Outbox |
|---|---|---|---|
| codex | `gpt-6.1-sol[ultra]` | matched | 38.1K |
| agy | `gemini-3.8-flash-high` | matched | 37.8K |
| oc | `opencode/deepseek-v4.1-flash-free` | matched | 36.2K |
| claude | `claude-fable-5` | matched | 4.8K (provisional — turn ended `mailbox_invalid`, ไม่มี `TEAM_DONE`) |

> ⚠️ **claude lane ไม่สมบูรณ์**: lane แรก (`consult-cross-session-claude`) จบเทิร์นโดยไม่เขียน outbox เลย (`no_outbox`, `receipt_digest: none` → resume ไม่ได้เพราะ lineage ไม่ใช่ sha256) lane ที่สอง (`claude2`) เขียนได้ 4.8K แต่ **จบด้วย `mailbox_invalid`** เพราะไม่มีบรรทัด `TEAM_DONE` และเนื้อหาเป็น "provisional" ไม่ใช่ round-table เต็ม — **ถือเป็นหลักฐานเสริม ไม่ใช่เสียงที่ 4 ที่เท่าเทียม**

### 3.2 Q1 — วินิจฉัย: (ก) API ผิด / (ข) ขาด CLI sugar / (ค) ไม่ใช่ปัญหาโค้ด

| Lane | คำตอบ | เหตุผลหลัก |
|---|---|---|
| **codex** (John) | **(ข) + ปัญหาฝั่งรับใน (ค)** | ไม่รับคำว่า "ไม่ใช่ปัญหาโค้ดเลย" — launcher, wake hook, การส่งเข้า native session ก็เป็นงานระบบ |
| **codex** (Winston) | ไม่รื้อ append-to-room | `POST /api/rooms/direct` มี target-by-name อยู่แล้ว = two-step ที่ใช้ได้ |
| **codex** (Sally) | **(ก) บางส่วน** | Master ขอ "ชื่อ **session** ปลายทาง" ไม่ใช่ "Actor แล้วส่งเข้าห้องที่ทุก session ของ Actor อ่านได้" — สัญญาการใช้งานไม่ตรงหน่วยที่ route ให้ |
| **agy** (Winston) | **(ข)** | ห้ามแตะ server; Room = boundary ของ seq/cursor/replay/access matrix |
| **agy** (Sally) | **(ข) + observability** | Abstraction inversion — user คิด "คุยกับคน" ระบบบังคับ "append ลงห้อง" |
| **agy** (Grumbal) | **(ค)** | ปลายทางตาย + host spawn ซ้ำ; "เสียเวลา 80% Yak Shaving" |
| **oc** (Vera) | **อย่าแตะ wire** | `POST /messages` เป็น log append และควรเป็นอย่างนั้น |
| **oc** (Tomas) | **(ก) เป็น debt** | named-send ควรเป็น primitive กลาง ไม่ใช่ให้ทุก client เขียนเอง |
| **oc** (Mara) | **(ค)** | "วันนี้คุยไม่ได้เพราะปลายทางไม่มีชีวิต ไม่ใช่เพราะ API" |
| **oc** (Rak) | **(ค)** | `online ≠ available` · `offline = ตาย` · replace ซ้ำ = กลบ lifecycle bug |
| **claude** | **(ค) หลัก + (ข) รอง** | identity ถูก key ผิดระดับ (ต่อ-directory ไม่ใช่ต่อ-session) + สภาพ process เละ |

**ไม่มีฉันทามติ** — ที่หนักที่สุดคือ (ค) นำ (ข) ตาม และ (ก) เป็นเสียงส่วนน้อยที่ codex/Sally กับ oc/Tomas ยกขึ้นมาแต่ไม่ชนะ

### 3.3 Q2 — เรื่องแย่งชื่อ (คำถามตรงของ Master)

| Lane | จุดยืน |
|---|---|
| **codex** (Winston) | v0.8.0 ระบุทางไว้แล้ว: หนึ่ง independent conversation ใช้ `PLUGIN_DATA`, key, Chat ID, trust, cursor ของตัวเอง · การเปลี่ยน alias หรือ copy `identity.key` **ไม่ได้สร้าง receiver ใหม่** |
| **codex** (Grumbal) | แก้ duplicate launcher **ที่ต้นเหตุ** ไม่ใช่ไล่ replace |
| **oc** (Mara) | **หนึ่ง identity = หนึ่ง process** guard · หยุดใช้ `session replace` เป็นกิจวัตร |
| **claude** | แก้ที่ **ชั้น identity-dir resolution + harness integration** ไม่ต้องแตะ doctrine `never suffixed` |

**จุดที่ทุก lane เห็นพ้อง (สำคัญที่สุดของเอกสารนี้):**

> ปัญหาการแย่งชื่อ **ไม่ใช่บั๊กของ agent-room** — เป็นผลจาก **harness ผูก `PLUGIN_DATA` ต่อ plugin ไม่ใช่ต่อ session** ขณะที่ agent-room ต้องการ "หนึ่ง session = หนึ่ง directory"

**แต่มีเงื่อนไขที่ต้องยอมรับ:** ถ้า agent-room ต้องการให้ผู้ใช้ทำ 4 ขั้นได้จริงบนเครื่องเดียว ระบบต้องมีทาง *สร้าง/provision* per-session directory ให้ง่ายพอ — ไม่ใช่ให้ผู้ใช้ไปตั้ง env เองแล้วจำ path เอง

### 3.4 Q3 — `--to` และ shared-key case

| Lane | ข้อเสนอ | คำเตือน |
|---|---|---|
| **codex** | `agent-room dm --to <chat> --text [: --fingerprint --id]` = unbound auth → direct-open → append | สอง request; open สำเร็จแต่ send ล้มเหลว = ห้องว่างเหลือ 1 ห้อง/คู่ Actor |
| **agy** (Winston) | CLI composition เท่านั้น ไม่แตะ server | ต้องจัดการ `404 chat_id_not_found`, `409 ambiguous_chat_id` (มี `--target-fingerprint`), foreign-body held |
| **agy** (Sally) | เพิ่ม `agent-room ping/inspect <chat-id>` | บอก Online/Offline/Unread ให้ชัด |
| **oc** (Dee) | `dm --to <chat-id>` ให้ receipt พา fingerprint + peer state | `accepted ≠ delivered` ต้องอยู่ใน **ข้อความ** ไม่ใช่แค่ในเอกสาร |
| **oc** (Vera) | composition ของ route ที่มีอยู่ | อย่าแตะ wire ถ้าไม่มีหลักฐานว่า composition ล้มจริง |
| **oc** (Tomas) | composition ได้ แต่ **บันทึกเป็น debt** | primitive กลาง name-addressed ควรมีระดับผลิตภัณฑ์ |
| **claude** | ทำได้ | receipt พูดแค่ `committed seq=N` + สถานะปลายทาง **ห้าม** delivered/read |

**กับดักที่ codex/Sally กับ claude ชี้ตรงกัน:** ใน shared-key case `--to` **ห้ามสัญญาว่า "ส่งเฉพาะ native session B"** เพราะห้องเป็นคู่ fingerprint และ notifier กรองด้วย fingerprint → ชื่อต่างกันบน key เดียวกันจะไม่ปลุกกัน

### 3.5 Q4 — วิจารณ์ 2 วันที่ผ่านมา

| Lane | คำตัดสิน | สัญญาณที่ควรอ่านออกตั้งแต่ต้น |
|---|---|---|
| **codex** (John) | "หยุดวนแก้ตัวส่งหลัง commit ผ่านแล้ว" | เกณฑ์ถัดไปคือ **สอง native sessions ตอบ nonce กันได้** |
| **codex** (Grumbal) | ยังไม่มีหลักฐานว่า agent-room ส่งไม่ถึง store | ถ้าไม่มีหลักฐานหลัง commit **ให้เขียน `unknown` ไม่เขียน `delivered`/`read`** |
| **agy** (Grumbal) | **"เสียเวลา 80% — Yak Shaving"** | `chat_id_taken` ซ้ำ → ดู process tree ชั่วโมงแรก |
| **agy** (Winston) | ตัด Server/Docker/Wire ออกจากสมมติฐานได้ตั้งแต่ seq 10-22 สำเร็จ | Transport success ≠ cognitive failure |
| **oc** (Rak) | "ภาษีที่จำเป็น แต่สายเกินไปที่จะเรียกว่าความคืบหน้า" | `online ≠ available` |
| **oc** (Mara) | เสียเวลาจริงตรงที่ทำให้ `session replace` เป็น routine | ต้องบอกตรง ๆ ว่า "ระบบพิสูจน์ได้แค่ commit ไม่ได้พิสูจน์การอ่าน" |
| **oc** (Tomas) | `room_id` ที่โผล่ใน workflow ผู้ใช้ = smell ตั้งแต่แรก | เป้าหมายเขียนด้วยชื่อ implementation บังคับด้วย id |
| **claude** | "ส่วนใหญ่เสียเวลา" | `chat_id_taken` ระหว่าง session ของตัวเอง = **identity ชนกัน ไม่ใช่ชื่อชนกัน** |

---

## 4. จุดที่ทั้ง 4 lane ตรงกัน (cross-vendor agreement — น้ำหนักสูงสุด)

1. **Wire contract ไม่ผิด** — room/seq/cursor architecture ถูกต้อง **ห้ามรื้อ**
2. **ขาด `--to <chat-id>` ที่ CLI** — ทุก lane บอกให้ทำ
3. **`online ≠ available`** — presence ไม่ได้แปลว่ามี model loop รับงาน
4. **ห้ามอ้าง `delivered`/`read`** ถ้าไม่มีหลักฐาน — เขียนแค่ `committed seq=N` (+ `unknown` เมื่อไม่รู้)
5. **การแย่งชื่อ = harness integration problem** ไม่ใช่บั๊ก agent-room — แต่ระบบต้อง provision per-session ให้ง่าย
6. **2 วันที่ผ่านมาเสียเวลาส่วนใหญ่** — สัญญาณที่ควรอ่านออกตั้งแต่ชั่วโมงแรกคือ `chat_id_taken` ซ้ำ

## 5. จุดที่ขัดกันจริง (เก็บไว้ ไม่แก้ให้เรียบ)

| ประเด็น | ฝ่าย A | ฝ่าย B |
|---|---|---|
| **name-addressed send** | Vera/agy-Winston: composition ที่ CLI พอ | Tomas: ต้องเป็น primitive กลางระดับผลิตภัณฑ์ (debt ที่ต้องบันทึก) |
| **read receipt ฝั่ง server** | oc/Vera: ห้าม — cursor เป็นของ client | oc/Tomas, agy/Winston: ต้องมี หรืออย่างน้อยต้องพูดให้ชัดว่าไม่รู้ |
| **"session addressability"** | codex/Winston: `--to` แก้พอ | codex/Sally: ชื่อ ≠ routing unit — สัญญาการใช้งานยังไม่ครบ |
| **หน่วยนับของปัญหา** | agy/oc: (ค) ปลายทางตาย | codex/John: (ข)+(ค) — launcher/wake hook ก็เป็นงานโค้ด |

---

## 6. งานส่งต่อ (สำหรับทีมถัดไป) — ยังไม่มีข้อใดถูกทำ

### 6.1 P0 — ปลดล็อก 4 ขั้นของ Master

- [ ] **`agent-room dm --to <chat-id> --text <text> [--fingerprint <sha256:…>] [--id <id>]`**
      = unbound auth → `POST /api/rooms/direct` → `POST /api/rooms/:id/messages`
      - ต้องจัดการ: `404 chat_id_not_found` · `409 ambiguous_chat_id` (ส่ง candidates + `--fingerprint`) · foreign-body held
      - receipt **ห้าม** พูด `delivered`/`read` — พูด `committed seq=N` + peer state (`online` / `last_seen` / `unknown`)
      - **ต้องแสดง warning ใน shared-key case**: ชื่อต่างกันบน fingerprint เดียวกันจะไม่ปลุกกันผ่าน notifier/wait
- [ ] **บันทึก debt**: primitive กลาง name-addressed send (Tomas) — ถ้าไม่ทำรอบนี้ ต้องมี issue ระบุไว้

### 6.2 P0 — หยุดการแย่งชื่อ

- [ ] **one-identity-one-process guard** (Mara): CLI ตรวจว่ามี process อื่นถือ `PLUGIN_DATA` เดียวกันอยู่แล้วหรือไม่ ก่อน bind
- [ ] **provision per-session ให้ง่าย**: คำสั่งที่สร้าง directory + key + chat-id ใหม่ในครั้งเดียว (ตอนนี้ต้องตั้ง `PLUGIN_DATA` env เอง)
- [ ] **harness integration doc**: ระบุตรง ๆ ว่า harness ต้องตั้ง `PLUGIN_DATA` ต่อ session ไม่ใช่ต่อ plugin — พร้อมตัวอย่างสำหรับ ZCode / Claude Code / Codex
- [ ] **ห้าม** ใช้ `session replace` เป็น routine (Mara/Rak) — ต้องเป็น operator action ที่มี guard
- [ ] แจ้ง host bug: ZCode spawn MCP ซ้ำ 2 process ต่อ restart (ตรวจแล้วบนเครื่องนี้)

### 6.3 P1 — ความสัตย์ของสถานะ

- [ ] **peer state ใน receipt** — `online` / `last_seen` / `never seen` / `unknown` (Sally: `ping`/`inspect`)
- [ ] ทบทวน `online ≠ available`: presence มี lease ≠ มี model loop (codex/Grumbal ยังไม่ยืนยันว่า `mcop-coo` ตายหรือแค่ไม่รับงาน)
- [ ] (ถ้าจะทำ) read receipt — **ต้องเป็น additive route ใหม่** (`GET /api/rooms/:id/peer-status` หรือ `POST /api/rooms/:id/ack`) ตาม NFR-8; Vera ค้าน, Tomas/Winston สนับสนุน — **ยังไม่ตัดสิน**

### 6.4 P1 — เกณฑ์พิสูจน์ว่า "คุยกันได้จริง"

ตาม codex/John: **สอง native sessions ตอบ nonce กันได้** คือเกณฑ์ ไม่ใช่ `seq` ที่ commit แล้ว

- [ ] ตั้ง `agent-room-zcode-2` กลับมา (หรือ session ปลายทางอื่นที่ตอบได้จริง)
- [ ] ทดสอบ round-trip: A ส่ง nonce → B ตอบ nonce ใน `reply_to_seq` → A ยืนยัน fingerprint ผู้ตอบ
- [ ] **ห้าม** นับ `committed` เป็นหลักฐานว่าสนทนาทำงาน

---

## 7. สิ่งที่ยังยืนยันไม่ได้ (ตามที่ lane เองระบุ)

- **codex**: ไม่ได้รันคิวรีตรงไปยัง SQLite ใน docker บน ngs-2
- **agy**: มองไม่เห็น config ภายในของ ZCode host ว่าทำไม spawn 2 process · ไม่เห็น process state ของ `mcop-coo` ว่ามี reasoning loop จริงหรือเป็น socket ค้าง
- **oc**: ไม่ได้ตรวจ wake path ฝั่งรับของ `mcop-coo`
- **claude**: lane ไม่จบสมบูรณ์ (`mailbox_invalid`) — หลักฐานที่มันตรวจเอง (identity 2 ชุด, ~50 daemon กำพร้า) ยืนยันได้บนเครื่องนี้ แต่ verdict ไม่ควรถูกนับเป็นเสียงที่ 4 เต็มน้ำหนัก

---

## 8. ภาคผนวก — ไฟล์ต้นทาง

| ไฟล์ | เนื้อหา |
|---|---|
| `.tmux-teams/brief-cross-session-20261110.md` | brief ที่ส่งให้ codex/agy/oc |
| `.tmux-teams/brief-claude-v2.md` | brief ที่ส่งให้ claude (write-first) |
| `.mailbox-out/consult-cross-session-codex` (38.1K) | round-table เต็ม |
| `.mailbox-out/consult-cross-session-agy` (37.8K) | round-table เต็ม |
| `.mailbox-out/consult-cross-session-oc` (36.2K) | round-table เต็ม |
| `.mailbox-out/consult-cross-session-claude2` (4.8K) | **provisional** — ไม่มี `TEAM_DONE` |
| `.tmux-teams/runner-logs/consult-cross-session-*.log` | lane logs + liveness |
| `.tmux-teams/receipts/*.json` | identity receipts |

**หมายเหตุ:** claude lane แรก (`consult-cross-session-claude`) ไม่มี outbox — `receipt_digest: none` ทำให้ resume ถูกปฏิเสธ (`required ACP session/load needs an ACP_PRIOR_RECEIPT_DIGEST sha256 digest`) ต้อง dispatch ใหม่เป็น `claude2`
