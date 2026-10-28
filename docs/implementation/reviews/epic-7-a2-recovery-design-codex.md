บันทึก REFUSAL สำหรับ automatic unattended recovery ตาม 4 candidate ปัจจุบัน — คง `agent-room session replace` เป็นทาง recovery ที่รองรับ

Task: a2-recovery-design-codex3 | วันที่ 2026-10-28 | Advisory / READ-ONLY
อ่าน working tree ที่ HEAD `45d1aa87c1d983a552e530cf7dabd8d93b8d9af5` ไม่ได้แก้ implementation, schema, นโยบาย, commit หรือสถานะบริการ ข้อเสนอของผู้บันทึกคือ reasoned refusal สำหรับ Story 7.4 รอบนี้ ไม่ใช่มติว่าห้าม delegated recovery ตลอดไป ความขัดแย้งเรื่องนโยบายและความคุ้มค่ายังคงอยู่

Outcome: ตัดสิน evidence/trust/consent/replay ของ 4 candidate; non-goals: ไม่มี prototype หรือ implementation; files: outbox นี้หนึ่งไฟล์; proof: source และ test bodies ปัจจุบัน พร้อม primary OS/Node sources และการตรวจชนิดไฟล์/terminal marker หลังเขียน ชื่อ outbox ยึด task-id binding ตอนต้นเป็น `.mailbox-out/a2-recovery-design-codex3`; ท้าย brief มีชื่อ `...-codex` ที่ขัดกัน จึงไม่สร้างไฟล์ที่สอง

ใช้ bmad-party-mode พร้อม 📋 John — PM ผู้คุมขอบเขต, 🎨 Sally — UX และสิทธิของ operator, 🏗️ Winston — สถาปัตยกรรมและ concurrency, 🔒 Vex — security/authority reviewer อ่าน skill และ persona defaults จริง Project `_bmad` resolver/config ไม่มี จึงใช้ explicit cast; ไม่มีการบันทึก party memory หรือ keepsake ผู้เชี่ยวชาญแยกกันตรวจ socket, current session surface และ consent ก่อนนำข้อโต้แย้งมาเข้าห้องนี้

**1. Story 7.3 เปลี่ยนอะไร — และ premise ใดต้องแก้ก่อน**

📋 **John:** “Sally, action A2 ไม่ได้สั่งให้สร้าง resume subsystem มันบันทึกว่าการหาผู้สืบทอดต้องใช้หลักฐานที่ Actor key ให้ไม่ได้ และ explicit takeover เป็นทางที่รองรับ Story 7.4 อนุญาต refusal เป็น baseline และห้าม pre-commit mechanism/schema/implementation ผมจึงต้องเห็นประโยชน์ที่มากกว่าการลดคำสั่ง recovery หนึ่งครั้งก่อนรับต้นทุนถาวร” หลักฐาน: `docs/implementation/epic-6-retro-2026-10-21.md:254,312–315`; `docs/epics.md:672–680`

🎨 **Sally:** “John, เครื่องที่ไม่มีคนเฝ้าหลังไฟดับกดคำสั่งเองไม่ได้ ความถี่ที่ลดลงไม่ทำให้ unattended requirement หายไป ฉันยอมรับว่าโจทย์นี้ไม่บังคับให้สร้าง แต่ไม่ยอมให้คำว่า rare แทนข้อมูลเหตุการณ์ เราไม่มีอัตรา crash หลัง 7.3 ที่วัดจริง”

🏗️ **Winston:** “ขอแก้ premise ‘ONLY four scenarios’ ก่อน 7.3 เป็น bounded best-effort shutdown ไม่ใช่รับประกันว่า DELETE สำเร็จทุกครั้ง แม้ SIGTERM ปกติ ถ้า release ถูก blackhole หรือคำตอบช้าเกิน budget ก็ออกโดยชื่อยังค้างได้ ตัว test ที่มีอยู่ตั้งใจตรวจกรณีนี้และคาด 409 หลัง child ออก การตรวจ test body ไม่ใช่การรันทดสอบใหม่” หลักฐาน: `docs/epics.md:668–670`; `server/mcp-stdio.mjs:470–505`; `tests/session-replacement.test.mjs:1377–1407`

🔒 **Vex:** “และมีข้อจำกัดจาก source ที่ต้องพูดตรง ๆ: rollback DELETE คืน false เมื่อผิดพลาด แต่ release รอ promise แล้วรายงาน released:true โดยไม่อ่านค่านั้น ดังนั้นข้อความ released ในเส้นทาง pending bind ไม่ใช่หลักฐาน server acknowledgement ทุกกรณี ฉันไม่ได้เปิด Story 7.3 ใหม่หรือเสนอแก้ไฟล์ในงานนี้ เพียงไม่ใช้สถานะ DONE กลบความไม่แน่นอน” หลักฐาน: `server/client/api-client.mjs:477–479,533–537`; ยังไม่ได้ runtime-reproduce กรณี rollback ล้มเหลวนี้

🏗️ **Winston:** “Topology ก็มีผล: session-token registry กับ live-holder registry อยู่ใน memory และ durable chat_id_claims ไม่ได้ restore holder หลัง room server restart เพราะฉะนั้น power loss ทั้งเครื่องใน Local Mode ที่ client/server อยู่ด้วยกันไม่ทิ้ง live-token ghost เดิมเมื่อ server เริ่มใหม่ ข้อนี้เป็น inference จาก source; ไฟดับเฉพาะ client ใน Remote Mode ที่ server ยังอยู่จึงเป็นกรณีค้างสำคัญ” หลักฐาน: `server/api/session.mjs:11–14,58–59`; `server/core/session-registry.mjs:56–60,157–161`; `server/api/server.mjs:1440–1443`

📋 **John:** “ดังนั้น 7.3 ทำให้ refusal แข็งขึ้นในเชิงต้นทุน: ปิดเส้นทาง teardown ที่ป้องกันได้บ่อยตามประวัติแล้ว แต่ฉันไม่อ้างว่าพิสูจน์อัตราล้มเหลวใหม่หรือกำจัด release-unknown ทั้งหมด”

🎨 **Sally:** “ฉันยังไม่รับข้อสรุปเรื่องความคุ้มค่า สำหรับ installation ที่ต้องกลับมาเอง residual เหล่านี้คือ requirement หลัก ไม่ใช่เหตุผลให้ต้องมีคนเฝ้าตลอด ความต่างของเราคือ product target ที่ควรลงทุน ไม่ใช่จำนวน signal ที่จับได้”

**2. สี่ candidate — คำตัดสินตามเกณฑ์ปัจจุบัน**

🔒 **Vex:** “John, ใช้ตารางนี้เป็นคำตัดสินต่อ candidate ตามที่เสนอ ไม่มี PASS แบบมีเงื่อนไขที่ซ่อนงานออกแบบไว้ข้างหลัง”

| Candidate | คำตัดสิน | เหตุผลที่ไม่ผ่าน |
|---|---|---|
| 1. Disk-only one-time recovery secret ใน PLUGIN_DATA | **FAIL** | สอง live tabs อ่าน keypair และ secret เดียวกันได้ One-use เลือกผู้ชนะการแข่ง ไม่ได้พิสูจน์ว่า incumbent ตายหรือผู้ชนะเป็น successor ที่ได้รับสิทธิ |
| 2. node:net UDS + server-bound one-time recovery ticket | **FAIL ตามแบบที่เสนอ** | ECONNREFUSED ไม่ใช่ death proof บน macOS; reusable pathname มี stale-unlink race; server ไม่ได้เห็น kernel และ ticket ไม่ยืนยันว่าตรวจ socket จริง Crash/replay/rotation ยังไม่มี contract ครบ |
| 3. Shortened lease TTL + background heartbeat | **FAIL — ยืนยัน refusal เดิม** | idle/sleep/partition/live-but-paused เกิน TTL ไม่เท่ากับตาย Heartbeat เปลี่ยนนโยบายเป็นต่ออายุชื่อเพื่อคงสิทธิ และยังมีช่วงค้างหลังตาย |
| 4. Self-reported PID/boot-id/process lineage | **FAIL — ยืนยัน refusal เดิม** | server ตรวจ process บน remote host ไม่ได้ PID reuse, namespace/host ambiguity และผู้ถือ Actor key ลงชื่อคำกล่าวที่ไม่จริงได้ |

🎨 **Sally:** “Vex, ฉันเคยชอบ one-time secret เพราะมันไม่ใช่ old bearer ที่คืนชีพ แต่ยอมรับข้อหักล้าง: Tab 1 ยังทำงาน Tab 2 อ่านไฟล์เดียวกันแล้วใช้ secret ได้ทันที ต่อให้ consume แบบ atomic และแยก authentication ก็ยังขโมยชื่อจาก live tab ได้ การลบไฟล์หลังอ่านเปลี่ยนเพียงว่าใครอ่านก่อน”

🔒 **Vex:** “ถูกต้อง และ 0600/0700 ป้องกันผู้ใช้อื่นตาม OS boundary ไม่ได้แยกสอง process ของ user เดียวกัน ไม่ว่าชื่อ credential จะเป็น secret, asymmetric resume key หรือ ratchet ก็ต้องแก้ co-tenancy ต่างหาก” หลักฐาน candidate เดิม: `docs/implementation/reviews/epic-7-design-gate-agy.md:232–243`; แยก identity/death/succession/consent: `docs/implementation/reviews/epic-7-design-gate-codex.md:98–116`

🏗️ **Winston:** “ฉันไม่ยอมปัด socket ทิ้งเหมือน disk-only: ขณะ socket ที่ผูกกับ incumbent ถูกต้องและ listener รับ connection ได้ มันเพิ่ม local observation ที่ไฟล์ล้วนให้ไม่ได้ แต่ observation นั้นยังไม่ใช่ ownership proof ครบวงจร”

🔒 **Vex:** “ส่วน lease อย่าอ้างเลขบรรทัดจาก brief แทนอ่าน ruling จริง: เหตุผลอยู่ที่ `epic-6-lease-astra.md:33–45,59–63` — silence เป็น policy ไม่ใช่ death และ MCP มีช่องว่าง generation ที่ถูกต้องตามปกติ Timer ใน background ช่วย renew ระหว่าง idle ถ้าเครื่องยังเดิน แต่ไม่ช่วย sleep, SIGSTOP หรือ partition หาก expiry แล้วให้ reclaim ก็ยัง silent-displace process ที่มีชีวิต ถ้า expiry แล้วไม่ให้ reclaim ก็ไม่ได้แก้โจทย์ ฉันไม่ overturn ruling นี้”

📋 **John:** “อย่าสับสนกับ heartbeat สำหรับ presence หรือ TTL credential เดิม เราไม่เปลี่ยนค่าเหล่านั้นในรอบนี้ และไม่ยกการหมดอายุ credential ตามนโยบายเดิมเป็นหลักฐานว่าคนถือ process ตาย”

🏗️ **Winston:** “PID/boot-id ก็เช่นกัน boot-id ช่วยลดการชน PID ได้ใน host ที่เชื่อถือ แต่ลายเซ็น Actor ยืนยันคนกล่าว ไม่ยืนยันข้อเท็จจริงจาก kernel มันตรวจ remote lineage ไม่ได้ Trusted host supervisor จะเป็นอีก trust model หนึ่ง ไม่ใช่ PASS ให้ self-report”

**3. Candidate 2 — ถกประเด็น kernel, races และต้นทุนให้ครบ**

🏗️ **Winston:** “Vex, ข้อเสนอใน agy gate คือ probe → ถ้า ECONNREFUSED ให้ unlink → bind socket ใหม่ → อ่าน ticket → POST /api/session (`epic-7-design-gate-agy.md:245–257`) อย่างน้อย connect success ต้องถือ LIVE ทันที อย่าเพิ่ม app handshake แล้วใช้ timeout เป็น death; kernel อาจ connect สำเร็จขณะ JS ถูก SIGSTOP หรือ event loop ค้าง”

🔒 **Vex:** “แต่คำว่า ‘ECONNREFUSED คือ OS death certificate’ ใน brief/epic ผิดเกินกว่าจะใช้เป็นสมมติฐาน Apple XNU `unp_connect` คืน ECONNREFUSED ได้เมื่อ listener ยังอยู่แต่ `sonewconn` สร้าง connection ใหม่ไม่ได้ และ `sonewconn_internal` คืน NULL ได้เมื่อ queue เต็มหรือ memory allocation ถูกปฏิเสธ ดังนั้น Tab 1 ที่ยังมีชีวิตและหยุด drain queue อาจผ่านเงื่อนไข ‘ตาย’ ของ Tab 2 ได้ นี่เป็นข้อหักล้างจาก source ไม่ใช่ผล probe บนเครื่องนี้” Primary sources: [Apple XNU unp_connect](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c#L1334), [Apple XNU connection allocation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_socket2.c#L338).

🏗️ **Winston:** “ยอมรับว่าเพิ่ม backlog ไม่เปลี่ยนข้อพิสูจน์ ต้องแยกให้ถูก: SIGSTOP อย่างเดียวไม่ปิด socket; ถ้า queue ยังว่าง connect อาจสำเร็จ ปัญหาคือการตีความ timeout หรือ refusal เป็นตายเมื่อ resource/queue state ยังทำให้เกิดได้ การ retry หลายครั้งก็ไม่พิสูจน์ว่ากระบวนการหยุดอยู่นานไม่ได้”

🔒 **Vex:** “อีก counterexample ไม่ต้องมีผู้โจมตี: หลัง incumbent เดิม crash ให้ A กับ B เริ่มพร้อมกัน แบบ reusable shared pathname เกิดลำดับนี้ได้”

1. A และ B ต่างเห็น socket เดิม ECONNREFUSED; B หยุดรอก่อน unlink
2. A unlink ของเก่า, bind ที่ pathname เดิม และ recover สำเร็จ A ยังมีชีวิต
3. B กลับมาทำ stale unlink ลบ pathname ของ A แล้ว bind ของ B ได้ Descriptor ของ A ยังอยู่ แต่ pathname ไม่ชี้ A แล้ว
4. ถ้าแบบใช้งานซ้ำออก/เก็บ ticket รุ่นใหม่ t1 ให้ A, B ที่อ่านไฟล์หลัง bind อาจได้ t1 และแทนที่ live A โดยไม่มีความยินยอมของ A
5. ถ้าเป็น ticket ครั้งเดียวตลอดไปและไม่มี t1, server CAS อาจปฏิเสธ t0 ของ B ได้ แต่ local liveness association ถูกทำลายแล้ว และยังไม่มีคำตอบเรื่อง crash ครั้งถัดไป

🔒 **Vex:** “ข้อ 4 เป็น counterexample แบบมีเงื่อนไขต่อ reusable design; การออก t1 ยังไม่ได้ระบุไว้ครบใน candidate ไม่ใช่พฤติกรรมที่โค้ดปัจจุบันทำ ฉันไม่แอบอ้างว่ามี implementation นี้ ความไม่ครบเรื่อง rotation เป็นเหตุให้ยัง PASS ไม่ได้ ไม่ใช่ใบอนุญาตให้สมมติว่าทุกอย่างปลอดภัย”

🏗️ **Winston:** “ฉันยังคัดค้านการสรุปว่า socket ทุกแบบเป็นไปไม่ได้ Immutable unique path ต่อ incarnation, ไม่ reuse/unlink path ของอีก generation, bind successor ก่อนให้ ticket และหยุดผู้แพ้ไม่ให้หยิบ ticket ใหม่ จะตัด stale-unlink trace นี้ได้ นั่นเป็นทางออกของ race ที่ควรยอมรับ แต่ไม่ได้แก้ macOS false-refusal หรือทำให้ remote server เห็น kernel ดังนั้นฉันยังไม่ให้ PASS แบบแก้เล็กน้อย”

🎨 **Sally:** “แล้วประเด็น deploy ที่ operator ต้องเจอล่ะ?”

🏗️ **Winston:** “ครบทุกข้อใน brief ดังนี้: macOS มี `sun_path[104]` และ Node 24 ระบุ path limit ที่ใช้ได้ทั่วไป 103 bytes; ต้องคิดเป็น bytes ของ path ทั้งเส้น ไม่ใช่จำนวนตัวอักษร Deep PLUGIN_DATA อาจ bind ไม่ได้ การ reject/fallback อย่างปลอดภัยเป็น availability limitation ไม่ใช่หลักฐานว่าตาย Hash แค่ basename ไม่ทำให้ parent path สั้น และย้ายไป short runtime directory เป็น design/scope เพิ่มที่ต้องกำหนด owner-only กับ namespace ให้ชัด เราไม่ได้เลือกทางนั้นในรอบนี้” Primary sources: [Node 24 IPC documentation](https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/net.md), [Apple sockaddr_un](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h#L74).

🔒 **Vex:** “Container rebuild ที่เก็บ keypair แต่ล้าง runtime files ต้องได้ UNKNOWN แล้วใช้ explicit takeover ไม่ใช่ ENOENT = dead แม้ ticket รอดมากับ volume ก็ไม่ได้แปลว่า socket จาก namespace นี้เคยเป็นของ incumbent อีกเครื่องที่ใช้ copied keypair ก็เหมือนกัน local-only เป็นขอบเขต safety ที่ดีได้เมื่อระบุชัด แต่แก้ cross-machine recovery ไม่ได้ และอย่าอ้างว่าตรวจ host identity ได้จากไฟล์ที่ copy มาพร้อมกัน”

🏗️ **Winston:** “Node เองอธิบายว่า crash อาจทิ้ง socket pathname จนกว่าจะ unlink; server.close ตามปกติอาจ unlink ให้ ส่วน Linux abstract socket เป็น Linux-specific ไม่ใช่ทางแก้ macOS โดยปริยาย ไม่มี error code ที่ไม่เข้าใจแล้วอนุญาต takeover ได้” หลักฐาน: [Node 24 IPC lifecycle](https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/net.md).

📋 **John:** “ค่าใช้จ่ายคือ listener อีกตัวในทุก MCP child รวม bind/cleanup/shutdown/concurrent start และ path handling ปัจจุบัน supported path เป็น stdio→HTTP(S); roomd UDS เป็น legacy ที่ retired ไม่ใช่ listener ซึ่ง child มีอยู่แล้ว” หลักฐาน: `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:28`; `server/runtime.mjs:124–128`; `server/client/api-client.mjs:204–212`

🏗️ **Winston:** “John, เรียกให้แม่น: peer-liveness socket ไม่ได้ฟื้น roomd API transport ถ้าส่งเพียง liveness เราไม่ควรตีราคาเท่าระบบ daemon เดิมทั้งชุด แต่ก็เป็น IPC/lifecycle surface เพิ่มจริง และ zero npm dependencies ไม่ได้แปลว่า zero complexity”

**4. Consent, trust boundary, server surface และ replay/crash**

🎨 **Sally:** “Vex, ฉันเสนอคำตัดสินนโยบายชัด ๆ: narrow PRIOR DELEGATION เป็น NEW policy ที่ ratify ได้ คนมีสิทธิอนุญาต named trusted supervisor ให้ตัดสิน recovery ภายหลัง ไม่จำเป็นทางตรรกะว่าต้องถามใหม่ทุกครั้ง แต่ grant ให้ supervisor ไม่ใช่ grant ให้ทุก tab ที่อ่าน PLUGIN_DATA ได้ และไม่ใช่หลักฐานว่าผู้ถือเดิมตาย”

🔒 **Vex:** “ฉันไม่เห็นด้วยที่จะ ratify ตอนนี้ สี่ candidate นี้ยังไม่มี supervisor ที่ enforce single owner พร้อม death evidence ได้จริง ถ้าประโยค consent ยอมให้ขับ live Tab 1 ออกได้ก็เป็นการลด Two-Tab bar ที่โจทย์ห้าม ไม่ใช่ทำให้ผ่าน ฉันยึด per-event supported contract สำหรับรอบนี้ ส่วน Sally ไม่ยอมยึดเป็นกฎตลอดไป ความขัดแย้งนี้ยังไม่จบ”

🎨 **Sally:** “บันทึกสิ่งที่ grant ต้องบอกเพื่อเป็น honest consent ต่อไปได้โดยไม่วาด schema ล่วงหน้า:”

1. ผู้ให้สิทธิ/Actor, realm/server ที่แน่นอน, public identity ของ delegate และชื่อหรือ installation slot ที่อนุญาตอย่างแคบ ไม่ใช่ทุกชื่อของ Actor
2. การกระทำที่อนุญาต, incumbent/occupancy lineage และ successor ที่เกี่ยวข้อง, supervisor คุม host/runtime/launch ใด พร้อมเกณฑ์ที่ unsupervised Tab 2 ต้องถูกปฏิเสธ
3. Trigger และกรณี UNKNOWN ที่ต้องหยุด: sleep/partition, ambiguous probe, runtime files หาย, namespace เปลี่ยน, copied state และ split-brain ระบุว่าผลจาก supervisor เป็น trusted assertion ไม่ใช่ server-witnessed death
4. เวลาเริ่ม/หมดอายุ, การ revoke/rotate และผลเมื่อ delegate หายหรือถูกขโมย ตรวจ revocation ก่อน commit; revoke ห้าม recovery ครั้งหน้า แต่ไม่ย้อน handoff ที่เกิดแล้ว
5. เวอร์ชันนโยบาย, การยอมรับอย่างชัดเจนว่าจะมี noninteractive displacement และ audit receipt ซึ่งระบุ delegate, เหตุผล, occupancy เดิม, successor และผลลัพธ์ การเปิด default หรือบอกเพียง ‘จำฉันไว้’ ไม่ใช่ consent นี้

🏗️ **Winston:** “เส้นแบ่ง proof มีสามชั้น Server ปัจจุบันพิสูจน์ bearer/Actor ตาม auth model ของมันและ holder จาก registry ของมันได้ Remote challenge ใช้ key possession; Local Mode ใช้ local token + public key ภายใต้ OS-user boundary ไม่ได้ attest process ปัจจุบัน `isLive` เป็น token existence/expiry ไม่มี PID หรือ kernel oracle” หลักฐาน: `server/api/server.mjs:296–333,355–404`; `server/api/session.mjs:144–152,208–222`

🔒 **Vex:** “ถ้ามี design ใหม่ server ต้องตรวจ authority ของ delegate, realm/Actor/name, exact incumbent occupancy/generation, intended successor, freshness/non-replay และ revocation ที่ commit boundary พร้อมรักษา foreign-Actor refusal, durable-claim-before-memory และ fence แต่ signature พิสูจน์เพียงว่า delegate ลงชื่อข้อความนี้ ไม่ใช่ว่า remote OS ตายจริง Server แยก power loss จาก partition ด้วยการไม่มี HTTP ไม่ได้; ไม่รู้ว่า claimant ตรวจ socket จริงหรือไม่; ไม่รู้ว่า socket นั้นเป็นของ incumbent บน host/namespace เดียวกัน และไม่รู้ว่า supervisor กำลังโกหกหรือถูก compromise”

🎨 **Sally:** “ฉันยอมรับ trust boundary นั้น การมอบสิทธิให้ supervisor ตัดสินไม่ต้องปลอมตัวเป็น cryptographic death proof แต่ supervisor ต้องรักษา Two-Tab exclusion จริง ต้องตอบเรื่อง reboot/split-brain/bypass launches ก่อน เราไม่มีคำตอบพร้อม ratify ในรอบนี้ ฉันยังเห็นว่าควรมี product path นี้ ส่วน Vex กับ John ยังไม่เห็นว่าคุ้มเปิดงาน”

📋 **John:** “ตอบข้อ c ให้ตรง: **ไม่มี candidate PASS จึงไม่มี endpoint, field, schema หรือ new error ที่รับรองให้เพิ่ม** Current exact surface คือ `POST /api/session {chat_id,client_type?,replace_existing?}`; `PATCH /api/session {chat_id,client_type?}` ไม่มี takeover; `DELETE /api/session` ไม่มี request fields และ release เฉพาะ authenticated session key Ordinary reconnect bind ส่งเพียง chat_id กับ client_type ไม่ส่ง replace_existing” หลักฐาน: `server/api/routes.mjs:37–39`; `server/client/api-client.mjs:470–475`; `server/api/server.mjs:620–632`

🔒 **Vex:** “หากจะกลับมารับ delegated noninteractive resume ภายหลัง ต้อง amend Spine AD-8 อย่างเปิดเผยทั้ง rule ที่ replace_existing เป็นทางเดียวในการ displace live holder, wire vocabulary และ consent/launch contract อย่า reuse flag นี้แบบเงียบ ๆ ตอน reconnect หรือใส่ takeover intent ใน DELETE รายงานนี้ไม่ได้เลือกชื่อ resume field, endpoint เพิ่ม หรือ storage layout” หลักฐาน prior rule: `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:115,124`; recorded conflict: `docs/implementation/reviews/epic-7-design-gate-agy.md:292`

🏗️ **Winston:** “ถึง candidate 2 ไม่ผ่าน ก็ต้องบันทึก replay/crash contract ที่มันยังขาด: ticket ต้องผูก exact incumbent generation และ successor ไม่ใช่ Actor/name ล้วน; consume กับ durable ownership transition ต้องมี recoverable commit point ก่อน memory transfer; response หายหลัง commit ต้อง retry ได้เฉพาะผลของ operation เดิมหรือ stable refusal ไม่ใช่ไป mint authority ขับ successor ใหม่ ถ้าตายหลัง server commit แต่ก่อน client save ticket รุ่นต่อไป ต้องยอม fail closed/manual ไม่ฟื้น ticket รุ่นเก่าหรือ old bearer เรื่อง persistence นี้ยังไม่ได้ออกแบบ/พิสูจน์ และ server ปัจจุบันไม่ได้มี durable recovery ledger”

🔒 **Vex:** “Ticket ถูกขโมยหรือ replay: ticket อย่างเดียวต้องไม่ให้ foreign Actor ผ่าน ถ้าคนขโมยมีทั้ง ticket และ Actor/delegate authority ก็เป็น authority compromise และอาจ takeover ได้ก่อนเจ้าของ ไม่ได้พิสูจน์ death; one-time ทำให้ชนะได้ครั้งเดียวต่อ ticket ไม่ป้องกัน first-use theft ถ้าจะ ratchet ต่อก็ต้องตัดอำนาจผู้แพ้ ไม่ให้ไปอ่าน ticket ใหม่จาก shared file ได้ Replay ของ generation ที่ consume แล้วต้องไม่ทำให้ชื่อย้ายอีก คำเหล่านี้เป็นเกณฑ์ที่ยังขาด ไม่ใช่ security guarantees ที่ candidate ปัจจุบันส่งมอบแล้ว”

📋 **John:** “Baseline ก็ต้องพูดตรงกัน: TTY y/yes อยู่ใน supported CLI ไม่ใช่ server proof ว่ามนุษย์ตอบ HTTP server ยอมรับ explicit replace_existing จาก authenticated same Actor จึงกัน malicious same-user process ที่เรียก API เองไม่ได้ การปฏิเสธ automatic resume รอบนี้รักษาพฤติกรรม supported clients และลด accidental displacement ไม่ได้อ้างว่าป้องกันเจ้าของ key ที่ตั้งใจฝ่าฝืนได้” หลักฐาน: `server/cli/session-commands.mjs:45–52,204–255`; `server/api/server.mjs:528–553`; `docs/implementation/spec-6-4-reconnect-recovery-takeover.md:59`

**5. Ping-pong, คำตัดสินที่ใช้ทำงานต่อ และขอบเขตการตรวจ**

🏗️ **Winston:** “Vex, server CAS และ ticket single-use ตัดสอง request ที่แข่ง occupancy เดียวกันได้ แต่ไม่ตัด infinite series ถ้าผู้แพ้ reauth แล้วมีสิทธิอ่าน/ขอ ticket ใหม่ของผู้ชนะ ทั้งสองจะผลัดกันเป็น successor ได้ ไม่มีจำนวน generation สูงสุดที่แก้ authority ผิดชนิดนี้ ต้องมี unique arbiter หรือ exclusion ที่ผู้แพ้ละเมิดไม่ได้ รวม reboot/rollback/split-brain ด้วย ฉันไม่อ้างว่า ratchet อย่างเดียวแก้ ping-pong”

🔒 **Vex:** “ใน refusal ของเรา ordinary reconnect ไม่ใส่ replacement intent จึงไม่เริ่ม autonomous war ผู้แพ้ไม่ยึดคืนด้วย reauth เอง Token เก่าถูก revoke/fence และ Story 7.1 ตรวจ fence ก่อน handler โดยคง pin ให้ request ที่ยังไม่จบ แต่ fence ห้ามใช้ authority เก่า ไม่ได้รู้ว่า successor ถูกเลือกอย่างถูกต้อง มันไม่ช่วยให้ false-dead takeover ผ่าน Two-Tab test” หลักฐาน: `server/api/server.mjs:592–603`; `server/api/session.mjs:60–113,180–205`; `server/api/pipeline.mjs:665–687`; `tests/session-replacement.test.mjs:239–261`

📋 **John:** “อย่าแต่งว่าผู้ใช้สองคนผลัด explicit takeover ไม่ได้ ปัจจุบัน last explicit intent wins มี test บันทึกไว้ (`tests/session-replacement.test.mjs:264–287`) และ Story 7.2 observed-incumbent conflict ticket ยังเป็นงานแยก (`docs/epics.md:658`) เราไม่อ้างว่า shipped แล้ว แม้มี CAS ต่อไปก็กัน stale intent ไม่ได้ห้าม fresh human decisions ที่ขัดกันทุกครั้ง คำว่า ‘ไม่มี ping-pong’ ใน refusal จึงหมายถึงไม่มีวงจร takeover อัตโนมัติจาก supported reconnect”

🎨 **Sally:** “และ `session replace` เป็น deliberate takeover แล้ว DELETE session ชั่วคราวของคำสั่ง มันไม่ได้ reserve ชื่อให้ restart process ใดเป็นพิเศษ ถ้ามีสอง tab แย่ง bind หลังคำสั่งก็ยังต้องยอมรับ collision ตามเดิม ไม่ใช่กลไกเลือก rightful successor (`server/cli/session-commands.mjs:143–178`) ฉันยังยืนยันว่า prior delegation ควร ratify ได้ในอนาคตเมื่อเจาะจง supervisor ที่รักษา exclusion ได้ John อยากปิด A2 ด้วย refusal รอบนี้แล้วเดิน 7.2 ต่อ; ฉันไม่ให้การปิดรอบนี้กลายเป็นคำปฏิเสธ unattended product requirement ถาวร”

📋 **John:** “บันทึก action ของรอบนี้: ใช้ reasoned refusal เป็นผลของ A2 สำหรับต้นไม้ที่อ่าน คง explicit takeover และไม่มีการเปลี่ยน server surface ให้เดิน Story 7.2 ตาม gate ของมันได้ ไม่ต้องเปิด implementation automatic recovery เพื่อให้ 7.4 มี deliverable การเปิด supervised design ใหม่ต้องมี named use case, authority boundary และหลักฐาน Two-Tab ที่ดีกว่าทั้งสี่ตัวนี้ Sally ยังไม่เห็นด้วยกับความคุ้มค่าที่ฉันประเมิน; บันทึกความเห็นนั้นไว้”

🔒 **Vex:** “สิ่งที่ตรวจและสิ่งที่ไม่ได้ตรวจ ต้องแยกกัน:”

1. อ่าน Story 7.4/A2, lease ruling และทั้งสอง design gates ตามคำสั่งจริง พร้อม current routes/registry/client/CLI/shutdown/test bodies หลักฐาน runtime เก่าในเอกสารเป็น document-reported ไม่ใช่ผลรันใหม่ `git rev-parse HEAD` ได้ `45d1aa87c1d983a552e530cf7dabd8d93b8d9af5` exit 0; `git status --short` เริ่มงานไม่รายงานรายการเปลี่ยน และ `git diff --exit-code -- server tests docs AGENTS.md` exit 0 ไม่มี diff ก่อนเขียน outbox แม้ git มี sandbox xcrun-cache warnings
2. ตรวจ primary Node 24 และ Apple XNU sources ผ่าน web; แก้ premise ECONNREFUSED จาก source ปัจจุบันที่อ่าน ไม่ได้ตรวจว่า published XNU revision ตรง kernel ที่ติดตั้งบนเครื่อง/ทุก host จึงไม่อ้าง runtime reproduction หรืออัตราเกิด queue-full จริง
3. ไม่ได้รัน `node --test` หรือ child/process/socket/container/remote/power-loss probe เพราะงานนี้เป็น design read-only และไม่มี implementation ให้ตรวจ ไม่สร้าง fixture, DB, socket, prototype หรือ test infrastructure และไม่อ้าง PASS ของ tests ที่เพียงอ่าน
4. ไม่ได้พิสูจน์ vendor-host teardown ทุกแบบ, release-unknown delivery, rollback-failure runtime, supervisor exclusivity, cross-machine clone detection หรือ consent ของ operator ต่อ policy ใหม่ Receipt/rotation/crash states ของ candidate 2 ยังไม่ครบ จึงไม่ให้สถานะ ratified design
5. ความเห็นจาก memory ใช้จัดรูปแบบและเตือนให้ตรวจไฟล์ปัจจุบัน; ข้อเท็จจริงที่ใช้ตัดสินอ้าง source ปัจจุบันข้างต้น Outbox เป็น write เดียวที่อนุญาต; การตรวจ flat regular file และ marker ทำหลังเขียนแยกจากการรับรอง mechanism

**แต่ละเสียงจบด้วยคำตัดสินของตัวเอง — ไม่ใช่ฉันทามติเกี่ยวกับนโยบายระยะยาว**

📋 **John — REFUSAL:** “ไม่มี candidate คุ้มพอและผ่าน bar สำหรับรอบนี้ Story 7.3 ทำให้ baseline explicit `POST /api/session` + `replace_existing` ผ่าน interactive `agent-room session replace` แข็งขึ้น รับ refusal เป็นผลของ 7.4 และปลด hold การออกแบบ 7.2 โดยไม่เพิ่ม automatic API”

🎨 **Sally — REFUSAL สำหรับ 4 mechanism ปัจจุบัน:** “ไม่มีตัวใดรักษา live Tab 1 ตามเกณฑ์ได้ครบ แต่ฉันคัดค้าน per-event confirmation เป็นกฎถาวร Narrow prior delegation ให้ named supervisor เป็น NEW policy ที่ ratify ได้ และ residual unattended restart ยังอาจคุ้มออกแบบต่อ ไม่มี server surface ใหม่ที่ฉันรับรองในรอบนี้”

🏗️ **Winston — REFUSAL ต่อ socket+ticket ตามแบบที่เสนอ:** “Local kernel observation มีประโยชน์และ immutable per-generation paths แก้ race บางส่วนได้ จึงไม่ตัดสินว่า automatic recovery ทุก design เป็นไปไม่ได้ แต่ macOS refusal ambiguity, remote assertion และ crash/rotation contract ยังไม่ผ่าน การเพิ่ม POST resume surface ตอนนี้จะข้ามข้อพิสูจน์”

🔒 **Vex — REFUSAL:** “Disk possession/expiry/self-report ไม่ใช่ rightful-successor evidence และ ECONNREFUSED ไม่ใช่ death certificate ฉันยังไม่ ratify delegated live displacement ไม่มี implicit replace ใน reconnect/release, ไม่มี foreign-Actor takeover และ durable claim ต้องมาก่อน memory transfer เสมอ New consent ไม่ลบ Two-Tab falsification bar”

TEAM_DONE a2-recovery-design-codex3
