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

export interface EncHttpProviderEvents {
  status: (event: { status: "connecting" | "connected" | "disconnected" }) => void;
}

/**
 * Password-E2E variant of the HTTP fallback transport. The local Y.Doc is
 * plaintext in memory; every protocol frame is AES-GCM enveloped before it
 * leaves the browser, and the Durable Object only ever stores ciphertext.
 * Wire bodies are length-prefixed envelopes: [u32be len][frame]...
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

  /** Push the full local state as one encrypted update (takeover / resync). */
  pushSnapshot(): void {
    const update = Y.encodeStateAsUpdate(this.doc);
    if (update.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, encMessageSync);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
    void this.flush();
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

  private openStream(): void {
    if (!this.shouldConnect || this.es !== null) return;
    this.emit("status", [{ status: "connecting" }]);

    const es = new EventSource(`${this.url}?transport=http&token=${this.token}`);
    this.es = es;

    es.onopen = () => {
      if (this.es !== es) return;
      this.wasConnected = true;
      this.reconnectAttempts = 0;
      this.synced = false;
      this.emit("status", [{ status: "connected" }]);

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, encMessageSync);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
      void this.flush();
    };

    es.onmessage = (event) => {
      if (this.es !== es) return;
      void this.handleEncrypted(fromBase64(event.data as string));
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

  private async handleEncrypted(blob: Uint8Array): Promise<void> {
    let plain: Uint8Array;
    try {
      plain = await decryptFrame(this.key, blob);
    } catch {
      return;
    }
    const encoder = this.readFrames(plain);
    if (encoding.length(encoder) > 1) {
      this.send(encoding.toUint8Array(encoder));
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

  private async flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.shouldConnect && this.outbox.length > 0) {
        const batch = this.outbox;
        this.outbox = [];
        const envelopes: Uint8Array[] = [];
        let total = 0;
        for (const b of batch) {
          try {
            const env = await encryptFrame(this.key, b);
            envelopes.push(env);
            total += 4 + env.length;
          } catch {
            // key unusable; drop the batch
          }
        }
        if (envelopes.length === 0) continue;
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
        await this.post(body);
      }
    } finally {
      this.flushing = false;
    }
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

  private async post(body: Uint8Array): Promise<void> {
    if (!this.shouldConnect) return;
    try {
      const res = await fetch(`${this.url}?transport=http&token=${this.token}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: new Uint8Array(body),
      });
      if (!res.ok) return;
      // Encrypted rooms reply empty; history arrives via the SSE burst.
      await res.arrayBuffer();
    } catch {
      // transient network failure; the SSE stream reconnects and resyncs
    }
  }
}
