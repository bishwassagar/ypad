// Password-E2E transport test. Requires `npm run server` (wrangler dev :8787).
// Exercises: status endpoint, initEnc claim + conflicts, opaque ciphertext
// relay over POST/SSE, plaintext rejection in enc rooms, takeover flow.
const BASE = "http://localhost:8787";
const te = new TextEncoder();

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

async function deriveKey(password, room) {
  const base = await crypto.subtle.importKey(
    "raw",
    te.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const salt = te.encode(`ypad-v1:${room}`).slice().buffer;
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

async function encFrame(key, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain),
  );
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 0xe1;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

async function decFrame(key, blob) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.subarray(1, 13) },
    key,
    blob.subarray(13),
  );
  return new Uint8Array(pt);
}

function pack(frames) {
  let total = 0;
  for (const f of frames) total += 4 + f.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) {
    new DataView(out.buffer).setUint32(off, f.length);
    out.set(f, off + 4);
    off += 4 + f.length;
  }
  return out;
}

async function status(room) {
  const res = await fetch(`${BASE}/${room}?status=1`);
  return { http: res.status, body: await res.json() };
}

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

// --- Room A: full encrypted lifecycle ---
const roomA = `enc-a-${Date.now()}`;
const pwA = "correct horse battery staple!!";
const keyA = await deriveKey(pwA, roomA);

{
  const st = await status(roomA);
  check("fresh room status plain/empty", st.body.mode === "plain" && st.body.hasData === false, JSON.stringify(st.body));
}

const verifierA = await encFrame(keyA, te.encode(`YPAD-ENC1:${roomA}`));
{
  const res = await fetch(`${BASE}/${roomA}?initEnc=1`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: verifierA,
  });
  check("initEnc 200", res.status === 200);
}
{
  const st = await status(roomA);
  check("status enc after claim", st.body.mode === "enc", JSON.stringify(st.body));
  check("verifier round-trips", st.body.verifier === b64(verifierA));
  const back = await decFrame(keyA, new Uint8Array(Buffer.from(st.body.verifier, "base64")));
  check("verifier decrypts with password", new TextDecoder().decode(back) === `YPAD-ENC1:${roomA}`);
  const wrong = await deriveKey("wrong password 12345678", roomA);
  let rejected = false;
  try {
    await decFrame(wrong, new Uint8Array(Buffer.from(st.body.verifier, "base64")));
  } catch {
    rejected = true;
  }
  check("verifier rejects wrong password", rejected);
}
{
  const res = await fetch(`${BASE}/${roomA}?initEnc=1`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: verifierA,
  });
  check("second initEnc -> 409", res.status === 409);
}

// POST a ciphertext frame; reply must be empty (history comes via SSE burst)
const secretBytes = te.encode("fake-yjs-update: SECRET-DATA-123");
const encUpdate = await encFrame(keyA, secretBytes);
{
  const res = await fetch(`${BASE}/${roomA}?transport=http&token=t1`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: pack([encUpdate]),
  });
  check("enc POST 200", res.status === 200);
  check("enc POST empty reply", (await res.arrayBuffer()).byteLength === 0);
}

// SSE burst must replay exactly our frame, and it must decrypt
{
  const res = await fetch(`${BASE}/${roomA}?transport=http&token=t2`, {
    headers: { Accept: "text/event-stream" },
  });
  check("enc SSE 200", res.status === 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let frames = [];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && frames.length === 0) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const m of buf.matchAll(/^data: (.+)$/gm)) {
      try {
        frames.push(new Uint8Array(Buffer.from(m[1], "base64")));
      } catch {
        // keepalive ": ping" lines don't match data: anyway
      }
    }
  }
  await reader.cancel();
  // initial burst replays the stored update (retry line excluded by regex)
  const updates = frames.filter((f) => f.length > 0 && f[0] === 0xe1);
  check("SSE burst replays 1 ciphertext frame", updates.length === 1, `got ${updates.length}`);
  if (updates.length === 1) {
    const back = await decFrame(keyA, updates[0]);
    check(
      "replayed frame decrypts to original",
      new TextDecoder().decode(back) === "fake-yjs-update: SECRET-DATA-123",
    );
    const raw = Buffer.from(updates[0]).toString("binary");
    check("ciphertext hides plaintext on the wire", !raw.includes("SECRET-DATA-123"));
  }
}

// Plaintext frames to an enc room must be dropped, not stored/relayed
{
  const plainFrame = new Uint8Array([0, 0, 1, 2, 3]); // looks like y-protocol sync
  const res = await fetch(`${BASE}/${roomA}?transport=http&token=t3`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: (() => {
      const out = new Uint8Array(4 + plainFrame.length);
      new DataView(out.buffer).setUint32(0, plainFrame.length);
      out.set(plainFrame, 4);
      return out;
    })(),
  });
  check("plaintext POST to enc room 200 (dropped)", res.status === 200);
  const st = await status(roomA);
  // still exactly the 1 legitimate frame: reopen SSE and count envelopes
  const res2 = await fetch(`${BASE}/${roomA}?transport=http&token=t4`, {
    headers: { Accept: "text/event-stream" },
  });
  const reader = res2.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let n = 0;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && n === 0) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const m of buf.matchAll(/^data: (.+)$/gm)) {
      try {
        const f = new Uint8Array(Buffer.from(m[1], "base64"));
        if (f.length > 0 && f[0] === 0xe1) n++;
      } catch {}
    }
    if (buf.length > 4096) break;
  }
  await reader.cancel();
  check("plaintext frame was not appended to log", n === 1, `envelopes=${n}`);
  void st;
}

// --- Room B: takeover flow ---
const roomB = `enc-b-${Date.now()}`;
{
  // seed plaintext content the plain way (raw y-protocol update)
  const Y = await import("yjs");
  const enc = await import("lib0/encoding");
  const sync = await import("y-protocols/sync");
  const d = new Y.Doc();
  d.getText("content").insert(0, "old plaintext");
  const e = enc.createEncoder();
  enc.writeVarUint(e, 0);
  sync.writeUpdate(e, Y.encodeStateAsUpdate(d));
  const body = enc.toUint8Array(e);
  await fetch(`${BASE}/${roomB}?transport=http&token=x`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body,
  });
  const st = await status(roomB);
  check("room B has plaintext data", st.body.mode === "plain" && st.body.hasData === true, JSON.stringify(st.body));

  const keyB = await deriveKey("another strong passphrase!!", roomB);
  const verB = await encFrame(keyB, te.encode(`YPAD-ENC1:${roomB}`));
  const noTake = await fetch(`${BASE}/${roomB}?initEnc=1`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: verB,
  });
  check("initEnc without takeover -> 409 has-plaintext", noTake.status === 409 && (await noTake.json()).error === "has-plaintext");
  const take = await fetch(`${BASE}/${roomB}?initEnc=1&takeover=1`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: verB,
  });
  check("initEnc with takeover -> 200", take.status === 200);
  const st2 = await status(roomB);
  check("room B now enc, log empty", st2.body.mode === "enc" && st2.body.hasData === false, JSON.stringify(st2.body));
}

process.exit(failures === 0 ? 0 : 1);
