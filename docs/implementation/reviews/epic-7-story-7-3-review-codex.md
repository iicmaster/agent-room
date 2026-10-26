😤 **Grumbal — test adversary:** ส่งกลับแก้ก่อนปิด Story 7.3 ผม REFUSE การรับงานที่ `b9e2ee2`: มี contract test ล้มจริง และ A8 ยังมีทางออกก่อน cleanup หรือค้างเกิน deadline ส่วน A9 ป้องกันการ publish token ใน client ได้ แต่ยังไม่พิสูจน์ lifecycle ของ MCP child

📋 **John — PM:** วงนี้มีผม, Sally (UX/error contract), Mira (lifecycle/concurrency) และ Grumbal เราตรวจ HEAD `b9e2ee23facab64dd331a2feb4cdeda543a84017` และ diff `f421027..b9e2ee2` จากไฟล์จริง ไม่ได้แก้ source หรือรัน integration suite ที่สร้าง state ผลข้างล่างแยก source reasoning, isolated probe และ test ที่รันจริง เราใช้ amended AC ใน `docs/epics.md:668–670` เป็นเกณฑ์ ไม่เรียกร้องให้ SIGKILL/OOM/power loss คืนชื่อได้ และไม่ขยายไปออกแบบ recovery ของ Story 7.4

😤 **Grumbal:** เริ่มจาก **F1 / P1 — registry ไม่ตรงกันและ relevant test แดง** ก่อนเถียงเรื่อง design:

```sh
node --test --test-name-pattern='every v0.1 public error code has an HTTP status declared once' tests/constants.test.mjs
```

ผลที่รันจริงด้วย Node `v24.18.1`: **exit 1, 0 pass / 1 fail** ที่ `tests/constants.test.mjs:361`; actual status keys มี `shutdown` เกินมา เพราะเพิ่มที่ `server/constants.mjs:401` แต่ไม่มีใน `PUBLIC_ERRORS` (`:223–300`) แถวเดิมบังคับ key parity ทั้งสองตาราง ไม่ใช่แค่มี status อยู่ที่ไหนสักแห่ง `tests/api-contract.test.mjs:344` ก็มี invariant เดียวกัน แต่เราไม่ได้รันแถวนั้น จำนวน focused 29/29 ที่แจ้งมาจึงยังเป็นไปได้ ไม่ได้หักล้าง failure นี้

🎨 **Sally:** John ฉันไม่คัดค้านการมี client-produced public error ใน module เดียว AD-9 ที่ `ARCHITECTURE-SPINE.md:132` บังคับ status อยู่บ้านเดียว ไม่ได้บอกว่าผู้ผลิตต้องเป็น HTTP server เท่านั้น และตารางเดิมมี error จาก runtime/client อยู่แล้ว `shutdown:400` จึงยอมรับได้ในฐานะ metadata ของคำขอที่ client ปฏิเสธ คล้าย `request_cancelled:400` ที่ `constants.mjs:379`; MCP ส่ง code ใน tool result ที่ `mcp-stdio.mjs:694–700` ไม่ได้ส่ง HTTP 400 จาก server จริง การเปลี่ยนเป็น 503 เพื่อสื่อว่า “server down” จะไม่ตรงสาเหตุนี้ แต่การเพิ่มเฉพาะ status เป็น orphan ทำให้ convention ปัจจุบันแตก ต้องลง canonical public code/message และปรับ expectation เดิมให้ตรงกัน หากจะเลือกแยก client-only registry ต้องตัดสิน contract นั้นโดยตรง ไม่ใช่ปล่อยตารางสวนกันไว้

🔧 **Mira:** **F2 / P1 — 2,000 ms ไม่ใช่ deadline ที่ adapter บังคับได้** `mcp-stdio.mjs:485–486` แค่ await client แล้ว await `release()`; ไม่มี watchdog หรือ total-time budget ถ้า release ไม่ resolve, shutdown ก็ไม่ settle และ signal path ที่ `:509` ไม่ไปถึง exit

ยิ่งกว่านั้น production release ไม่ได้รับประกัน total 2 วินาที: `api-client.mjs:521` ส่ง timeout เข้า `httpRequest`, แต่ `:232–234` ใช้ `request.setTimeout()` ซึ่งเป็น socket inactivity timeout ไม่ใช่เวลารวม และเริ่มผูก socket timeout หลัง connect ตาม [เอกสาร Node HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html#requestsettimeouttimeout-callback) ตัวอย่างจาก source: peer/proxy ส่ง response bytes ห่างกันไม่ถึง 2 วินาทีแต่ไม่จบ response → idle timer ไม่หมด → release ค้างต่อได้ Timeline นี้เป็น source-derived counterexample ยังไม่ได้รัน trickling-server integration

📋 **John:** Mira, spec ของ story เองเขียนที่ `spec-7-3-always-let-go.md:50–52` ว่า socket idle timeout ใช้ทำ deadline ฉันไม่อยากเพิ่มวงจรใหม่เพียงเพื่อกัน API ที่ production ไม่เคยคืน Promise

🔧 **Mira:** ผมคัดค้านตรงนั้น การเลือก implementation ใน spec ไม่สามารถลด AC `epics.md:668` ที่กำหนด “process exits under the declared deadline” ให้กลายเป็น “ต่อเมื่อ socket ยอม idle” ได้ และคำถาม review นี้เจาะกรณี release ไม่ resolve โดยตรง เราทำ isolated probe แบบไม่เขียนไฟล์: อ่าน production block `mcp-stdio.mjs:476–512` เดิมไป execute ใน child ที่เราสร้างเอง ใช้ release stub ที่ไม่ resolve พร้อม handle ค้ำ event loop ผลจริงคือ:

```text
{"elapsedMs":2152,"stillAlive":true}
```

นี่พิสูจน์ว่า block ไม่มี adapter deadline ไม่ใช่หลักฐานว่า real HTTP request เคยค้างแบบนั้นแล้ว วิธีแก้ต้องมี budget รวมจากจุดเริ่ม shutdown และยกเลิก I/O ที่เหลือเมื่อหมดเวลา; `Promise.race` ที่ปล่อย socket ค้างอย่างเดียวก็ยังค้ำ process ใน stdin-close path ได้

😤 **Grumbal:** John ฉันอยู่ข้าง Mira เรื่องเกณฑ์ ไม่ต้องเรียกมันว่า future case: แถว SIGTERM ใช้ `exitMs < 15_000` ที่ `session-replacement.test.mjs:1281` แล้วตั้งชื่อ assertion ว่า “declared bound” ทั้งที่ constant คือ `CLIENT_RELEASE_TIMEOUT_MS = 2_000` (`constants.mjs:540`) Harness ก็รอ 15 วินาทีที่ `:1250–1252` เซิร์ฟเวอร์ในสอง signal rows ตอบปกติทั้งหมด การเปลี่ยน release timeout เป็น 10 วินาทียังไม่ถูกสองแถวนี้ตรวจพบ ไม่มีแถวที่ exercise AC5 ของ spec (`:60`) คือ unreachable/timeout พร้อม failure outcome และ deadline จริง

🔧 **Mira:** **F3 / P1 — signal ชนิดเดิมซ้ำไม่ join** แม้ `shutdownPromise` ที่ `mcp-stdio.mjs:476–498` จะ single-flight จริงสำหรับ invocation ที่เข้าถึงฟังก์ชัน และ `close()` ที่ `:798–803` คืน Promise เดียวกันได้ แต่ `process.once('SIGTERM', …)` / `once('SIGINT', …)` ที่ `:511–512` ถอด listener หลังรับครั้งแรก ระหว่าง release ยังรออยู่ signal เดิมครั้งถัดไปจึงไม่มี callback ให้ `signalExit` guard ช่วย

probe เดียวกันรอจน child ส่ง `RELEASE_ENTERED` ก่อนส่ง SIGTERM ซ้ำ จึงแยกสอง delivery ออกจากกันได้ ผลจริง:

```text
{"probe":"second SIGTERM after first entered release","exit":{"code":null,"signal":"SIGTERM"}}
```

ลูก probe ถูก signal ฆ่าก่อน release settle นี่สอดคล้องกับ [Node signal behavior](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events) ต้องคง handlers ไว้ตลอดช่วง shutdown แล้วจัดการ lifecycle ของ listeners ให้ครบ สำหรับ SIGTERM ตามด้วย SIGINT อย่างละครั้ง callback ยังมีอยู่และ guard กันการตั้ง exit continuation ซ้ำได้; ปัญหาเฉพาะ delivery ซ้ำของชนิดที่ listener ถูกถอดไปแล้ว

😤 **Grumbal:** Mira, แถว repeated SIGINT ยังไม่หักล้างคุณ `session-replacement.test.mjs:1301–1303` ส่ง SIGINT สองครั้งติดกันแล้วปิด stdin ไม่มี gate ว่า release เริ่มแล้ว ไม่มี delayed DELETE response ไม่มีการนับ release invocation และทิ้ง exit tuple ที่ `:1251` สอง signal อาจถูก coalesce หรือ stdin close เป็นคนปล่อยชื่อให้ ถ้าเอา SIGINT listener ออกก็มี false-green lane จาก EOF แต่ฉันไม่อ้างว่ามันจะผ่านทุก scheduler

อีก mutant ที่ source บอกได้ชัดกว่า: เอา early return ของ `shutdownPromise` ที่ `mcp-stdio.mjs:478` ออก แต่เก็บ release เดิมไว้ แถวเหล่านี้ก็ยังมีทางผ่าน เพราะ release แรก null token ก่อน await (`api-client.mjs:519`), release ถัดไปตอบ `no_session` tests ไม่ได้เทียบ shared Promise หรือนับการเรียก จึงตรึง single-flight ไม่ได้ **เราไม่ได้รัน mutants เหล่านี้**

🎨 **Sally:** ก่อนรวม A9 เป็นบั๊กทั้งหมด ฉันขอรักษาสิ่งที่ถูกไว้: `release()` ตั้ง `shuttingDown = true` ที่ `api-client.mjs:516` ก่อนอ่าน token ที่ `:517` และไม่มี await คั่น Guard หลัง bind ที่ `:473` กับ assignment ที่ `:481` ก็ไม่มี await คั่นเช่นกัน จากการค้น assignments ของ `sessionToken`, `:481` เป็นจุดเดียวที่ให้ค่าที่ไม่ใช่ null ภายใต้ event loop ของ client นี้ หาก release เริ่มก่อน continuation นั้น มันจะเห็น flag แล้วไม่ assign; ถ้า assign มาก่อน release, release จะอ่าน token นั้นไป cleanup นี่เป็น source proof ที่ดีสำหรับ **no late token publication**

local lane และ remote/challenge lane มารวมที่ `bindWithToken()` (`:632,654`) ส่วน initial ensure กับ 401 re-auth ใช้ `authenticateOnce()` เดียวกัน (`:657–663,839–841,881`) จึงไม่มี lane ที่ assign token ข้าม guard จาก source ที่ตรวจ authenticate ที่เริ่มหลัง release จะได้ `shutdown` ที่ `:605–610`; auth ที่เริ่มไว้ก่อนแล้วก็ยังถูก guard ท้าย bind กัน publication ได้ แม้มี concurrent callers

🔧 **Mira:** Sally, ผมรับ proof เรื่อง assignment แต่ **F4 / P1 — adapter ยังไม่ประสาน pending auth/bind ตาม AC** เป็นอีกคำถาม:

1. Server รับ POST bind และ commit ชื่อแล้ว แต่ response ยังถูกหน่วงอยู่ (`api-client.mjs:469`)
2. SIGTERM มาถึง; `sessionToken` ยัง null จึงได้ `no_session` จาก release (`:516–518`)
3. shutdown จบโดยไม่รอ pending bind และ `process.exit()` ที่ `mcp-stdio.mjs:509` จบ process
4. continuation ที่ `api-client.mjs:473–479` ไม่เคยได้รัน จึงไม่มี rollback DELETE แม้ server ยัง reachable

[Node ระบุว่า process.exit ยุติแม้มี asynchronous I/O ค้าง](https://nodejs.org/docs/latest-v24.x/api/process.html#processexitcode) Timeline นี้อนุมานจาก source ยังไม่ได้ทำ real-MCP-child/proxy reproduction แต่เป็นทางเดินตรงที่ขัด `epics.md:668` ซึ่งสั่งให้ coordinate pending auth/bind และ release resulting session เมื่อ reachable โดยเฉพาะ

abort controllers ที่ `mcp-stdio.mjs:480` ไม่ช่วย เพราะ initial auth/challenge/bind ไม่รับ signal ของ tool call (`api-client.mjs:469–472,535–560,635–642`) stdin-close path ไม่ force exit แบบ signal จึงอาจมีชีวิตรอ auth/bind และ rollback ต่อได้ แต่ sockets เหล่านี้ใช้ default idle timeout **10,000 ms** (`constants.mjs:531`), ไม่ใช่ shutdown deadline 2,000 ms

🎨 **Sally:** และ pre-auth guard ไม่ได้แปลว่า “ไม่มีงานใหม่เกิดหลัง shutdown” ทุกกรณี: challenge ที่เริ่มก่อน flag เปลี่ยนยังตอบกลับมา แล้วโค้ดยังส่ง answer/POST bind ต่อได้ เพราะไม่มี shutdown check ระหว่าง awaits (`api-client.mjs:534–587,611–632`) ฝั่ง local ก็เดินจาก exchange ไป bind ได้เช่นกัน Token ไม่ถูก publish แต่ server session/name อาจเกิดชั่วคราวและต้อง rollback

admission ของ adapter ก็ยังไม่ปิดจริง: signal path ไม่ถอด data listener และ `handle()` ที่ `mcp-stdio.mjs:739–751` ไม่มี closing gate มัน abort เฉพาะ pending ชุดเดิม งานที่มาทีหลังสร้าง controller ใหม่ได้; local tools ที่มี realm cache เช่น `room_held_count` (`:686–690`) ยังตอบสำเร็จโดยไม่ผ่าน authenticate ส่วน ensure อาจ bootstrap ก่อนเจอ refusal (`api-client.mjs:867–881`) นี่เป็น **P2 ในกลุ่ม F4** ไม่ใช่ช่องทาง publish token เพิ่ม

📋 **John:** Grumbal, A9 test ไม่ได้ผิด premise มัน hold bind response จริง (`session-replacement.test.mjs:1343–1346`), release ก่อนเปิด gate (`:1375,1380`), ตรวจ coded refusal และชื่อว่าง/stranger bind ได้ (`:1381–1395`) มันป้องกัน regression ของ client guard+rollback ได้ตรงเรื่อง แต่เป็น client ใน parent test process ที่ยังมีชีวิตรอ cleanup (`:1367`) ไม่ได้ทดสอบ signal-exit composition ของ MCP child จึงไม่ครอบ F4 ส่วน mutation “ลบ rollback แล้ว test ตาย” ที่แจ้งมา เราเห็นเหตุผลจากโครงสร้าง test ว่าควรตาย แต่ไม่ได้ตรวจ receipt หรือ rerun จึงไม่ยกระดับเป็น mutation proof ของ review นี้

🎨 **Sally:** **F5 / P2 — rollback และผลลัพธ์ถูกบอกว่าสำเร็จก่อนรู้จริง** `api-client.mjs:474–477` เริ่ม DELETE แล้วทิ้ง Promise; ไม่มี release timeout ส่งไป จึงใช้ default idle 10 วินาที มันไม่อยู่ใน Promise ที่ host await จาก close และ failure ถูกกลืนไป จากนั้น `:479` บอก “the session bound during shutdown was released again” ทั้งที่ DELETE ยังไม่สำเร็จหรืออาจไม่มีวันสำเร็จ ฉันไม่ยอมรับ detached rollback แบบปัจจุบันเป็น completion ของ lifecycle ที่ AC ระบุ ต้องให้ shutdown ติดตาม pending cleanup ภายใน deadline และรายงาน failed/unknown เมื่อยืนยันผลไม่ได้

📋 **John:** Sally ฉันเห็นต่างเรื่อง “ต้อง await DELETE นี้” เป็นข้อบังคับเฉพาะวิธี AC บังคับพฤติกรรม ไม่ได้เลือกว่าต้อง await ที่บรรทัดนั้น best-effort asynchronous rollback ยังใช้ได้ หาก shared lifecycle รู้ว่ามันยังค้าง ให้โอกาส cleanup เมื่อ reachable และรายงาน unknown เมื่อหมด budget ฉันจึงไม่ขอเปลี่ยน best-effort ให้เป็น universal cleanup guarantee แต่ **implementation ตอนนี้ยังไม่มี coordination นั้น** ความเห็นต่างของเราคือวิธี/เกณฑ์ที่ใช้ยอมรับ rollback ไม่ใช่การอนุญาตให้ข้อความสำเร็จที่ไม่มีหลักฐานผ่านไป

🔧 **Mira:** John ผมไม่เสนอ universal guarantee เช่นกัน แต่ return `no_session` ทั้งที่มี bind ค้างไม่ได้สื่อ server state อย่างตรงไปตรงมา `mcp-stdio.mjs:492–494` พิมพ์ stderr เฉพาะผลที่ไม่ใช่ `released` และไม่ใช่ `no_session` ดังนั้นสองผลนั้นไม่ได้ถูก record บน stderr ตามคำอธิบายที่อ้าง ส่วน failed/unknown มีการพยายามเขียนจริง แต่ไม่รอ write callback ก่อน `process.exit()`; จึงยังไม่ใช่หลักฐานว่า stderr ถูกส่งออกครบทุกครั้ง อย่าใช้ “silent” แทน “ไม่มี session เหลือ” ใน initial-bind race

🎨 **Sally:** A1 sweep แก้ caveat เดิมแล้ว แต่แทนด้วยคำรับรองแรงกว่า amended AC: `README.md:84–91` บอกคืนชื่อก่อน process จบ และ initial bind “cannot leave a name behind either”; `CHANGELOG.md:9–19` รับรองเช่นเดียวกันพร้อม total 2,000 ms และการ record outcomes คำเหล่านี้ไม่บอก reachable-server condition, failed/unknown, หรือ best-effort rollback ต่อให้ซ่อม F2–F4 แล้วก็ยังต้องทำ prose ให้ตรง bounded contract แทนการรับรองทุก polite exit

📋 **John:** ฉันตรวจ shipped input list ด้วย `scripts/package-release.mjs:45–46`: README และ CHANGELOG ถูก package, `docs/` ไม่ถูก package ไม่พบ shipped current caveat ที่ยังบอกว่า one-shot reservation เป็น LIVE limitation แบบเดิม แต่พบ overclaim ด้านบน ประวัติใน CHANGELOG ใต้ v0.2.0 ควรคงเป็นประวัติ; `docs/release-notes-v0.2.md:1–7` ระบุ RELEASED ชัด ส่วน `docs/rel1-runbook.md:300–305` ยังมี imperative “Expect a squat”/งานรอบหน้า แต่หัวเอกสารที่ `:1` ผูกกับ v0.2.0 จึงไม่ควรนับเป็น current package contract หรือ rewrite หลักฐานเก่า รอบนี้ไม่ได้สร้าง package ใหม่หรือพิสูจน์ bytes ของ artifact ที่เผยแพร่จริง

😤 **Grumbal:** การทดสอบที่ต้องแก้ควรอยู่ไฟล์เดิมและเจาะ acceptance criteria ไม่ต้องเพิ่ม infrastructure:

| กลุ่มเดิม | สิ่งที่ตรึงได้จาก source | สิ่งที่ยังไม่ตรึง / mutant ที่รอดได้ |
|---|---|---|
| SIGTERM, `:1258–1285` | tool สำเร็จ, ก่อนออก stranger ได้ 409, หลังออกได้ 200; ลบ SIGTERM release ทั้งเส้นทางควรทำให้ล้ม | ไม่ตรวจ total 2s, failure log, single-flight, delayed release หรือ pending bind |
| SIGINT + EOF, `:1287–1310` | หลังรวม triggers ชื่อ bind ได้ | ไม่มี barrier ว่าสัญญาณซ้ำถึงขณะ release ค้าง, ไม่ตรวจ exit tuple/จำนวน release; ลบ single-flight guard ยังมีทางผ่าน |
| A9 gated, `:1312–1396` | client อยู่รอจน late bind ถูกปฏิเสธและ rollback ปล่อยชื่อ | ไม่เดิน child exit; ลบ upfront authenticate shutdown guard แต่เก็บ post-bind guard แถวนี้ยังตรวจไม่พบ |
| AC ที่ยังต้อง pin | ใช้ gated child tests และ assertions เดิมให้ชัดขึ้น | never-resolving/trickling release + true deadline/cleanup, unreachable failed/unknown stderr, repeated same-signal ระหว่าง DELETE ค้าง, signal ระหว่าง bind response ค้าง, late calls ไม่มี exchange/bind และ awaitable close joins operation |

สอง signal rows ทิ้ง stderr ที่ `:1221` และทิ้ง exit tuple ที่ `:1251`; จึงไม่พิสูจน์ outcome หรือ “cleanly” Remote/challenge, 401 และ concurrent shutdown cases มี source reasoning ว่า guard assignment ครอบ แต่ไม่มี Story 7.3 row ตรึง lane เหล่านั้นโดยตรง การเรียกการทดสอบนี้ว่า 29/29 ไม่ทำให้ missing assertions หายไป

📋 **John:** เรื่อง prior decisions: **ไม่พบ conflict กับ Story 6.4 หรือ FR-15 ใน diff นี้** ordinary bind ส่งแค่ `chat_id`/`client_type` (`api-client.mjs:469–472`), release กับ rollback เป็น raw DELETE พร้อม bearer เดิม (`:474,521`) ไม่มี `replace_existing` และไม่ไป authenticate เพื่อ release ยังคง “release never carries takeover intent” และ session-key-scoped cleanup ตาม `spec-6-4:36–40`; server ใช้ `registry.release(principal.sessionKey)` ที่ `server/api/server.mjs:627–632` จึงไม่มี delayed predecessor DELETE ที่ปล่อย successor จากการใช้ชื่อแทน key ไม่ได้แตะ fence/ban boundary, peer, history หรือ cursor contract FR-15 ยังเป็น in-flight refusal at next request และ active long-poll bound ตาม `prd.md:268–271` การเสนอให้แก้ shutdown ไม่ใช่สิทธิ์ไปเพิ่ม automatic takeover/shorten lease หรือเปลี่ยน ban policy

🎨 **Sally:** ขอบเขตหลักฐานที่ยังเปิดอยู่: ไม่ได้ rerun focused 29/29, full `node --test`, mutation run ที่อ้าง, real MCP-child delayed-bind/trickling-server reproduction, vendor CLI หรือ Remote TLS end-to-end และไม่ได้ตรวจ materialized release artifacts isolated probe ข้างต้น execute เฉพาะ production shutdown/signal block กับ stub ไม่ใช่ MCP integration proof ส่วน `/Library/Developer/CommandLineTools/usr/bin/git diff --check f421027..b9e2ee2` รันแล้ว **exit 0**; นั่นยืนยัน whitespace เท่านั้น tracked worktree ก่อนเขียน outbox ไม่มี diff และ review ไม่ได้แก้ source/tests/config

📋 **John — bottom line:** **REFUSE การปิด Story 7.3** จน pending bind กับ total deadline ตรง amended AC และ prose ลดลงถึงผลที่รับรองได้ ฉันยอมรับ 400 และ best-effort rollback เป็น design choices ได้เมื่อ lifecycle รับผิดชอบผลจริง ไม่ขอเพิ่ม Story 7.4

🎨 **Sally — bottom line:** **รับหลักฐาน source ของ no-late-token-publication; REFUSE lifecycle และ outcome wording ปัจจุบัน** detached cleanup ที่ host รอไม่ได้กับข้อความ “released again” ยังไม่ผ่าน ต่อให้ token guard ถูกต้องก็ห้ามเรียกว่าคืนชื่อสำเร็จทุกกรณี

🔧 **Mira — bottom line:** **REFUSE A8 และ A8+A9 composition** ต้องมี deadline รวมที่จัดการ I/O, handlers ที่รับ signal ซ้ำได้ตลอด shutdown และ coordination กับ pending bind ก่อน exit ความเห็นต่างเรื่องจะ await ที่ไหนยังเปิดอยู่; ไม่มีแบบใดได้รับอนุมัติจากแค่ Promise เดียว

😤 **Grumbal — bottom line:** **REFUSE หลักฐาน acceptance ปัจจุบัน** relevant contract test ล้มจริง และ signal rows ยังไม่ mutation-robust ต่อกลไกสำคัญ ขั้นแรกที่ทำได้ทันที: รันคำสั่ง constants test ด้านบนเพื่อเห็น orphan `shutdown` ก่อนแก้และเพิ่ม assertions ในไฟล์ทดสอบเดิม

TEAM_DONE story-7-3-review
