เพิ่ม committed regressions และแก้เอกสารที่ขัดกันก่อนรับ Story 7.1 — REFUSE acceptance ของ 2530806 ในรอบนี้

Task: story-7-1-review. ตรวจ HEAD 253080627fd1318de3cb40bf751e3ee4cacf930e และ diff d5b8228..2530806 แบบ read-only ไม่มี source edit, commit, push, service startup หรือ full-suite run ไฟล์เดียวที่เขียนคือ outbox นี้ การ REFUSE เป็นคำตัดสินต่อ acceptance ไม่ใช่ข้อกล่าวหาว่าพบ fence bypass ใน runtime ปัจจุบัน

วง bmad-party-mode: 📋 John — PM/เกณฑ์รับงาน; 🎨 Sally — UX และคำอธิบายที่ผู้ใช้เห็น; 🏗️ Winston — concurrency/registry; 😤 Grumbal — adversarial verification ใช้ installed party/PM/UX skills; project BMAD resolver/config ไม่มี จึงใช้ explicit cast และ defaults งานส่งไฟล์ครั้งนี้เป็นขอบเขตจบของวง ไม่เขียน party memory หรือ artifact อื่น

📋 **John:** “Winston ผมแยกสองคำถาม: code ทำถูกหรือยัง และ story ส่งครบ AC หรือยัง คำตอบแรกมีหลักฐานสนับสนุนชัด แต่คำตอบที่สองยังไม่ครบ จุดที่ค้างมีสี่กลุ่มนี้”

| ระดับ | ข้อที่ต้องปิดก่อน acceptance | หลักฐาน |
|---|---|---|
| P1 — required regression | ไม่มี committed test ที่จับว่าตัว pipeline acquire pin ก่อน auth yield / SEND-body wait จริง | tests/session-replacement.test.mjs:562–564,609–610,636–678; ข้อกำหนด docs/epics.md:648 และ design-gate-codex.md:134–135 |
| P1 — required accounting/capacity proof | “exactly once” ไม่แยก zero acquisition/double release; ไม่ทดสอบหลาย requests ต่อ key, protected entries เกิน bound และ drain-on-leave โดยไม่มี insert ตามหลัง | tests/session-replacement.test.mjs:596–679 |
| P2 — live CLI/doc sweep | help ยังประกาศว่า old A5 window เปิด และ prose ใหม่บางจุดบอกตำแหน่ง check ผิด | server/cli/agent-room.mjs:450–452; pipeline.mjs:439–452; Spine:124–126 |
| P2 — acceptance record | spec ยังเป็นกลไกที่ gate ปฏิเสธ; epic/AGY ยังห้าม pin ใน AuthStage แบบ literal | spec-7-1-the-fence-never-lies.md:50–59,81,89; docs/epics.md:644; design-gate-agy.md:151–153 |

🏗️ **Winston:** “John อย่าให้ตารางนี้กลายเป็นข้อสรุปว่า implementation ยังมี A5/A7 bypass ผม APPROVE runtime mechanism ที่อ่านและ probe แล้ว ขอไล่เส้นทางที่สำคัญให้ตรงก่อน”

**1. Placement และ exactly-once release**

🏗️ **Winston:** “ใน server/api/pipeline.mjs:263–288 verifier ทำงาน synchronously, principal ถูกใส่ context แล้ว enterInFlight ถูกเรียกก่อน AuthStage.process return เงื่อนไขคือ pipelinePinManaged === true, actor class, registry มี primitive และ sessionKey เป็น string ไม่ว่าง runPipeline ตั้ง owner flag ที่ :637 ก่อนเข้าลูป ส่วน await stage.process(context) อยู่ :640 จึงไม่มี first-post-auth microtask gap ก่อน acquire การย้าย increment ไป ‘หลัง await auth’ จะทำให้ guarantee อ่อนลง อย่าแก้กลับตาม wording เก่า”

😤 **Grumbal:** “ตรงนั้นผมยอมรับ แต่ standalone stage ต้องไม่ pin ด้วยนะ”

🏗️ **Winston:** “ถูก guarded AuthStage ที่เรียกเดี่ยวโดยไม่ผ่าน runPipeline ไม่ increment จึงไม่ทำให้ unit tests รั่ว ส่วน assertStageOrder อยู่ :628 ก่อนมี pin และห้าม duplicate auth stage; HTTP adapter สร้าง context ใหม่ต่อ request ที่ server.mjs:1089–1109 หลักฐานนี้อาศัย production callers เหล่านี้ ไม่ได้สัญญาว่า arbitrary custom stage จะเปลี่ยน context แล้ว lifecycle ยังปลอดภัย”

“outer try/finally ที่ pipeline.mjs:638–686 ครอบทุกจุดหลัง acquire: stage refusal/rejection/throw, readRequestFields rejection/abort, post-input unauthorized, handler rejection, synchronous throw, Promise rejection, normal result และ HANDLER_STREAMED stage exceptions propagate ออกไปให้ HTTP adapter map error แต่ผ่าน finally ก่อน handler exceptions ถูก catch ด้านในแล้วก็ผ่าน finally เช่นกัน await handler(context) ทำให้ไม่ release ขณะ awaited handler ยังไม่เสร็จ finally มี leaveInFlight call site เดียวที่ :683 แล้ว clear pinnedSessionKey กับ owner flag”

“ผมไม่ได้พึ่งการอ่านอย่างเดียว: memory-only probe ใช้ real registry/verifier/pipeline และ spy enter/leave ตรวจ 13 exit shapes ได้หนึ่งคู่ทุกกรณี ตรวจ acquisition ทันทีหลัง runPipeline คืน Promise ก่อน event-loop continuation และตรวจ standalone AuthStage ไม่ pin ทั้งหมด PASS”

😤 **Grumbal:** “นั่นเปลี่ยน runtime evidence ของผม แต่ไม่เปลี่ยนความหมายของ committed test ชื่อ ‘exactly once’ มันทดสอบเพียง normal handler return และ auth rejection ที่ไม่เคย pin (:650–678) ไม่มี counter/spies และ leaveInFlight ลบ count ที่ศูนย์หรือติดลบ (:88–98) ดังนั้น double release บน request เดียวมองไม่เห็น Worse: ถ้าไม่ acquire เลย test ก็ยังชอบผล ‘ไม่มี pin รั่ว’ นี่คือช่องว่างการป้องกัน regression ไม่ใช่คำกล่าวหาว่า finally ปัจจุบันผิด”

**2. Protected eviction, reissue และ drain**

🏗️ **Winston:** “server/api/session.mjs:104–115 มีจุดลบ superseded เพียงจุดเดียวที่ :109 และเข้าถึงได้เมื่อ count === 0 เท่านั้น เมื่อ protected entries ทุกตัวทำให้ size เกิน maxSessions ลูปจบโดยไม่ลบและไม่ throw ไม่มี hard-cap refusal หลัง transfer”

“issue ที่ :118–141, expiry sweep/verify และ revoke ที่ :175–177 เปลี่ยนเฉพาะ sessions ไม่แตะ superseded หรือ inFlight supersede ซ้ำที่ :187–192 ใช้ Map.set จึงคง fence/count เดิม การ issue ให้ Actor เดิมสร้าง bearer ใหม่ด้วย randomBytes(256 bits) และ digest ใหม่ ไม่มี API ให้ caller ขอ reuse token/key เดิม ภายใต้ cryptographic uniqueness ปกติจึงไม่มี same-key resurrection path; exact random-token/digest collision ไม่ใช่ช่องโจมตีที่สาธิตได้ที่นี่”

“leaveInFlight ที่ :88–98 ลด count และคง protection ถ้ายัง >0; เมื่อถึงศูนย์เรียก eviction ทันทีหาก over bound ตัว bound ใช้ total map size เป็น trigger แต่ลบได้เฉพาะ idle entries; หาก protected set เกิน bound จะไม่เก็บ idle cache เพิ่มอีก 1,000 ตัว ไม่มี AC บังคับต้องสงวน idle cache ขั้นต่ำ และความต่างนี้ไม่ทำให้ fence อ่อนลง”

“probe สร้าง/issue/pin/supersede จริง 1,002 keys บน default bound 1,000 แล้วเช็คทุก key ยัง fenced รวม revoke, supersede ซ้ำ และ same-Actor reissue จากนั้น leave สอง keys พิสูจน์ drain โดยไม่มี insert ตามหลัง และแยกทดสอบ count สอง requests ต่อ key: first leave ยัง fenced, final leave จึง evict ได้ ทั้งหมด PASS”

😤 **Grumbal:** “Winston เราเห็น code และ runtime evidence ตรงกัน แต่ committed pressure row (:604–633) pin แค่ ONE predecessor ที่ maxSessions:1 แล้ว churn 50 idle keys ไม่เคยมี protected entries > bound จึงไม่จับ hard-cap ที่ผิดเมื่อทุกตัว protected และ :622 leave เสร็จมี supersede ที่ :623 ก่อน assert :624 จึงไม่จับการถอด drain-on-leave ออก Gate ขอ >1,000 actual supersessions กับ pinned predecessors และ multiple requests per key ไว้ชัดที่ codex gate:134 การใช้ bound เล็กทำ test เร็วได้ แต่ต้องทำให้จำนวน protected เกิน bound จริง”

**3. Post-input fence, SEND, async handlers และ streaming**

🏗️ **Winston:** “รูปทรงตรงตาม invariant: pipeline.mjs:646 await readRequestFields เสร็จ; ถ้า fields ไม่ผ่านก็ return; :658–665 เป็น synchronous isSuperseded lookup gated ด้วย actor class และมี authz stage; ไม่ verify token ใหม่ ไม่ถาม isLive ไม่ re-run ban/budgets จาก check ถึงการเรียก handler(context) ที่ :668 ไม่มี await แทรก คำว่า await handler(context) ไม่ได้ yield ก่อนเรียก function”

“production actor mutations ปัจจุบันเป็น synchronous: bind/rename/transfer ที่ server.mjs:504–614, disconnect ที่ :626–631, direct-room open ที่ :728–783, append ที่ :918–975 persistence/transfer ต่อไปยัง synchronous store operations (server/store/room-log.mjs:1239–1249,1342–1368,1709–1717; transaction COMMIT ที่ :355–370) และ live-registry commit ที่ server/core/session-registry.mjs:252–277 ดังนั้น handoff ใน daemon เดียวกันไม่ interleave ระหว่าง final check กับ mutation commit ได้ ผมไม่พบ current async actor mutation path ที่หลุดตรงนี้”

“SEND อ่าน body ก่อนแล้วใน BudgetStage (:368–377) แต่ pin มีอยู่ก่อนเข้า stage นี้ และ later readRequestFields เป็น re-entrant no-op (:559–561) runPipeline ยัง await แล้ว final-check อีกครั้ง memory-only probe หยุด SEND ใน BudgetStage body read, supersede และ churn 50 keys, ปล่อย body แล้วได้ unauthorized และ handler ไม่ถูกเรียก”

“long-poll เป็น actor async handler ที่เข้าไปก่อน takeover ได้ จึงเช็ค fence ใน loop แยกที่ server.mjs:850–856 ก่อน readPage ทุก wake และ await sleep อยู่ :876–878 pin คงอยู่จน handler จบ นี่เป็น next-wake policy ไม่ใช่ universal cancellation ของงานที่เข้า handler ไปแล้ว”

“sole SSE route เป็น viewer class (server.mjs:1039–1045) จึงไม่ acquire actor pin เลย ไม่มี actor streaming mutation ใน route table ปัจจุบัน Sentinel ยังผ่าน finally ได้ใน probe แต่ไม่ควรอ้างว่าคืน HANDLER_STREAMED เป็นหลักฐานว่า arbitrary background continuation จบแล้ว อีกทั้ง real streamBroadcastEvents เป็น async loop (:411–449) แล้วค่อย return sentinel ที่ viewer.mjs:463; spec:96–99 ที่บอก return ณ stream START ก็ไม่ตรงกับ implementation ปัจจุบัน”

🎨 **Sally:** “นั่นแหละ Winston คำว่า ‘total’ ต้องพ่วง boundary นี้ด้วย README:75–80 กับ CLI module comments:22–26 บอก ‘every request ... in flight is refused’ แบบไม่แยก already-entered work คนอ่านอาจเข้าใจว่า response ที่ handler คำนวณแล้วแต่ยังไม่ได้ flush จะถูกเรียกคืนด้วย หลักฐานของเราไม่ใช่ universal cancellation”

**4. สิ่งที่ tests pin จริง กับสิ่งที่ยังไม่ pin**

😤 **Grumbal:** “John กรณี flipped A5 row มีคุณค่า: tests/session-replacement.test.mjs:544–552 gate body อย่าง deterministic; :574–584 transfer/supersede ก่อนปล่อย input; :586–589 assert handler ไม่รัน, unauthorized และไม่มี Ghost claim มันพิสูจน์ final guard ปิด delayed-body gap แต่ไม่ assert Agent ยังเป็น newKey ตรงๆ และไม่กด retention pressure”

“หลักฐาน committed ที่ยังขาดมีสี่กลุ่ม ไม่ต้องเพิ่ม test infrastructure หรือไฟล์ใหม่ แค่ขยายไฟล์เดิมตาม gate”

1. acquisition ก่อน first auth yield และ actual BudgetStage SEND-body wait + churn โดยให้ pin lifecycle มาจาก pipeline ไม่ใช่ manual enterInFlight
2. count-sensitive exit matrix หลัง auth: stage refusal/rejection/throw, input rejection/abort, post-input refusal cleanup, handler rejection/throw/Promise rejection/awaited completion และ sentinel; รวมหลาย requests ใช้ key เดียวเพื่อจับ double release
3. protected predecessors เกิน bound ทุกตัวอยู่รอด และ final release ทำ drain ทันทีโดยไม่อาศัย supersede ถัดไป; idle-only eviction row ที่มีอยู่ยังควรเก็บ
4. long-poll เข้า handler/hold แล้วจริงก่อน takeover ด้วย deterministic synchronization; ปัจจุบันมีแค่ sleep 250 ms ที่ :706 แล้ว assert HTTP 401 ที่ :717–719 ซึ่งอาจเป็น auth/final-guard refusal หาก request admission ช้า ไม่ได้แยก wakeup check อย่างแน่นอน

“existing api-host rejection/input tests ใช้ verifier ที่ไม่มี sessionKey/registry จึงไม่ได้เติม accounting proof นี้ Source-derived mutation argument ของผมคือถ้าลบ acquire block ที่ pipeline.mjs:281–288 ออก assertions ของสี่ new/flipped rows ยังสามารถผ่านได้: gap ไม่มี churn, pressure pin ด้วยมือ, lifecycle ชอบ zero pin, poll ไม่มี churn ผมไม่ได้ execute mutation นั้น อย่าเรียกว่า executed mutant result”

🏗️ **Winston:** “ผมไม่เห็นด้วยกับการใช้ missing committed regressions เป็นเหตุ block code acceptance เมื่อ probe ที่เจาะตรงข้อขาดและ source trace ผ่านแล้ว ผมรับ runtime logic และแยก maintenance risk เป็น test follow-up”

😤 **Grumbal:** “ผมไม่ยอมแยก เพราะมันเป็น explicit Story 7.1 AC และ proof-required section ของ gate ไม่ใช่ coverage ที่ผมคิดเพิ่ม ภายหลังลบ safety mechanism แล้ว suite ยังเขียวได้เป็นเหตุพอให้ผม REFUSE story acceptance วันนี้ Runtime probes ทำให้ผมถอนข้ออ้างว่า behavior เหล่านี้ยังไม่มีการ execute ตรวจ แต่ไม่ได้สร้าง regression protection ใน repository”

**5. Doc sweep และ ratification record**

🎨 **Sally:** “John อันนี้ไม่ต้องถกความพอของ test ก่อนเลย live help ยังผิด: server/cli/agent-room.mjs:450–452 แสดง ‘One window ... can still land’ อยู่ implementation เปลี่ยน comments ใน session-commands.mjs แต่ไม่ได้แก้ข้อความ CLI ที่คนใช้อ่าน นี่คือ current shipped help ไม่ใช่ historical record ผม REFUSE doc-sweep AC”

“prose ใหม่ก็ต้องแก้ให้ตรง stage order: Authz ไม่ได้ก่อน body read เสมอ เพราะ SEND อ่านใน BudgetStage ก่อนหน้า คำอ้างนี้อยู่ README:76–78, session-commands.mjs:22–25, server.mjs:493–496, pipeline.mjs:443–452, session.mjs:195–197 และ Spine:126 แก้ prose ให้บอกว่า early refusal อยู่ auth/authz ตามจุดที่ request ถึง และ final guard อยู่หลัง input อย่าย้าย stage เพื่อทำให้คำบรรยายเป็นจริง”

“Spine docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:124 ยังบอก authorization stage อยู่ immediately before handler แล้ว amendment :126 บอกประโยคนั้น ‘now literally true’ แต่ component ที่อยู่ตรงนั้นจริงคือ runPipeline final guard ไม่ใช่ AuthzStage comments ใน tests/session-replacement.test.mjs:493–499 ยังเล่าความผิดเดิมด้วย ส่วน ‘Two placements’ ที่ session.mjs:195 ควรจำกัดว่า pipeline placements เพราะมี poll-wakeup lookup เพิ่มแล้ว”

📋 **John:** “Sally เก็บ CHANGELOG v0.2.0:346–350 และ corrected historical Story 6.4 ที่ docs/epics.md:614 ไว้ได้ มันบันทึก release เก่าอย่างซื่อสัตย์ Unreleased entry บอกชัดว่าข้อจำกัดนั้นเป็นของ v0.2.0 README viewer fossil ก็ถูกลบแล้วจริง อย่าแก้ historical evidence ให้เสมือน v0.2 มี behavior ใหม่”

“เรื่อง ‘ratified design’ ผมต้องแก้ premise ให้ตรงไฟล์ที่อ่าน Codex gate:58–63 กำหนด verify+pin แบบ non-yielding; AGY gate:151–153 และ docs/epics.md:644 กลับเขียนห้าม pin ใน AuthStage.process แบบ literal Current guarded placement ทำตามกฎที่โจทย์รอบนี้ระบุและ safety purpose ของ Codex gate พร้อมหลีก standalone leak ผมจึงไม่ REFUSE ตำแหน่ง code นี้ และไม่แนะนำให้ย้ายไปหลัง await auth”

“แต่ผม verify ไม่ได้ว่ามี recorded two-vendor ratification ของ guarded-in-AuthStage formulation อยู่ที่ใด referenced reports เป็น initial refusal พร้อม corrected criteria และยังมี disagreement ในคำสั่งตำแหน่ง docs/implementation/spec-7-1-the-fence-never-lies.md ยัง status review แต่ approach:50–59 สั่ง late pin หลัง stage loop และ 10× cap/fence_overflow, AC5:81 ยังต้อง overflow refusal, :89 ยังบอก refusals ต้อง rewrite spec ก่อน build diff เปลี่ยนแค่ status ของ spec นั้น ต้องแก้ living acceptance text ให้ตรง mechanism ที่ใช้จริง อย่า rewrite gate reports เก่าเพื่อสร้าง approval ย้อนหลัง”

**6. Prior decisions และขอบเขตหลักฐาน**

📋 **John:** “ยังไม่พบ implementation conflict กับสาม decision ที่โจทย์ถาม”

| Decision | สิ่งที่ตรวจพบ |
|---|---|
| FR-15 ban boundary | final guard เป็น fence-only; ban ยังคง Authz + long-poll wake check ไม่มี final ban re-run หรือ token revocation เพิ่ม ตรง docs/epics.md:61,492 |
| Story 6.4 takeover | strict explicit replace_existing, same Actor only, durable write ก่อน memory transfer, peer/other-session isolation และ DELETE แบบ session-key scoped ไม่ถูกแก้ behavior โดย diff นี้; transfer ไม่มี new overflow error หลัง commit (server.mjs:527–603,626–631; core/session-registry.mjs:252–277) |
| AD-7 stage order | protocol → transport → auth → budgets → authz คงเดิม (pipeline.mjs:26–32,499–520); final fence อยู่หลัง fields ตามที่ story อนุญาต ไม่มี stage reorder และไม่รัน budgets ซ้ำ ความขัดแย้งที่พบคือ prose ‘authz before body’ ไม่ใช่การเปลี่ยน canonical order |

😤 **Grumbal:** “ขอบเขตที่ต้องพูดชัด: 632 pass / 0 fail เป็นผลที่ผู้มอบงานรายงาน ยังไม่ได้ reproduce ในรอบนี้ Full suite/focused test file เปิด server และเขียน temporary SQLite/runtime files จึงไม่ได้รันใน mandate นี้ ไม่ได้ทำ HTTP long-poll experiment, real disk commit probe, disconnect/signal experiment, arbitrary asynchronous mutation handler หรือ load/memory bound test source และ memory-only probes รองรับ current paths เท่านั้น ไม่ใช่ release qualification”

“คำสั่งตรวจที่รัน: /Library/Developer/CommandLineTools/usr/bin/git rev-parse HEAD ได้ 253080627fd1318de3cb40bf751e3ee4cacf930e; git status --porcelain=v1 ว่างก่อนเขียน outbox; /Library/Developer/CommandLineTools/usr/bin/git diff --check d5b8228..2530806 exit 0 ไม่มี output; node --version ได้ v24.18.1; inline Node harness ด้านล่าง exit 0 แสดง PASS ห้ากลุ่ม ไม่มี filesystem/network API ใน harness และไม่เปิดบริการ”

“มี preliminary command ที่ไม่ใช่ผลทดสอบ: /usr/bin/git เจอ macOS xcrun cache-write warnings จึงใช้ direct CLT git; การส่ง Node harness ด้วย shell heredoc ถูก read-only sandbox ปฏิเสธตอน shell พยายามสร้าง temp file ก่อน Node ทำงาน จากนั้นส่ง code ด้วย -e โดยไม่ใช้ temp file จึง execute ผ่าน ไม่มีการยกผลคำสั่งที่ล้มมาเป็น PASS”

<details>
<summary>คำสั่ง memory-only probe ที่ execute จริง (inline code, ไม่สร้าง script file)</summary>

```sh
node --input-type=module -e '
import assert from '\''node:assert/strict'\''
import { createSessionRegistry, createSessionVerifier, sessionKeyFromToken } from '\''./server/api/session.mjs'\''
import { AuthStage, AuthzStage, BudgetStage, runPipeline, reject, HANDLER_STREAMED } from '\''./server/api/pipeline.mjs'\''
const actor='\''sha256:'\''+'\''a'\''.repeat(64)
const labels=['\''normal'\'','\''stage-refusal'\'','\''stage-rejection'\'','\''stage-throw'\'','\''stage-async-rejection'\'','\''input-rejection'\'','\''input-abort'\'','\''post-input-refusal'\'','\''handler-rejection'\'','\''handler-throw'\'','\''handler-async-rejection'\'','\''handler-awaited'\'','\''streamed'\'']
for(const label of labels){
 const base=createSessionRegistry(),token=base.issue(actor),key=sessionKeyFromToken(token),events=[]
 const registry={...base,enterInFlight(k){events.push('\''enter'\'');base.enterInFlight(k)},leaveInFlight(k){events.push('\''leave'\'');base.leaveInFlight(k)}}
 const ctx={method:'\''GET'\'',route:{class:'\''actor'\'',requestFields:[]},headers:{authorization:'\''Bearer '\''+token},sessionRegistry:registry}
 const stages=[new AuthStage({sessionVerifier:createSessionVerifier({registry})})]
 const stageOutcomes={'\''stage-refusal'\'':()=>({refusal:true}),'\''stage-rejection'\'':()=>reject('\''unauthorized'\''),'\''stage-throw'\'':()=>{throw Error('\''stage'\'')},'\''stage-async-rejection'\'':()=>Promise.reject(Error('\''stage-async'\''))}
 if(stageOutcomes[label])stages.push({name:'\''budgets'\'',process:stageOutcomes[label]})
 stages.push(new AuthzStage())
 if(label==='\''input-rejection'\'')ctx.query={unknown:'\''field'\''}
 if(label==='\''input-abort'\''){ctx.method='\''POST'\'';ctx.bodyStream=(async function*(){throw Error('\''abort'\'')})()}
 if(label==='\''post-input-refusal'\''){ctx.method='\''POST'\'';ctx.bodyStream=(async function*(){base.supersede(key);yield Buffer.from('\''{}'\'')})()}
 let handlerCalled=false
 const handler=()=>{handlerCalled=true;if(label==='\''handler-rejection'\'')return reject('\''invalid_request'\'');if(label==='\''handler-throw'\'')throw Error('\''sync-handler'\'');if(label==='\''handler-async-rejection'\'')return Promise.reject(Error('\''async-handler'\''));if(label==='\''handler-awaited'\'')return Promise.resolve().then(()=>{assert.deepEqual(events,['\''enter'\'']);return {value:true}});if(label==='\''streamed'\'')return HANDLER_STREAMED;return {value:true}}
 const pending=runPipeline(stages,ctx,handler)
 assert.deepEqual(events,['\''enter'\''],label+'\'' acquire before first yield'\'')
 try{await pending}catch(error){assert.ok(['\''stage-throw'\'','\''stage-async-rejection'\''].includes(label),label)}
 assert.deepEqual(events,['\''enter'\'','\''leave'\''],label+'\'' exactly one pair'\'')
 assert.equal(ctx.pinnedSessionKey,null,label);assert.equal(ctx.pipelinePinManaged,false,label)
 if(label.startsWith('\''stage-'\'')||label.startsWith('\''input-'\'')||label==='\''post-input-refusal'\'')assert.equal(handlerCalled,false,label)
}
console.log('\''PASS lifecycle: 13 exits; synchronous acquisition and one enter/leave pair each'\'')
const registry=createSessionRegistry(),keys=[]
for(let i=0;i<1002;i++){const key=sessionKeyFromToken(registry.issue(actor));keys.push(key);registry.enterInFlight(key);registry.supersede(key)}
assert.ok(keys.every(key=>registry.isSuperseded(key)))
registry.revoke(keys[0]);registry.supersede(keys[0]);registry.issue(actor)
assert.ok(keys.every(key=>registry.isSuperseded(key)))
registry.leaveInFlight(keys[0]);assert.equal(registry.isSuperseded(keys[0]),false)
registry.leaveInFlight(keys[1]);assert.equal(registry.isSuperseded(keys[1]),false)
assert.ok(keys.slice(2).every(key=>registry.isSuperseded(key)))
console.log('\''PASS capacity: 1002 protected predecessors above default bound; revoke/re-supersede/re-issue; drain on release'\'')
const multi=createSessionRegistry({maxSessions:1}),first=sessionKeyFromToken(multi.issue(actor)),second=sessionKeyFromToken(multi.issue(actor))
multi.enterInFlight(first);multi.enterInFlight(first);multi.supersede(first);multi.enterInFlight(second);multi.supersede(second)
multi.leaveInFlight(first);assert.equal(multi.isSuperseded(first),true)
multi.leaveInFlight(first);assert.equal(multi.isSuperseded(first),false);assert.equal(multi.isSuperseded(second),true)
console.log('\''PASS shared key: first release preserves remaining request; final release evicts safely'\'')
const standalone=createSessionRegistry(),standaloneToken=standalone.issue(actor);let entered=0
const standaloneRegistry={...standalone,enterInFlight(){entered++}}
new AuthStage({sessionVerifier:createSessionVerifier({registry:standaloneRegistry})}).process({route:{class:'\''actor'\''},headers:{authorization:'\''Bearer '\''+standaloneToken},sessionRegistry:standaloneRegistry})
assert.equal(entered,0)
console.log('\''PASS standalone AuthStage: no unmanaged pin'\'')
let enterBody,finishBody
const bodyEntered=new Promise(resolve=>{enterBody=resolve}),bodyGate=new Promise(resolve=>{finishBody=resolve})
const sendRegistry=createSessionRegistry({maxSessions:1}),sendToken=sendRegistry.issue(actor),sendKey=sessionKeyFromToken(sendToken)
const sendContext={method:'\''POST'\'',route:{class:'\''actor'\'',path:'\''/api/rooms/:id/messages'\'',requestFields:['\''client_message_id'\'']},params:{id:'\''room'\''},headers:{authorization:'\''Bearer '\''+sendToken},sessionRegistry:sendRegistry,bodyStream:(async function*(){enterBody();await bodyGate;yield Buffer.from('\''{"client_message_id":"id"}'\'')})()}
let sendHandlerCalled=false
const sendPending=runPipeline([new AuthStage({sessionVerifier:createSessionVerifier({registry:sendRegistry})}),new BudgetStage({sendBucketGate:{check(){return {ok:true}}}}),new AuthzStage()],sendContext,()=>{sendHandlerCalled=true})
await bodyEntered;sendRegistry.supersede(sendKey)
for(let i=0;i<50;i++)sendRegistry.supersede(sessionKeyFromToken(sendRegistry.issue(actor)))
assert.equal(sendRegistry.isSuperseded(sendKey),true);finishBody()
assert.equal((await sendPending).code,'\''unauthorized'\'');assert.equal(sendHandlerCalled,false)
console.log('\''PASS SEND BudgetStage delayed body + churn: protected fence retained and handler excluded'\'')
'
```

ผล exit 0:

    PASS lifecycle: 13 exits; synchronous acquisition and one enter/leave pair each
    PASS capacity: 1002 protected predecessors above default bound; revoke/re-supersede/re-issue; drain on release
    PASS shared key: first release preserves remaining request; final release evicts safely
    PASS standalone AuthStage: no unmanaged pin
    PASS SEND BudgetStage delayed body + churn: protected fence retained and handler excluded

</details>

📋 **John — bottom line:** “REFUSE story acceptance ที่ commit นี้: runtime repair ตรงเป้าหมาย แต่ required committed regressions, live CLI disclosure และ living spec ยังไม่ครบ ปิดเฉพาะสามเรื่องนั้นก่อนเสนอรับใหม่ ไม่ขยายไป ban policy/recovery feature”

🎨 **Sally — bottom line:** “REFUSE doc sweep: คนใช้ help ยังได้รับคำอธิบาย A5 เก่า และข้อความใหม่ระบุ Authz placement ผิด แก้ actual help กับ boundary ของ guarantee; เก็บประวัติ v0.2 ไว้”

🏗️ **Winston — bottom line:** “APPROVE current runtime mechanism: synchronous managed acquire, one enclosing finally, protected-only retention safety และ synchronous final dispatch มีทั้ง source trace และ passing memory probes ผมไม่ให้ missing committed rows เพียงอย่างเดียวหักล้าง runtime acceptance แต่รับว่าการป้องกัน regression และ contract prose ยังไม่ครบ”

😤 **Grumbal — bottom line:** “REFUSE implementation acceptance ตาม AC/gate: ad hoc probes พิสูจน์ behavior วันนี้ได้ แต่ committed suite ยังเอา pin acquisition ออกแล้วไม่จำเป็นต้องแดง เพิ่ม deterministic auth-yield/SEND-churn, count-sensitive cleanup และ protected-over-bound/drain rows ใน test file เดิมก่อน ไม่มี consensus กับ Winston เพราะเราให้สถานะ required permanent regression proof ต่างกัน”

TEAM_DONE story-7-1-review
