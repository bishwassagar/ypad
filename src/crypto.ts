const ITERATIONS = 250_000;
const ENC_VERSION = 0xe1;

const enc = new TextEncoder();
const dec = new TextDecoder();

function saltFor(roomId: string): ArrayBuffer {
  return enc.encode(`ypad-v1:${roomId}`).slice().buffer as ArrayBuffer;
}

export async function deriveRoomKey(
  password: string,
  roomId: string,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltFor(roomId),
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportRoomKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  let binary = "";
  const bytes = new Uint8Array(raw);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function importRoomKey(exported: string): Promise<CryptoKey> {
  const binary = atob(exported);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", true, [
    "encrypt",
    "decrypt",
  ]);
}

export function verifierPlaintext(roomId: string): Uint8Array {
  return enc.encode(`YPAD-ENC1:${roomId}`);
}

export function checkVerifier(
  plain: Uint8Array,
  roomId: string,
): boolean {
  const expected = verifierPlaintext(roomId);
  if (plain.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < plain.length; i++) diff |= plain[i] ^ expected[i];
  return diff === 0;
}

async function encryptRaw(
  key: CryptoKey,
  plain: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plain as BufferSource,
    ),
  );
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = ENC_VERSION;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

async function decryptRaw(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 14 || blob[0] !== ENC_VERSION) {
    throw new Error("not-encrypted-frame");
  }
  const iv = blob.subarray(1, 13);
  const ct = blob.subarray(13);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new Uint8Array(pt);
}

export function isEncryptedFrame(bytes: Uint8Array): boolean {
  return bytes.length >= 14 && bytes[0] === ENC_VERSION;
}

export async function encryptFrame(
  key: CryptoKey,
  plain: Uint8Array,
): Promise<Uint8Array> {
  return encryptRaw(key, plain);
}

export async function decryptFrame(
  key: CryptoKey,
  blob: Uint8Array,
): Promise<Uint8Array> {
  return decryptRaw(key, blob);
}

export const MIN_PASSWORD_LENGTH = 8;

export function meetsMinLength(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}

export function sessionKeyName(roomId: string): string {
  return `ypad-enc-key:${roomId}`;
}

export function decodeUtf8(bytes: Uint8Array): string {
  return dec.decode(bytes);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
