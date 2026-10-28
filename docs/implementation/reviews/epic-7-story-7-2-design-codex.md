REFINE — ห้าม freeze ร่างตามข้อความเดิม: ข้อ 5 อ้างว่า plain bind ไม่ bind ซึ่งขัดกับโค้ด และข้อ 7 ที่ทดสอบเพียง replay ยังไม่พิสูจน์ A6

Task: story-7-2-design-codex
Dispatch: 2026-10-29
Reviewed HEAD: 139d47ecc5896b15fa03adfb254e18cc0524ff0c
Mode: READ-ONLY advisory; sole authorized write is this flat outbox.
สถานะ: 7.4 ปลด design hold แล้ว; รายงานนี้เป็นคำวินิจฉัยดีไซน์ ไม่ใช่ implementation acceptance หรือ release approval

📋 **John — PM:** “ลำดับงานจบแล้ว Winston อย่ายก A2 มา hold ซ้ำ คำตัดสินเดิมของผมคือ 7.4 ต้องจบก่อน freeze wire ของ 7.2 ไม่ได้บังคับให้สร้าง automatic recovery และบัดนี้มี recorded refusal แล้ว เราต้องเปลี่ยน last-explicit-intent-wins จริง โดยไม่มี compatibility path ที่ยัง takeover แบบไม่มี observation”
หลักฐาน: docs/implementation/reviews/epic-7-design-gate-codex.md:40–44,120; docs/epics.md:632,658,678; docs/implementation/spec-7-4-the-automatic-recovery-design.md:25–32.

🎨 **Sally — UX:** “John ฉันเห็นด้วยว่า hold จบ แต่ confirmation ปัจจุบันเกิดก่อน authenticate และก่อนเห็น conflict คนตอบกำลังอนุญาตให้ไล่ใครก็ตามที่ถือชื่อในอนาคต เราต้องให้คำตอบ y อ้างถึง observation เดิมจริง”
หลักฐานปัจจุบัน: server/cli/session-commands.mjs:234–257.

🏗️ **Winston — Architecture:** “ขอบเขตของวันนี้คือเลือกสัญญาที่ implement ได้อย่างตรงไปตรงมา ผมตรวจ source ปัจจุบันร่วมกับ review เก่าแล้ว: bindSession อ่าน holder ปัจจุบันที่ server/api/server.mjs:542 แล้วใช้ key นั้นเป็น incumbent ที่ :553; ไม่มี observation จากจังหวะก่อน prompt นี่คือ root ของ A6 ส่วนผลทดลองใน Epic 6 เป็นผลที่เอกสารบันทึกไว้ เราไม่ได้ reproduce วันนี้”
A6 และ deliverables: docs/implementation/epic-6-retro-2026-10-21.md:261; docs/epics.md:658. Finding/test analysis เดิม: docs/implementation/reviews/epic-6-release-gate-codex.md:48,57.

🔒 **Vex — Security:** “และ confidentiality เป็นข้อบังคับแล้ว ไม่ใช่คำแนะนำ ใครชนชื่อของ foreign Actor ต้องได้ bare chat_id_taken เท่านั้น ห้ามได้ ticket, generation, fingerprint, session key หรือเหตุผลย่อยที่เปิดเผย holder”
หลักฐาน: docs/implementation/reviews/epic-7-design-gate-agy.md:44,59; docs/epics.md:658.

รอบแรก — ticket และ occupancy

**1. Ticket form — REFINE; รับ memory-only และ opaque random id**

🏗️ **Winston:** “รับ randomBytes(32).toString('base64url'): canonical 43 ตัวอักษร ไม่ใช่ encoding ของ incumbent bearer/digest เก็บ record ฝั่ง server เป็น actorFingerprint, normalizedChatId, incumbentSessionKey, observedGeneration และ monotonic deadline; issuedAt จะเก็บด้วยได้เมื่อใช้คำนวณ deadline ภายในเท่านั้น ตอน mint ต้องหลีกเลี่ยงการ overwrite id ที่มีอยู่ แม้ random collision จะหายาก”

🔒 **Vex:** “internal incumbentSessionKey เป็น digest ที่ระบบมีอยู่ได้ แต่ห้ามส่งมันเป็น ticket หรือ metadata ออก wire Ticket เป็น observation reference ไม่ใช่ credential และต้อง consume แบบที่ข้อ 6 ระบุ คำว่า single-use อย่างเดียวไม่ได้ตัดสินว่า persist failure หรือ wrong Actor จะ burn เมื่อใด”

📋 **John:** “ผมรับ memory แทน durable: live occupancy กับ auth sessions ล้างตอน restart อยู่แล้ว persist ticket อย่างเดียวจะเหลือ observation ที่ registry ลืม ต้องเพิ่ม epoch/schema/reconciliation ทั้งที่ไม่มี requirement ให้ redeem ข้าม restart เราไม่ได้แก้ A2 ด้วย resume storage อีกทางหนึ่ง”
หลักฐาน: Architecture Spine AD-6 ที่ docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:75–79; server/api/session.mjs:58–59; server/core/session-registry.mjs:157–161. Restart หรือ server-instance reset ต้องล้าง ticket store ด้วย; ticket เก่าหลัง authenticate ใหม่ตอบ conflict_stale ห้ามคืนชีพจาก disk

**2. Issuance — REFINE; authenticate + same-Actor เท่านั้น และตัด observed_generation ออกจาก wire**

🔒 **Vex:** “ออก conflict_ticket เฉพาะ plain POST ที่เกิด collision กับ incumbent ของ Actor เดียวกัน หลังผ่าน auth/budget/authz และหลังประเมิน occupancy ที่ใช้ตัดสินจริง ค่า actorFingerprint มาจาก principal; normalize Chat ID ด้วย helper เดียวกับ registry ไม่รับ Actor หรือ observed incumbent จาก body Foreign collision หยุดด้วย envelope เดิมก่อน ticket lookup/mint/capacity accounting จึงไม่มี ticket oracle เมื่อ map เต็มด้วย”

🏗️ **Winston:** “ผมเสนอคืนเพียง error.conflict_ticket ไม่คืน observed_generation: client ไม่มีหน้าที่ compare generation และ takeover ไม่ต้อง echo generation เพราะ server-side record ผูกครบอยู่แล้ว ถ้าใช้ global generation allocator ตามข้อ 3 แล้วส่ง serial ออก wire ช่องว่างของเลขอาจเผย aggregate activity ของชื่ออื่น นี่เป็นข้ออนุมานจากดีไซน์ ไม่ใช่ exploit ที่ทดลองแล้ว การไม่ส่งเลขลดทั้ง field และช่องข้อมูลที่ไม่จำเป็น”

🔒 **Vex:** “รับการตัดเลขออก เดิมร่างเปิด metadata ที่ไม่มี caller ใช้ อย่าเพิ่มมันเพียงเพราะ server เก็บอยู่ หากยืนยันจะเก็บ observed_generation เป็น public field ต้อง amend response/extras vocabulary และเลือก representation ที่ไม่เผย global counter; ไม่มีเหตุให้เพิ่มงานนั้นใน story นี้”

📋 **John:** “คำว่า ‘any 409 gains a ticket’ ต้อง refine เรื่อง capacity: same-Actor collision ที่มีที่ว่างตอบ 409 พร้อม ticket; เมื่อรับ ticket เพิ่มไม่ได้ ให้ refuse issuance ด้วย rate_limited 429 อย่างชัดเจน อย่าแกล้งส่ง bare same-Actor 409 ที่ CLI ใช้งานต่อไม่ได้ และอย่า evict observation ของ operator คนก่อน”

wire ที่เสนอเมื่อมีที่ว่าง:
{ok:false,error:{code:"chat_id_taken",message:<canonical message>,conflict_ticket:"<opaque id>"}}
foreign collision:
{ok:false,error:{code:"chat_id_taken",message:<same canonical message>}}
ไม่มี field อื่นของ incumbent ทั้งสองกรณี; unauthenticated ไม่เข้าทั้งสอง branch และไม่ได้ ticket

**3. Occupancy identity — REFINE; compare คู่ (sessionKey, generation) ทุก takeover path**

🏗️ **Winston:** “generation จำเป็นสำหรับ A→free→A ที่ใช้ session key เดิม แต่ ‘bump ทุก claim’ กว้างเกินไป: idempotent rebind ชื่อเดิม/key เดิม, display-case refresh และ heartbeat/touch ไม่ใช่ occupancy ใหม่ อย่าทำให้ operator stale เพราะ incumbent ส่ง heartbeat”

🔒 **Vex:** “จุดต้องปิดอยู่ใน lower registry ด้วย guard ปัจจุบันตรวจ expected key เฉพาะ holder มีอยู่และไม่ใช่ claimant ที่ server/core/session-registry.mjs:220–237 ถ้าชื่อว่างจะไหลไป claim ที่ :252–277; ถ้า holder เป็น claimant จะเข้า self path ที่ :239–249 ดังนั้นแค่เติม generation ใน occupied-other branch ยังผิด”

🏗️ **Winston:** “ใช้ process-lifetime monotonic BigInt allocator ภายใน แล้วประทับ generation บน live occupancy ใหม่แต่ละครั้ง พอ release ชื่อหาย; claim กลับได้ generation ใหม่เสมอ แม้ key เดิม Rename ออกจากชื่อ, transfer, explicit release และ lease-expiry removal ล้วนยุติ occupancy เดิม ใช้ sequence เดียวสำหรับ effective transition ได้ โดยไม่เก็บ per-chat tombstone ของทุกชื่อที่เคยใช้ตลอดกาล release จะ advance sequence แม้ไม่มี live row ให้เก็บผลก็ได้; same-occupancy refresh ไม่ advance”

📋 **John:** “นี่เป็น refinement จาก per-chat counter ตามถ้อยคำเดิม แต่ให้แต่ละชื่อได้ monotonic labels โดยไม่เพิ่ม unbounded map ผมรับ ต้องไม่ reset allocator ขณะที่ ticket ใดใน server epoch เดิมยัง valid; clear/restart ต้อง invalidate ticket ทั้งหมดร่วมกัน”

🔒 **Vex:** “ที่ execution หลัง normalize/lease evaluation ให้ตรวจทั้ง current holder key และ generation เทียบกับ record ก่อน persist ไม่ว่า current จะเป็นคนอื่น, ตัว claimant เอง หรือไม่มี holder ถ้า pair ไม่ตรงให้ conflict_stale ไม่ fallback เป็น ordinary claim แม้ชื่อเพิ่งว่าง การลบชื่อใน DELETE ยังไม่ revoke bearer จึง rebind ด้วย key เดิมได้จริงจาก source”
หลักฐาน: server/api/server.mjs:620–631; registry sweep :172–183, transfer :292–303, release :333–339.
การเปรียบเทียบต้องใช้ live lease semantics เดียวกับ commit; ห้าม mint จาก row ที่ sweep จะลบทันที แล้วอ้างว่าเป็น current observation ที่ redeem ได้

รอบสอง — wire และ confirmation

**4. Wire — PASS ในหลัก; REFINE grammar, envelope และ precedence ให้ครบ**

🏗️ **Winston:** “รับ replace_existing:true + conflict_ticket เป็นสัญญาใหม่ Missing/null/empty/wrong-type/malformed ticket เมื่อขอ replace ให้ invalid_request 400 ก่อน ownership mutation; canonical well-formed แต่ unknown, expired, consumed หรือ pair ไม่ตรงให้ conflict_stale 409 พร้อม canonical message เช่น 'conflict observation is stale; observe again and confirm before replacing' ไม่ต้องแยก expired/used/mismatch เป็น code เพิ่ม”

🔒 **Vex:** “ticket ที่ผูก Actor หรือ normalized name ไม่ตรงก็ uniform conflict_stale ห้ามเปิด record ย่อย และห้าม burn ของเจ้าของ ส่วน target ที่ current holder เป็น foreign Actor ต้องรักษา bare chat_id_taken สำหรับ request ที่ผ่าน grammar แล้ว ไม่มี extras แม้ caller แนบ ticket ที่ขโมยมาหรือ map เต็ม Shape error ยังเป็น 400; no auth ยังเป็น 401 ตาม stage order ไม่ต้องเปลี่ยนทุก malformed request ให้ 409”

🏗️ **Winston:** “ticket ที่ส่งโดยไม่มี replace_existing:true ให้ invalid_request เพื่อไม่ให้มี intent แฝง Ordinary bind ที่ไม่มี ticket และไม่มี intent ใช้ได้เหมือนเดิม PATCH/DELETE ไม่รับ ticket หรือ intent; คง unknown_field ตาม allowlist อย่าเปลี่ยน null/false handling ของ replace_existing ใน ordinary bind โดยไม่จำเป็น Missing-ticket rule ใช้กับ true เท่านั้น”

ต้อง amend พร้อม story:
- server/constants.mjs: PUBLIC_ERRORS และชื่อจริงของ status table คือ PUBLIC_ERROR_STATUS (เอกพจน์ ไม่ใช่ PUBLIC_ERRORS_STATUS) เพิ่ม conflict_stale:409; named TTL/cap constants อยู่ที่เดียวตาม AD-9
- server/api/routes.mjs: POST requestFields + REQUEST_FIELD_VOCABULARY เพิ่ม conflict_ticket; RESPONSE_FIELD_VOCABULARY เพิ่ม conflict_ticket สำหรับ error extras ไม่มี observed_generation ตาม refinement นี้
- server/api/pipeline.mjs: ERROR_ENVELOPE_EXTRAS เพิ่ม chat_id_taken:['conflict_ticket']; ใช้ reject(code,message,extras) และ errorEnvelope เดิม ห้าม spread extras ไม่จำกัด และห้ามแค่โยน Error พร้อม property ticket เพราะ catch ปัจจุบันสร้าง reject ใหม่จาก code/message เท่านั้น
- Architecture Spine AD-6/AD-8/AD-9, confirmation-flow spec, README และ CHANGELOG พร้อมการเปลี่ยนพฤติกรรม; อัปเดต existing contract tests เรื่อง allowlist, exact envelopes และ status-table parity หากเลือก observe-only ตามข้อ 5 ต้องประกาศ field/result grammar นั้นใน amendment เดียวกันด้วย

หลักฐาน: pipeline :48–59,74–109,130–138,681–683; constants :226–234,341–346; routes :37–39,146–168; tests/api-contract.test.mjs:121–160,286–291,339–344.
ไม่เพิ่ม SEND_STATUSES, ไม่เปลี่ยนชื่อเดิมหรือ pipeline order และไม่เพิ่ม error code สำหรับ capacity เพราะมี rate_limited + retry_after_ms อยู่แล้ว

📋 **John:** “อย่าเรียกการ require ticket ว่า backward compatible กับ old explicit-replace clients: มันจงใจทำให้ replace=true แบบเดิมถูกปฏิเสธ A6 อนุมัติการเปลี่ยนนี้ ห้ามเก็บ last-wins fallback ไว้ ส่วนวลี frozen vocabularies gain nothing ใน Spine เป็นข้อบันทึกของ amendment บาง story ไม่ได้ทำให้ AD-8 ที่อนุญาต additive amendments หายไป ถึงอย่างนั้น 7.2 ต้องระบุการเพิ่ม vocabulary และเปลี่ยน semantics ของ intent ให้ชัด A1 บังคับ packaged docs ลงพร้อม story”
หลักฐาน: Spine AD-8 :109–126; docs/implementation/reviews/epic-7-design-gate-codex.md:120; docs/epics.md:630,658.

**5. CLI — REFUSE ตามร่าง; ต้องแก้ premise ของ observation**

🎨 **Sally:** “John plain POST ไม่ใช่ observation ที่ binds nothing: เมื่อชื่อว่างมัน claim และเขียน durable claim เมื่อเจอ dead same-Actor token มันอาจ release holder แล้ว reclaim ก่อนฉันตอบ y ด้วย DELETE ทีหลังไม่ลบ durable claim และถ้า cleanup ล้มเหลว CLI อาจทิ้งชื่อไว้จน lease หมด นี่ไม่ใช่แค่คำไม่สวย”
หลักฐาน: server/api/server.mjs:554–591,620–626; server/core/session-registry.mjs:239–257.

📋 **John:** “ผมเลือกทางเล็กกว่า: fresh dedicated CLI session → plain POST หนึ่งครั้ง ถ้า 409+ticket จึง prompt; foreign bare 409 จบทันที ถ้า 200 ให้ DELETE เฉพาะ CLI session ของตัวเองทันที รายงาน replaced:false และ released ตามผลจริง ไม่ prompt takeover อีก ยอมรับ footprint นี้อย่างเปิดเผย แล้วหยุดอ้างว่า observation ไม่ bind มันแก้ A6 ได้โดยไม่เพิ่ม field สังเกตชื่อ”

🎨 **Sally:** “ฉันยังไม่อนุมัติทางนั้นสำหรับ requirement binds nothing การออก ticket มี state ของมันเองได้ แต่ต้องไม่ claim/release incumbent หรือสร้าง durable claim เพื่อถามคำถาม เราควรมี authenticated observe-only mode และจ่ายราคา amendment เพิ่มอย่างตรงไปตรงมา”

🏗️ **Winston:** “ผมแนะนำทาง Sally เพื่อรักษา observation semantics ที่ร่างระบุ: เพิ่ม observe_only:true บน POST /api/session ใน Spine amendment นี้อย่างชัดแจ้ง ไม่เพิ่ม service/endpoint แยก และไม่ pretend ว่าโค้ดเดิมทำได้ Grammar: observe_only เป็น strict boolean; true ห้ามใช้กับ replace_existing:true หรือ conflict_ticket; PATCH/DELETE ไม่รับมัน Fresh CLI bearer ยัง unbound ระหว่าง preflight”

flow ที่เสนอสำหรับ observe-only:
1. Authenticate installation ให้ได้ Actor session bearer ที่ยังไม่ bind แล้วส่ง POST {chat_id,observe_only:true} โดยไม่มี replacement intent
2. live same-Actor holder → 409+ticket; foreign holder → bare 409 แล้วจบ; free/self target → 200 {chat_id:<validated display>,replaced:false} ไม่มี ticket ไม่อ้าง timestamp ของ session ที่ไม่ได้ bind และจบโดยไม่ takeover prompt โหมดนี้ไม่ claim, release หรือ refresh incumbent; ประเมิน effective holder ตาม lease/clock เดียวกับ registry ด้วย read-only view ไม่เรียก sweep ที่ลบ row
3. เฉพาะ 409+ticket จึงถาม y/N ว่า “แทน occupancy ที่สังเกตไว้; ถ้าเปลี่ยนหรือหมดอายุจะปฏิเสธ” เก็บ ticket ในหน่วยความจำคำสั่งนี้ ไม่พิมพ์ stdout/stderr/log
4. y ส่ง POST {chat_id,client_type:"cli",replace_existing:true,conflict_ticket:<ใบเดิม>} หนึ่งครั้ง แล้ว DELETE เฉพาะ CLI session ที่ takeover สำเร็จตาม flow เดิม; รายงาน released ตามผลจริง คำตอบ n/EOF/interrupt ไม่ส่ง intent; ticket หมดอายุเองโดยไม่มี cancel endpoint

🏗️ **Winston:** “free/self 200 ข้างบนเป็น result variant ที่เสนอใหม่ ต้อง ratify/document/test ด้วย ไม่ใช่ current API fact Reuse chat_id/replaced ที่มีแล้ว ไม่สร้าง observation timestamp ปลอม หลังตรวจ preflight แล้วชื่อเปลี่ยนก่อนจบก็ให้รายงานว่าไม่มี incumbent ณ observation ไม่อ้างว่าชื่อยังว่างแน่นอนตอน receipt”

📋 **John:** “ผมยังเลือก plain attempt+cleanup เพราะ A6 ไม่บังคับ observation endpoint ที่บริสุทธิ์ การเพิ่ม observe_only และ result variant คือ scope ของ wire เพิ่มจริง อย่าบันทึกว่าผมอนุมัติแล้ว”

🎨 **Sally:** “และอย่าแก้เรื่องนี้ด้วย anonymous endpoint Authenticate เป็น installation ผ่าน local exchange หรือ remote challenge ก่อน แล้ว request ใช้ session bearer ของ Actor นั้น Local Mode ไม่ส่ง installation private key มาพิสูจน์ทุก request”
หลักฐาน auth: session-commands.mjs:96–140; actor route: server/api/routes.mjs:37; no-auth regression: tests/session-routes.test.mjs:629–651.

Sally กับ John ยังไม่ตกลงกันเรื่อง footprint ของ free-name observation; ไม่มีฉันทามติในรายงานนี้ ข้อเสนอหลักของ Winston เลือก observe-only และต้องบันทึกการเลือกนั้นก่อน freeze ถ้าเลือกทาง John แทน ต้องแก้ acceptance wording ให้ยอมรับ ordinary claim+cleanup และทดสอบ cleanup failure โดยห้ามอ้าง binds nothing

ทั้งสองทางห้าม refresh ticket/reobserve/reprompt ภายใน retry เดิม conflict_stale จบคำสั่งด้วย code เดิม; หาก operator ต้องการลองใหม่ ต้องเริ่ม observation และ confirmation ใหม่ Transport failure/lost success response รายงาน outcome unknown ไม่ blind retry หรืออ้างว่าไม่ takeover สำเร็จ CLI ใช้ raw roundTrip ที่ไม่มี retry อยู่แล้ว; อย่านำ intent เข้า generic request() ที่มี reconnect/401 reauth+retry
หลักฐาน: server/cli/http.mjs:16–39,47–77; server/client/api-client.mjs:849–864. Generic client assertCoded ปัจจุบันไม่ส่ง ticket extras ออกไป MCP (:690–699) ไม่จำเป็นต้องขยาย generic error API เพื่อ CLI นี้

รอบสาม — replay และ proof

**6. Replay/theft — REFINE; กำหนด burn boundary และแก้คำกล่าวเรื่อง Actor key**

🔒 **Vex:** “ticket ลำพังไม่ให้ authority แต่คำว่า theft without Actor key is useless แรงเกินจริง คนมี valid same-Actor session bearer ก็ authenticate ได้ ไม่ต้องถือ private key ณ redemption และ Local Mode อยู่บน OS-user/local-token boundary สองโปรเซสแชร์ installation key ยังแยกความชอบธรรมกันไม่ได้ Ticket ไม่พิสูจน์ว่าเป็น rightful successor หรือมนุษย์”

ลำดับที่เสนอหลัง auth/fence/input validation:
1. ตรวจ grammar และ current foreign-holder confidentiality ก่อน; foreign/Actor mismatch/name mismatch ไม่ consume ticket ของเจ้าของ
2. lookup ticket, ตรวจ Actor + normalized name และ deadline ด้วย monotonic execution-time clock; unknown/expired/used ตอบ conflict_stale แบบเดียวกัน
3. สำหรับ valid scoped redemption ให้ consume หนึ่งครั้งแบบ synchronous แล้ว compare current pair ใน atomic transfer แม้ชื่อว่าง/self ก็ต้อง compare; pair stale ก็จบ ใบเดิมไม่มีสิทธิลองกับ holder ใหม่
4. เมื่อ pair ตรง ให้ durable persist → commit live ownership/generation → supersede displaced key ไม่มี await คั่น; persist failure ไม่เปลี่ยน incumbent pair, durable claim, authority หรือ fence และไม่คืน ticket ที่ consume ไปแล้ว

🏗️ **Winston:** “บันทึกด้วยว่า refusal/failure อาจเปลี่ยนเฉพาะ ticket bookkeeping นี้ ไม่ใช่ no-state-change แบบครอบจักรวาล Persist failure ตอบ error เดิม เช่น request_failed 500; retry ด้วย ticket เดิมจึง conflict_stale ไม่เปลี่ยน failure ทุกชนิดเป็น stale ตั้งแต่ครั้งแรก”

🔒 **Vex:** “replay ไม่ต้องมี spent-ticket ledger: ไม่มีใน map แล้วให้ stale Wrong Actor ห้าม burn ไม่เช่นนั้นคนขโมย ticket แต่ไม่มี credential เจ้าของยังทำลาย prompt ของเจ้าของได้ ticket แยกผูก Actor ไม่ต้องผูก claimant bearer เพิ่ม เพราะ requirement ระบุ Actor; ถ้า command เปลี่ยน auth session เงียบ ๆ ไม่ได้แปลว่ามี consent ใหม่”

**7. Test flips — REFINE; replay อย่างเดียวไม่ใช่ observed-incumbent proof**

🔒 **Vex:** “row ปัจจุบันตั้งชื่อ last explicit intent wins และ assert 200 ทั้งสองครั้งจริง ที่ tests/session-replacement.test.mjs:264–287 ต้องแทน acceptance นี้โดยตรง:
A ถือชื่อ → B observe ได้ TB และ C observe ได้ TC ซึ่งเป็นคนละใบและทั้งคู่ pin (A,g1) → B ใช้ TB สำเร็จเป็น (B,g2) → C ใช้ TC ที่ยังไม่เคยใช้และยังไม่หมดอายุ ต้อง conflict_stale และ B ยังถือชื่อ
แยก assertion replay TB → stale ด้วย จากนั้น C observe B ใหม่ ได้ TC2 และ confirm ใหม่ จึงแทน B ได้ ห้ามเปลี่ยน TC ให้ pin B อัตโนมัติ”

🎨 **Sally:** “CLI test ต้องหยุดที่ prompt หลังรับ ticket แล้วเปลี่ยน incumbent ก่อนตอบ y ให้เห็น coded stale จริงโดยไม่มี observation/prompt รอบลับ row ปัจจุบันที่ tests/session-replacement.test.mjs:1592–1646 ใช้เป็นฐานได้ อย่าเขียน unit test ที่แค่เช็คว่า helper ถูกเรียก”

proof ที่ต้องอยู่ใน existing test files แบ่งเป็นห้ากลุ่ม:
1. Occupancy CAS: independent TB/TC ข้างบน; A→release→same-key-A; holder ว่าง/self ณ execute; rename-away/back และ lease expiry; idempotent same-key/name bind/touch ไม่เปลี่ยน generation; stale ปฏิเสธโดยไม่แตะ successor/other names
2. Auth/confidentiality: unauth 401 ไม่มี ticket; foreign collision เทียบ exact bare envelope ทั้ง issuance/redemption และตอน map เต็ม; wrong Actor/name ไม่ burn rightful ticket; normalized name เดียวกันใช้ได้; ไม่มี bearer/digest/metadata หลุด
3. Wire/compatibility: missing/malformed required ticket 400; valid-shaped unknown/spent/expired 409; ticket-without-intent 400; ordinary bind/reconnect ไม่มี ticket ยังทำงานและไม่ส่ง intent; PATCH/DELETE unknown_field; extras allowlist และ error/status-table parity
4. Ticket lifetime/atomicity: now==deadline stale; headers ก่อน expiry แต่ execute หลัง expiry stale; full global/per-Actor cap refuse NEW issuance แต่ใบเก่ายัง redeem ได้; invalidation เมื่อ restart; persist callback จริง throw แล้ว incumbent pair/generation/fence คงเดิม และ ticket ไม่คืนชีพ
5. CLI: observe→prompt→redeem ใบเดิม; stale while prompt ends command; no/EOF/interrupt ไม่มี intent; foreign/free branch ไม่ takeover prompt; no ticket logging; release failure รายงานตรงจริง; observation ไม่ claim ถ้าเลือก observe_only หรือทดสอบ footprint/cleanup failure ถ้าเลือกทาง John

🏗️ **Winston:** “อย่าอ้าง API failure row เดิมเป็น real-persist proof มัน inject transfer ให้ throw ตั้งแต่ tests/session-replacement.test.mjs:392 ขยาย row ที่เกี่ยวข้องให้ fail ที่ real persist callback ด้วย Existing direct-registry failed-write coverage ใช้ต่อได้ และเติม route-level assertion ว่าไม่ revoke/fence incumbent ก่อน persistence สำเร็จ”

คำตอบ a–e — คำตอบตรงจาก Winston พร้อมความเห็นต่างที่ยังอยู่

**a) ใช้ pair หรือ generation alone?**
ใช้ internal (sessionKey,generation) pair Generation อย่างเดียวก็แก้ A→free→A ได้ถ้ารับประกันไม่ reuse/reset ระหว่าง ticket ที่ยังใช้ได้ แต่ pair ตรง observed-incumbent contract และช่วยตรวจ invariant Key อย่างเดียวแก้ ABA ไม่ได้ ทั้งคู่จะผิดหาก reset generation หลัง release แล้วออกเลขเดิม

**b) observation ต้อง authenticate หรือไม่?**
ต้อง authenticate ด้วย Actor-class credential ก่อนเสมอ Anonymous caller ไม่เคยได้ ticket ไม่ว่ามา local/remote/pre-auth; ไม่รับ Actor จาก request body ไม่ย้าย issuance ไป open challenge route การ authenticate ด้วย installation หมายถึง local/remote exchange ให้ได้ session bearer ไม่ใช่ใช้ installation public key ลอย ๆ เป็น credential

**c) error vocabulary เท่าไร?**
เพิ่ม code ใหม่เพียง conflict_stale → HTTP 409 พร้อม canonical message ใน PUBLIC_ERRORS/PUBLIC_ERROR_STATUS ใช้ existing invalid_request 400, unauthorized 401, chat_id_taken 409, rate_limited 429 ตามเหตุ Additive fields: conflict_ticket request+response/error-extra; ไม่ส่ง observed_generation ตามข้อเสนอหลัก ถ้าเลือก observe-only ให้เพิ่ม observe_only ใน POST request vocabulary และระบุ success variant เพิ่มอย่างชัดเจน ไม่เพิ่ม FR-17 send statuses ไม่เพิ่ม protocol version โดยอัตโนมัติ และไม่อ้างว่า old takeover clients ยัง compatible

**d) TTL และ bound ที่เสนอ?**
Winston/Vex เสนอค่าตั้งต้น TTL 120,000 ms; max 4,096 tickets ต่อ server instance และ 64 ต่อ Actor ใช้ monotonic clock; fixed/non-sliding; legal iff execution check now < deadline เมื่อ now==deadline stale เสมอ การรับ headers ก่อน deadline ไม่ reserve สิทธิ redeem หลัง deadline จึงไม่ต้อง pin ticket ระหว่างรอ body เมื่อ consume+compare synchronous เริ่มแล้ว ห้ามมี await ให้ expiry/GC มาแทรกกลาง commit

expired/consumed เท่านั้นที่ต้องนำออกตาม policy หลัก ไม่มี FIFO/LRU ที่ขับใบยัง valid เต็มแล้ว rate_limited429+retry_after_ms จาก earliest relevant expiry; ถ้าติดทั้งสอง cap ใช้เวลาที่ทั้งสองเงื่อนไขมี slot ได้ และส่งค่าบวก Admission cap ห้ามปิดกั้น redemption ของใบเดิม ไม่ rotate/refill ticket เงียบ ๆ ไม่ขยาย deadline; per-Actor accounting ลบทิ้งเมื่อไม่มี outstanding ticket เพื่อไม่เพิ่ม unbounded map อีกอัน

📋 **John:** “ผมเสนอ 300,000 ms และ per-Actor 32 ส่วน global4096 เท่ากัน เวลายืนยันการไล่ live session ควรพอให้ตรวจ ไม่เห็นข้อมูลใช้งานที่พิสูจน์ว่า 120s เหมาะกว่า”
🎨 **Sally:** “ฉันเลือก 5 นาทีเช่นกัน CAS เป็นตัวป้องกันไล่ successor; TTL สั้นเพิ่มภาระเริ่ม prompt ใหม่”
🔒 **Vex:** “ผมยังเลือก 2 นาทีเป็น initial exposure/window budget กับ 64 tickets แต่ไม่ได้อ้างว่าวัดมาแล้ว Cap นี้จำกัด ticket memory ไม่ใช่ DoS guarantee ของทั้ง server”
ตัวเลขยังเป็น policy recommendation ที่ต้อง ratify ไม่ใช่ค่าที่เคยบันทึกหรือผ่าน load/UX measurement; ห้องไม่มี consensus เรื่อง TTL/per-Actor cap แต่ทุกฝ่ายปฏิเสธ live-ticket eviction

**e) ขัดกับ prior decisions ตรงไหน?**
การเอา plain bind ไปเรียกว่า observation-only ขัดพฤติกรรมจริง; แก้โดยเลือก flow ข้อ 5 อย่างเปิดเผย ส่วนความสัมพันธ์ที่ต้องรักษามีดังนี้:
1. Release ไม่ bootstrap/re-auth/observe/แนบ intent; DELETE session-key-scoped ของ caller เสมอ Delayed predecessor DELETE ห้าม release successor; ห้าม release-by-chat-id
2. Compare ticket/current pair และตรวจ admission ที่อาจ fail ก่อน ownership mutation; durable claim ก่อน live transfer/generation publish และก่อน revoke/fence; failure ไม่ทำลาย incumbent ไม่มี durable ticket/resume store
3. 7.1 fence คง auth-time pin, post-input synchronous fence และ finally release; ticket helper/clock/store access ในช่วง compare→persist→transfer→fence ต้องไม่เพิ่ม await หรือ fallible capacity check หลัง transfer Protected fence entries ห้ามถูกใช้ ticket bound มา evict
4. FR-15 ban boundary คง “next request” ตามสัญญา ไม่มี ban recheck ใหม่หลัง body เพื่อแก้ ticket; ไม่เปลี่ยน stage order/long-poll continuation policy Ordinary startup/MCP/PATCH/reconnect ไม่ส่ง takeover intent; explicit per-event consent ยังเป็น baseline ของ 7.4

หลักฐาน: docs/implementation/spec-6-4-reconnect-recovery-takeover.md:36–40,58; server/api/server.mjs:575–603,620–631; server/api/pipeline.mjs:271–288,650–688; Architecture Spine :126; docs/epics.md:642,678.
นี่เปลี่ยน last-wins ตาม A6 โดยเจตนา ไม่ใช่ข้อขัดแย้งที่ต้องเก็บ implementation เก่าไว้สองทาง

ขอบเขตหลักฐานและการตรวจ

🏗️ **Winston:** “อ่าน actual source/test bodies/config และ recorded decisions ใน current tree โดยตรง ไม่มีการรัน test, server, CLI, mutation probe หรือ network request ผล Epic 6 เป็น document-reported execution ไม่ใช่ผล rerun ของเรา Story 7.2 ยังไม่ได้ implement จึงไม่รับรอง runtime, load capacity, operator timing หรือ lost-response behavior ใหม่ พบ design brief เป็น untracked file อยู่ก่อนเริ่มและไม่แตะมัน”

🎨 **Sally:** “ใช้ bmad-party-mode พร้อม John/Sally/Winston/Vex ตาม skill ที่ติดตั้ง _bmad config/resolver ไม่มีใน project นี้ จึงใช้ defaults/inline cast และขอบเขต single-file ที่ผู้ใช้กำหนด ไม่มี memlog, keepsake หรือไฟล์อื่น”
Skill: /Users/ngs/.agents/skills/bmad-party-mode/SKILL.md; PM/UX persona จาก sibling skills bmad-agent-pm และ bmad-agent-ux-designer. ขอบเขต read-only ของผู้ใช้มีผลเหนือ optional workflow writes

หลัง implementation และการ ratify ข้อ 5/TTL ให้ใช้ existing checks นี้เป็น proof:
node --test tests/session-replacement.test.mjs tests/session-routes.test.mjs tests/api-contract.test.mjs tests/constants.test.mjs
คำสั่งนี้เป็น acceptance check ที่เสนอ ไม่ได้รันใน review นี้ และไม่มีผล PASS ที่อ้างขึ้นจากการอ่าน source
การตรวจ deliverable: ไฟล์แบนที่ exact path, ไม่ใช่ directory/symlink, terminal marker ตาม task; ไม่แก้ source/docs/tests หรือเริ่ม service

แต่ละเสียงลงท้ายของตนเอง

📋 **John:** “เดินหน้า 7.2 ได้ Hold จบแล้ว ผมรับ memory ticket และการเลิก last-wins แต่เลือก plain POST+truthful free-name cleanup และ TTL5นาที/per-Actor32 ไม่อนุมัติให้เรียกมัน observation ที่ไม่ bind ต้องพิสูจน์สอง independent observations ของ A และให้ A1 docs ลงพร้อม story”

🎨 **Sally:** “ฉันยัง REFUSE ข้อ 5 เดิม และเลือก authenticated observe-only แม้ต้องเพิ่ม wire amendment ถ้าชื่อว่าง CLI ไม่ควร claim เพื่อถามคำถาม ยืนยัน snapshot เดิมครั้งเดียว TTL5นาที stale แล้วจบ ไม่มี prompt หรือ ticket refresh ลับ”

🏗️ **Winston:** “ข้อเสนอสำหรับลง spec คือ ephemeral opaque ticket, private generation pair, observe_only ที่ ratify ชัด และ conflict_stale409; ค่าเริ่มต้น120s/4096/64 ร่างยัง NOT READY TO FREEZE จนแก้ observation semantics, burn/capacity rules และ independent-ticket regression ข้างต้น ผมไม่แปลงความเห็นต่างของ John/Sally ให้เป็น consensus”

🔒 **Vex:** “อนุมัติแนว ticket ที่แก้แล้วเมื่อ foreign collision bare จริง, generation อยู่ภายใน, free/self path ถูก CAS และไม่ evict ใบ valid ผมยังเลือก120s/64 และปฏิเสธคำกล่าวว่า ticket+Actor auth พิสูจน์ rightful process หรือมนุษย์ Theft ของ ticket อย่างเดียวไม่มี authority และต้องไม่ burn prompt ของเจ้าของได้”

TEAM_DONE story-7-2-design-codex
