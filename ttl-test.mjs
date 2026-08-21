// Room TTL lifecycle test. Requires the dev server to run with a short TTL:
//   npx wrangler dev --var ROOM_TTL_MS:5000 --port 8787
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

const BASE = "http://localhost:8787";
let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}
function frameSyncStep1(doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, doc);
  return encoding.toUint8Array(enc);
}
function frameUpdate(doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
}
async function post(room, body) {
  const res = await fetch(`${BASE}/${room}?transport=http&token=t1`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body,
  });
  return new Uint8Array(await res.arrayBuffer());
}
function serverText(replyBytes) {
  const target = new Y.Doc();
  const dec = decoding.createDecoder(replyBytes);
  if (dec.arr.length === 0) return null;
  decoding.readVarUint(dec);
  syncProtocol.readSyncMessage(dec, encoding.createEncoder(), target, null);
  return target.getText("content").toString();
}

// --- Room A: wiped after TTL ---
const roomA = `ttl-a-${Date.now()}`;
const src = new Y.Doc();
src.getText("content").insert(0, "TTL-CHECK");
await post(roomA, frameUpdate(src));

// open + close SSE (last client leaves)
{
  const res = await fetch(`${BASE}/${roomA}?transport=http&token=t1`, { headers: { Accept: "text/event-stream" } });
  const reader = res.body.getReader();
  await reader.read(); // got initial state
  await reader.cancel(); // disconnect
  await fetch(`${BASE}/${roomA}?transport=http&token=t1&close=1`, { method: "POST" }); // explicit goodbye
}
check("room alive right after disconnect", serverText(await post(roomA, frameSyncStep1(new Y.Doc()))) === "TTL-CHECK");

// poll until wiped (detection lag up to ~15s keepalive + 5s TTL)
let wiped = false;
for (let i = 0; i < 20 && !wiped; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const t = serverText(await post(roomA, frameSyncStep1(new Y.Doc())));
  if (t === "") wiped = true;
}
check("room wiped after TTL", wiped);

// --- Room B: reconnect cancels expiry ---
const roomB = `ttl-b-${Date.now()}`;
await post(roomB, frameUpdate(src));
let readerB;
{
  const res = await fetch(`${BASE}/${roomB}?transport=http&token=t1`, { headers: { Accept: "text/event-stream" } });
  readerB = res.body.getReader();
  await readerB.read();
  await readerB.cancel();
  await fetch(`${BASE}/${roomB}?transport=http&token=t1&close=1`, { method: "POST" });
}
await new Promise((r) => setTimeout(r, 2000)); // alarm armed via explicit close
{
  // rejoin within window and STAY CONNECTED past the original deadline
  const res = await fetch(`${BASE}/${roomB}?transport=http&token=t2`, { headers: { Accept: "text/event-stream" } });
  readerB = res.body.getReader();
  await readerB.read();
}
await new Promise((r) => setTimeout(r, 8000)); // well past original deadline
check(
  "rejoin cancels expiry",
  serverText(await post(roomB, frameSyncStep1(new Y.Doc()))) === "TTL-CHECK"
);
await readerB.cancel();
await fetch(`${BASE}/${roomB}?transport=http&token=t2&close=1`, { method: "POST" });
let wipedB = false;
for (let i = 0; i < 10 && !wipedB; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  if (serverText(await post(roomB, frameSyncStep1(new Y.Doc()))) === "") wipedB = true;
}
check("room B wiped after final disconnect", wipedB);

process.exit(failures === 0 ? 0 : 1);
