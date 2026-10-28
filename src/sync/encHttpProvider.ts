import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { fromBase64 } from "lib0/buffer";
import { ObservableV2 } from "lib0/observable";
import type { Awareness } from "y-protocols/awareness";
import { decryptFrame, encryptFrame } from "../crypto";

export const encMessageSync = 0;
export const encMessageAwareness = 1;

const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH_MESSAGES = 100;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
// A failed POST batch is never dropped: it parks in the retry slot and is
// re-posted with backoff until it lands (the SSE reconnect watermark push is
// the safety net behind this).
const POST_RETRY_BASE_MS = 1_000;
const POST_RETRY_MAX_MS = 30_000;
// Compaction runs at most once per session and only when the server log is
// large; the server rejects it via CAS if newer frames landed in between.
const COMPACTION_THRESHOLD_BYTES = 256 * 1024;
const COMPACTION_MAX_SNAPSHOT_BYTES = 1_500_000;

export interface EncHttpProviderEvents {
  status: (event: { status: "connecting" | "connected" | "disconnected" }) => void;
}

/**
 * Password-E2E variant of the HTTP fallback transport. The local Y.Doc is
 * plaintext in memory; every protocol frame is AES-GCM enveloped before it
 * leaves the browser, and the Durable Object only ever stores ciphertext.
 * Wire bodies are length-prefixed envelopes: [u32be len][frame]...
 *
 * The server cannot read content, so it can neither compute diffs nor push
 * sync-step-1 like plain mode does. Instead: on connect the client sends its
 * state vector (pull — peers reply with diffs) and a watermark diff of local
 * ops the server never acknowledged (push). The server log is compacted by
 * whichever client first reacts to the end-of-replay marker when it has
 * outgrown the compaction threshold.
 *
 * Awareness is not sent over HTTP (same as the plaintext provider), so names
 * and cursors never touch the network on this transport at all.
 */
export class EncHttpSyncProvider extends ObservableV2<EncHttpProviderEvents> {
  serverUrl: string;
  roomname: string;
  doc: Y.Doc;
  awareness: Awareness;
  synced = false;
  shouldConnect = false;

  private key: CryptoKey;
  private token: string;
  private es: EventSource | null = null;
  private wasConnected = false;
  private maxBackoffTime: number;
  private reconnectAttempts = 0;
  private reconnectTimer: number | undefined;
  private outbox: Uint8Array[] = [];
  private flushTimer: number | undefined;
  private flushing = false;
  // Serialized application of received frames. Decrypt latency varies with
  // frame size, so without this the end-of-replay bookkeeping could run
  // before earlier replayed frames reached the doc.
  private applyQueue: Promise<void> = Promise.resolve();
  // Watermark: highest local op count known to be in the server log. Local
  // edits advance the doc's own clock; a batch commits its build-time clock
  // only after its POST succeeds.
  private ackedClock = 0;
  private pendingClock = 0;
  private retryBody: Uint8Array | null = null;
  private retryTimer: number | undefined;
  private retryDelay = 0;
  private compacted = false;
  private decryptFailures = 0;
  private _updateHandler: (update: Uint8Array, origin: unknown) => void;
  private _awarenessUpdateHandler: (arg0: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => void;

  constructor(
    serverUrl: string,
    roomname: string,
    doc: Y.Doc,
    key: CryptoKey,
    opts: { awareness?: Awareness; maxBackoffTime?: number } = {},
  ) {
    super();
    while (serverUrl[serverUrl.length - 1] === "/") {
      serverUrl = serverUrl.slice(0, serverUrl.length - 1);
    }
    this.serverUrl = serverUrl;
    this.roomname = roomname;
    this.doc = doc;
    this.key = key;
    this.awareness = opts.awareness ?? new awarenessProtocol.Awareness(doc);
    this.maxBackoffTime = opts.maxBackoffTime ?? DEFAULT_MAX_BACKOFF_MS;
    this.token = crypto.randomUUID();
    document.addEventListener("visibilitychange", this.onVisibility);

    this._updateHandler = (update, origin) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, encMessageSync);
        syncProtocol.writeUpdate(encoder, update);
        this.send(encoding.toUint8Array(encoder));
      }
    };
    this._awarenessUpdateHandler = () => {};

    this.doc.on("update", this._updateHandler);
    this.awareness.on("update", this._awarenessUpdateHandler);
  }

  get url(): string {
    return `${this.serverUrl}/${this.roomname}`;
  }

  connect(): void {
    if (this.shouldConnect) return;
    this.shouldConnect = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.openStream();
  }

  disconnect(): void {
    this.shouldConnect = false;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryBody = null;
    this.pendingClock = 0;
    this.retryDelay = 0;
    this.outbox = [];
    if (this.es !== null) {
      this.es.close();
      this.es = null;
    }
    this.signalClose();
    this.emit("status", [{ status: "disconnected" }]);
  }

  destroy(): void {
    this.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.awareness.off("update", this._awarenessUpdateHandler);
    this.doc.off("update", this._updateHandler);
    super.destroy();
  }

  private onVisibility = (): void => {
    if (!this.shouldConnect) return;
    if (document.hidden) {
      this.signalClose();
      if (this.es !== null) {
        this.es.close();
        this.es = null;
        this.wasConnected = false;
      }
      if (this.reconnectTimer !== undefined) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
    } else if (this.es === null) {
      this.openStream();
    }
  };

  private signalClose(): void {
    try {
      void fetch(`${this.url}?transport=http&token=${this.token}&close=1`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {});
    } catch {
      // best effort only
    }
  }

  private localClock(): number {
    const arr = this.doc.store.clients.get(this.doc.clientID);
    return arr ? arr.length : 0;
  }

  /**
   * Queue exactly the local ops the server log has not acknowledged. A fresh
   * provider starts at 0, so a takeover client pushes its whole plaintext-era
   * doc once; a reloading client with an empty doc pushes nothing.
   */
  private pushUnacked(): void {
    const clock = this.localClock();
    if (clock <= this.ackedClock) return;
    const vec = encoding.createEncoder();
    encoding.writeVarUint(vec, 1);
    encoding.writeVarUint(vec, this.doc.clientID);
    encoding.writeVarUint(vec, this.ackedClock);
    const update = Y.encodeStateAsUpdate(this.doc, encoding.toUint8Array(vec));
    if (update.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, encMessageSync);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  }

  private openStream(): void {
    if (!this.shouldConnect || this.es !== null) return;
    this.emit("status", [{ status: "connecting" }]);

    const es = new EventSource(`${this.url}?transport=http&token=${this.token}`);
    this.es = es;

    es.onopen = () => {
      if (this.es !== es) return;
      this.wasConnected = true;
      this.reconnectAttempts = 0;
      this.decryptFailures = 0;
      this.synced = false;
      this.emit("status", [{ status: "connected" }]);

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, encMessageSync);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
      this.pushUnacked();
      void this.flush();
    };

    es.addEventListener("burst-end", (event) => {
      if (this.es !== es) return;
      const payload = (event as MessageEvent).data as string;
      this.applyQueue = this.applyQueue
        .then(() => this.maybeCompact(payload))
        .catch(() => {});
    });

    es.onmessage = (event) => {
      if (this.es !== es) return;
      this.enqueue(fromBase64(event.data as string));
    };

    es.onerror = () => {
      if (this.es !== es) return;
      if (this.wasConnected) {
        this.wasConnected = false;
        this.synced = false;
        this.emit("status", [{ status: "disconnected" }]);
      }
      if (es.readyState === EventSource.CLOSED) {
        this.es = null;
        es.close();
        this.scheduleReconnect();
      }
    };
  }

  private enqueue(blob: Uint8Array): void {
    this.applyQueue = this.applyQueue
      .then(() => this.handleEncrypted(blob))
      .catch(() => {});
  }

  private async handleEncrypted(blob: Uint8Array): Promise<void> {
    let plain: Uint8Array;
    try {
      plain = await decryptFrame(this.key, blob);
    } catch {
      this.decryptFailures++;
      return;
    }
    const encoder = this.readFrames(plain);
    if (encoding.length(encoder) > 1) {
      this.send(encoding.toUint8Array(encoder));
    }
  }

  /**
   * Runs at the back of the apply queue, so the doc is guaranteed to cover
   * the replayed log. Compacts at most once per session and only when the
   * log is worth replacing; a version mismatch means newer frames arrived
   * concurrently — the client already has them live, so it just skips.
   */
  private async maybeCompact(payload: string): Promise<void> {
    if (this.compacted || !this.shouldConnect) return;
    let meta: { v?: number; bytes?: number };
    try {
      meta = JSON.parse(payload);
    } catch {
      return;
    }
    const version = meta.v;
    const bytes = meta.bytes ?? 0;
    if (typeof version !== "number" || bytes < COMPACTION_THRESHOLD_BYTES) return;
    this.compacted = true;
    // Failed decryptions mean the doc may not cover the log; compacting
    // then could erase history for late joiners.
    if (this.decryptFailures > 0) return;
    const update = Y.encodeStateAsUpdate(this.doc);
    if (update.length === 0 || update.length > COMPACTION_MAX_SNAPSHOT_BYTES) return;
    try {
      const env = await encryptFrame(this.key, update);
      const clock = this.localClock();
      const res = await fetch(
        `${this.url}?transport=http&token=${this.token}&snapshot=1&baseVersion=${version}`,
        {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: new Uint8Array(env),
        },
      );
      if (res.ok) this.ackedClock = Math.max(this.ackedClock, clock);
    } catch {
      // network failure: the log stays as-is until a later session
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldConnect || this.es !== null) return;
    const delay = Math.min(
      Math.pow(2, this.reconnectAttempts) * 200,
      this.maxBackoffTime,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.shouldConnect && this.es === null) this.openStream();
    }, delay);
  }

  private send(buf: Uint8Array): void {
    if (!this.shouldConnect) return;
    this.outbox.push(buf);
    if (this.outbox.length >= MAX_BATCH_MESSAGES) {
      void this.flush();
      return;
    }
    if (this.flushTimer === undefined) {
      this.flushTimer = window.setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  private schedulePostRetry(): void {
    if (this.retryTimer !== undefined) return;
    this.retryDelay =
      this.retryDelay === 0
        ? POST_RETRY_BASE_MS
        : Math.min(this.retryDelay * 2, POST_RETRY_MAX_MS);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.shouldConnect && this.retryBody !== null) void this.flush();
    }, this.retryDelay);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.flushing) return;
    this.flushing = true;
    try {
      // A failed batch parks here until it lands; nothing newer may be
      // posted ahead of it, which keeps the watermark monotone and honest.
      if (this.retryBody !== null) {
        if (!(await this.post(this.retryBody))) {
          this.schedulePostRetry();
          return;
        }
        this.ackedClock = Math.max(this.ackedClock, this.pendingClock);
        this.retryBody = null;
        this.pendingClock = 0;
        this.retryDelay = 0;
      }
      while (this.shouldConnect && this.outbox.length > 0) {
        const batch = this.outbox;
        this.outbox = [];
        const clock = this.localClock();
        const body = await this.packEncrypted(batch);
        if (body === null) {
          // Frames that could not be encrypted are back in the outbox;
          // stop short so the watermark never claims them as delivered.
          return;
        }
        if (!(await this.post(body))) {
          this.retryBody = body;
          this.pendingClock = clock;
          this.schedulePostRetry();
          return; // remaining outbox waits behind the retry
        }
        this.ackedClock = Math.max(this.ackedClock, clock);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async packEncrypted(batch: Uint8Array[]): Promise<Uint8Array | null> {
    const envelopes: Uint8Array[] = [];
    const failed: Uint8Array[] = [];
    let total = 0;
    for (const b of batch) {
      try {
        const env = await encryptFrame(this.key, b);
        envelopes.push(env);
        total += 4 + env.length;
      } catch {
        failed.push(b);
      }
    }
    if (failed.length > 0) {
      // Never claim ops we could not encrypt.
      this.outbox.unshift(...failed);
      return null;
    }
    if (envelopes.length === 0) return null;
    const body = new Uint8Array(total);
    let off = 0;
    for (const env of envelopes) {
      body[off] = (env.length >>> 24) & 0xff;
      body[off + 1] = (env.length >>> 16) & 0xff;
      body[off + 2] = (env.length >>> 8) & 0xff;
      body[off + 3] = env.length & 0xff;
      body.set(env, off + 4);
      off += 4 + env.length;
    }
    return body;
  }

  private readFrames(buf: Uint8Array): encoding.Encoder {
    const decoder = decoding.createDecoder(buf);
    const out = encoding.createEncoder();
    try {
      while (decoder.pos < decoder.arr.length) {
        const messageType = decoding.readVarUint(decoder);
        const encoder = encoding.createEncoder();
        if (messageType === encMessageSync) {
          encoding.writeVarUint(encoder, encMessageSync);
          const syncMessageType = syncProtocol.readSyncMessage(
            decoder,
            encoder,
            this.doc,
            this,
          );
          if (
            syncMessageType === syncProtocol.messageYjsSyncStep2 &&
            !this.synced
          ) {
            this.synced = true;
          }
        }
        if (encoding.length(encoder) > 1) {
          encoding.writeUint8Array(out, encoding.toUint8Array(encoder));
        }
      }
    } catch {
      // truncated or corrupt trailing frame: keep what we decoded
    }
    return out;
  }

  private async post(body: Uint8Array): Promise<boolean> {
    if (!this.shouldConnect) return false;
    try {
      const res = await fetch(`${this.url}?transport=http&token=${this.token}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: new Uint8Array(body),
      });
      // Encrypted rooms reply empty; history arrives via the SSE burst.
      return res.ok;
    } catch {
      return false;
    }
  }
}
