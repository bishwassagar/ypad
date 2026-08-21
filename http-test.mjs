import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

const BASE = "http://localhost:8787";
const ROOM = `test-room-${Date.now()}`;
const TOKEN = "token-abc-123";
const TOKEN2 = "token-abc-456";

const messageSync = 0;
const messageAwareness = 1;

function frameSyncStep1(doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeSyncStep1(enc, doc);
  return encoding.toUint8Array(enc);
}

function frameSyncStep2(doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeSyncStep2(enc, doc);
  return encoding.toUint8Array(enc);
}

function frameUpdate(doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
}

function frameAwareness(awareness) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageAwareness);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.doc.clientID]));
  return encoding.toUint8Array(enc);
}

function readSync(bytes, target) {
  const dec = decoding.createDecoder(bytes);
  const type = decoding.readVarUint(dec);
  if (type !== messageSync) return { type, syncType: null };
  const syncEnc = encoding.createEncoder();
  const syncType = syncProtocol.readSyncMessage(dec, syncEnc, target, null);
  return { type, syncType, replyLen: encoding.length(syncEnc) };
}

const serverDoc = new Y.Doc();
const ytext = serverDoc.getText("content");
ytext.insert(0, "hello from server");
serverDoc.getMap("ypad").set("language", "python");

const awareness = new awarenessProtocol.Awareness(serverDoc);
awareness.setLocalState({ user: { name: "tester" } });

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`PASS ${name}${extra ? " — " + extra : ""}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const post = async (body, token = TOKEN) => {
  const res = await fetch(`${BASE}/${ROOM}?transport=http&token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  return res;
};

// 1. SSE GET streams a framed syncStep1 immediately (server state empty so far)
const sseRes = await fetch(`${BASE}/${ROOM}?transport=http&token=${TOKEN}`, { headers: { Accept: "text/event-stream" } });
check("SSE status 200", sseRes.status === 200);
check("SSE content-type", (sseRes.headers.get("content-type") ?? "").includes("text/event-stream"));
const reader = sseRes.body.getReader();
const textDec = new TextDecoder();
let buf = "";
let sseFirst = null;
for (let i = 0; i < 20 && !sseFirst; i++) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += textDec.decode(value, { stream: true });
  const m = buf.match(/^data: (.+)$/m);
  if (m) sseFirst = m[1];
}
check("SSE first event arrives", sseFirst !== null);
let clientDoc = new Y.Doc();
if (sseFirst) {
  const sseDec = decoding.createDecoder(new Uint8Array(Buffer.from(sseFirst, "base64")));
  const sseType = decoding.readVarUint(sseDec);
  const sseEnc = encoding.createEncoder();
  const sseSyncType = syncProtocol.readSyncMessage(sseDec, sseEnc, clientDoc, null);
  check("SSE message is syncStep1", sseType === messageSync && sseSyncType === syncProtocol.messageYjsSyncStep1);
  check("SSE syncStep1 empty server state", clientDoc.getText("content").toString() === "");
}

// 2. POST the client's full state (what a real client sends as its syncStep2 reply)
const step2 = frameSyncStep2(serverDoc);
const step2Res = await post(step2);
check("POST syncStep2 status 200", step2Res.status === 200);
check("POST syncStep2 empty reply", (await step2Res.arrayBuffer()).byteLength === 0);

// 3. Now a fresh client POSTing syncStep1 must receive "hello from server" back
const step1 = frameSyncStep1(new Y.Doc());
const replyRes = await post(step1);
check("POST syncStep1 status 200", replyRes.status === 200);
const replyBytes = new Uint8Array(await replyRes.arrayBuffer());
const freshDoc = new Y.Doc();
const parsed = readSync(replyBytes, freshDoc);
check("reply is syncStep2", parsed.syncType === syncProtocol.messageYjsSyncStep2);
check("reply carries server content", freshDoc.getText("content").toString() === "hello from server" && freshDoc.getMap("ypad").get("language") === "python", `got ${JSON.stringify(freshDoc.getText("content").toString())}/${freshDoc.getMap("ypad").get("language")}`);

// 4. A second client completes sync over POST (content arrives in the syncStep2
//    reply body), then an edit must be broadcast to its SSE stream and apply.
const sseRes2 = await fetch(`${BASE}/${ROOM}?transport=http&token=${TOKEN}2`, { headers: { Accept: "text/event-stream" } });
const reader2 = sseRes2.body.getReader();
const textDec2 = new TextDecoder();
let docAfter = new Y.Doc();
{
  const syncReply = await post(frameSyncStep1(docAfter), TOKEN2);
  const syncBytes = new Uint8Array(await syncReply.arrayBuffer());
  const syncParsed = readSync(syncBytes, docAfter);
  check("client2 POST syncStep1 -> syncStep2 reply", syncParsed.syncType === syncProtocol.messageYjsSyncStep2);
}
check("client2 content via POST reply", docAfter.getText("content").toString() === "hello from server");

ytext.insert(ytext.length, "!");
const updRes = await post(frameUpdate(serverDoc), TOKEN2);
check("POST update status 200", updRes.status === 200);

let updateSeen = false;
let evBuf = "";
let lastIdx = 0;
const evRe = /data: ([^\n]+)\n\n/g;
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !updateSeen) {
  const { value, done } = await reader2.read();
  if (done) break;
  evBuf += textDec2.decode(value, { stream: true });
  for (const m of evBuf.matchAll(evRe)) {
    if (m.index < lastIdx) continue;
    lastIdx = m.index + m[0].length;
    const bytes = new Uint8Array(Buffer.from(m[1], "base64"));
    const d = decoding.createDecoder(bytes);
    if (d.arr.byteLength === 0) continue;
    const type = decoding.readVarUint(d);
    if (type !== messageSync) continue;
    const inner = decoding.readVarUint(d);
    if (inner === syncProtocol.messageYjsUpdate) {
      Y.applyUpdate(docAfter, decoding.readVarUint8Array(d));
      updateSeen = true;
      break;
    }
  }
}
check("SSE broadcasts edit as update", updateSeen);
check("SSE update applies on top of sync", docAfter.getText("content").toString() === "hello from server!");

// 5. POST awareness -> 200 empty
const aw = frameAwareness(awareness);
const awRes = await post(aw);
check("POST awareness status 200", awRes.status === 200);
check("POST awareness empty reply", (await awRes.arrayBuffer()).byteLength === 0);

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// 6. Multi-frame POST: several protocol frames in one body are all applied
const docA = new Y.Doc();
docA.getText("content").insert(0, "A");
const docB = new Y.Doc();
docB.getText("content").insert(0, "B");
const batchRes = await post(concatBytes(frameUpdate(docA), frameUpdate(docB)));
check("multi-frame POST status 200", batchRes.status === 200);
await batchRes.arrayBuffer();
const probeRes = await post(frameSyncStep1(new Y.Doc()));
const probeDoc = new Y.Doc();
readSync(new Uint8Array(await probeRes.arrayBuffer()), probeDoc);
const probeText = probeDoc.getText("content").toString();
check(
  "multi-frame POST applies all updates",
  probeText.includes("A") && probeText.includes("B"),
  `got ${JSON.stringify(probeText)}`
);

// 7. Multi-frame replies: syncStep1 + queryAwareness in one body -> two
//    concatenated reply frames (syncStep2 + awareness)
function frameQueryAwareness() {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 3); // messageQueryAwareness
  return encoding.toUint8Array(enc);
}
const comboRes = await post(
  concatBytes(frameSyncStep1(new Y.Doc()), frameQueryAwareness())
);
check("combo POST status 200", comboRes.status === 200);
const comboBytes = new Uint8Array(await comboRes.arrayBuffer());
let sawStep2 = false;
let sawAwarenessFrame = false;
{
  const d = decoding.createDecoder(comboBytes);
  try {
    while (d.pos < d.arr.length) {
      const t = decoding.readVarUint(d);
      if (t === messageSync) {
        const e2 = encoding.createEncoder();
        if (
          syncProtocol.readSyncMessage(d, e2, new Y.Doc(), null) ===
          syncProtocol.messageYjsSyncStep2
        ) {
          sawStep2 = true;
        }
      } else if (t === messageAwareness) {
        decoding.readVarUint8Array(d);
        sawAwarenessFrame = true;
      } else {
        break;
      }
    }
  } catch {
    // truncated tail
  }
}
check(
  "reply carries syncStep2 + awareness concatenated",
  sawStep2 && sawAwarenessFrame,
  `step2=${sawStep2} awareness=${sawAwarenessFrame}`
);

// 8. OPTIONS preflight
const opt = await fetch(`${BASE}/${ROOM}?transport=http`, { method: "OPTIONS", headers: { Origin: "https://ypad.pages.dev", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
check("OPTIONS 204", opt.status === 204);
check("OPTIONS ACAO *", opt.headers.get("access-control-allow-origin") === "*");

// 9. wrong method
const bad = await fetch(`${BASE}/${ROOM}?transport=http`, { method: "DELETE" });
check("DELETE -> 405", bad.status === 405);

process.exit(failures === 0 ? 0 : 1);