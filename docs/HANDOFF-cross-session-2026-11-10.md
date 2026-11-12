# HANDOFF — cross-session chat บน agent-room v0.8.0

**วันที่:** 2026-11-10 · **สถานะ:** ยังคุยข้าม session ไม่สำเร็จ · **เจ้าของงาน:** ทีมถัดไป

---

## อ่านอะไรก่อน

1. **[`docs/cross-session-chat-consult-2026-11-10.md`](docs/cross-session-chat-consult-2026-11-10.md)** — วินิจฉัยครบจาก 4 advisory lanes + หลักฐานจาก source + งานส่งต่อ P0/P1
2. `.mailbox-out/consult-cross-session-{codex,agy,oc,claude2}` — round-table ดิบ (ไม่ตัดต่อ)

## ปัญหาในหนึ่งย่อหน้า

Master ขอ 4 ขั้น: **ระบุ server → ชื่อตัวเอง → ชื่อปลายทาง → ส่ง** ระบบทำได้แค่ขั้น 1, 2, 4 — **ขั้น 3 ไม่มีที่ให้ใส่** เพราะ `POST /api/rooms/:id/messages` รับแค่ `chat_id` (ผู้ส่ง) ไม่มี field ปลายทาง และ CLI ไม่มีคำสั่งเปิด DM เลย ทำให้ผู้ใช้ต้องถือ `room_id` (random base64url) ที่ไม่มีทางรู้เองได้ เว้นแต่เรียก MCP `room_direct_open` ก่อน

พร้อมกันนั้น **การแย่งชื่อ** ที่ Master เห็นว่าไม่ควรเกิด — เกิดเพราะ `PLUGIN_DATA` มาจาก env ของ host (ต่อ plugin ไม่ใช่ต่อ session) ขณะที่ agent-room ต้องการ "หนึ่ง session = หนึ่ง directory" → หลาย session บน harness เดียวได้คีย์เดียว ชื่อเดียว ชนกันตาม doctrine `never suffixed`

## ข้อห้ามก่อนเริ่ม (ทุก lane ตรงกัน)

- ❌ **ห้ามรื้อ wire contract** — room/seq/cursor architecture ถูกต้องแล้ว (`routes.mjs` frozen, NFR-8 additive only)
- ❌ **ห้ามอ้าง `delivered`/`read`** ถ้าไม่มีหลักฐาน — เขียนแค่ `committed seq=N` และ `unknown` เมื่อไม่รู้
- ❌ **ห้ามใช้ `session replace` เป็น routine** — เป็น operator action ที่ต้องมี guard
- ❌ **ห้ามนับ `committed` เป็นหลักฐานว่าสนทนาทำงาน** — เกณฑ์จริงคือสอง native sessions ตอบ nonce กันได้

## งานแรกที่ต้องทำ (P0)

- [ ] `agent-room dm --to <chat-id> --text <text>` = composition ของ route ที่มีอยู่ (ไม่แตะ server)
- [ ] one-identity-one-process guard + คำสั่ง provision per-session ที่ไม่ต้องตั้ง env เอง
- [ ] เอกสาร harness integration: `PLUGIN_DATA` ต้องต่อ session ไม่ใช่ต่อ plugin

## สถานะแวดล้อม ณ วันส่งต่อ

| ของ | สถานะ |
|---|---|
| Server ngs-2 `:18444` | v0.8.0 (docker `agroom-rel1-64b-v080`) — ทำงานปกติ |
| Client (เครื่องนี้) | v0.8.0 ที่ `~/.local/share/agent-room/releases/0.8.0` |
| `agent-room-zcode-1` | online, bind ได้, ส่ง/อ่านได้ |
| `agent-room-zcode-2` | **offline ตั้งแต่ 2026-11-09 07:10** — ไม่กลับมา |
| `mcop-coo` | online ใน presence แต่ไม่ตอบ DM 3 ครั้ง — `online ≠ available` |
| ZCode host | spawn MCP ซ้ำ 2 process ต่อ restart (bug ของ host ไม่ใช่ agent-room) |
| ซาก process | `server/api/server.mjs` กำพร้า ~50 ตัวจาก smoke tests |

## สิ่งที่ทดสอบผ่านแล้ว (อย่าทำซ้ำ)

- MCP tools ครบ 10 ตัวบน v0.8.0 · CLI `send` unbound (seq 18 ตอนชื่อถูกถือ, 19 หลังปลด) · `read` (`cursor_written:false`) · `wait` · `session verify` · notifier `inbox.jsonl` (`started` ×8, `unread_backlog` ×18)
- ลูปข้าม identity สำเร็จ (broadcast seq 10-22, DM seq 3-6) — **transport ทำงาน, ปัญหาอยู่ที่ปลายทาง/UX**

## กับดักที่รู้แล้ว

- `room_id` เป็น random base64url — `pair_key` (`direct:sha256:…:sha256:…`) เป็นของภายใน ไม่เคยออกมาบน wire
- ห้อง DM = คู่ **fingerprint** → ชื่อต่างกันบน key เดียวกัน **อยู่ห้องเดียวกัน** และ **ไม่ปลุกกันผ่าน notifier** (กรองด้วย fingerprint)
- `agent-room allow` / `held list` บน installation แบบ remote mode จัดการ **realm ท้องถิ่น** ไม่ใช่ realm จริง — ใช้ MCP `room_trust_set` แทน
- trust matrix บังคับที่ **MCP adapter เท่านั้น** — raw api-client script เห็น body เลย
- `package-release.mjs --out X` สร้าง 3 อย่าง: `X/agent-room-claude-code/`, `X/agent-room-agent-plugin/`, `X/server/` — **เฉพาะ `X/server/` ที่สมบูรณ์**
