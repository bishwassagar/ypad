import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { fromBase64 } from "lib0/buffer";
import { ObservableV2 } from "lib0/observable";
import type { Awareness } from "y-protocols/awareness";

export const messageSync = 0;
export const messageAwareness = 1;

const FLUSH_INTERVAL_MS = 80;
const MAX_BATCH_MESSAGES = 50;
// Free-tier Durable Object duration is billed per second while an SSE stream
// is held open, so background tabs must not keep one alive.
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export interface HttpSyncProviderEvents {
  status: (event: { status: "connecting" | "connected" | "disconnected" }) => void;
}

/**
 * Yjs provider that rides the same y-protocols wire messages over plain HTTPS:
 * server -> client via SSE, client -> server via POST. Used as a fallback when
 * the network blocks WebSocket upgrades (SSE is a plain HTTP GET/POST and passes
 * through most proxies and captive portals).
 *
 * Outgoing frames are queued and flushed as one concatenated batch per ~80ms to
 * keep request counts low; the server parses concatenated frames and replies in
 * kind. POSTs use a CORS-simple content type so browsers never preflight.
 */
export class HttpSyncProvider extends ObservableV2<HttpSyncProviderEvents> {
  serverUrl: string;
  roomname: string;
  doc: Y.Doc;
  awareness: Awareness;
  synced = false;
  shouldConnect = false;

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
    opts: { awareness?: Awareness; maxBackoffTime?: number } = {}
  ) {
    super();
    while (serverUrl[serverUrl.length - 1] === "/") {
      serverUrl = serverUrl.slice(0, serverUrl.length - 1);
    }
    this.serverUrl = serverUrl;
    this.roomname = roomname;
    this.doc = doc;
    this.awareness = opts.awareness ?? new awarenessProtocol.Awareness(doc);
    this.maxBackoffTime = opts.maxBackoffTime ?? DEFAULT_MAX_BACKOFF_MS;
    this.token = crypto.randomUUID();
    document.addEventListener("visibilitychange", this.onVisibility);

    this._updateHandler = (update, origin) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeUpdate(encoder, update);
        this.send(encoding.toUint8Array(encoder));
      }
    };
    this._awarenessUpdateHandler = ({ added, updated, removed }) => {
      const changedClients = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      );
      this.send(encoding.toUint8Array(encoder));
    };

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
    this.outbox = [];
    if (this.es !== null) {
      this.es.close();
      this.es = null;
    }
    this.signalClose();
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "client disconnected"
    );
    this.emit("status", [{ status: "disconnected" }]);
  }

  destroy(): void {
    this.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.awareness.off("update", this._awarenessUpdateHandler);
    this.doc.off("update", this._updateHandler);
    super.destroy();
  }

  // Closing the stream while the tab is hidden stops DO duration billing for
  // background tabs; outgoing edits still sync via POST round-trips, and the
  // handshake on reopen resyncs anything missed.
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

  // Tell the server to drop our SSE registration so room expiry can start
  // counting from the real last disconnect. keepalive lets it race navigation.
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
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));

      if (this.awareness.getLocalState() !== null) {
        const aEncoder = encoding.createEncoder();
        encoding.writeVarUint(aEncoder, messageAwareness);
        encoding.writeVarUint8Array(
          aEncoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
        );
        this.send(encoding.toUint8Array(aEncoder));
      }
      void this.flush();
    };

    es.onmessage = (event) => {
      if (this.es !== es) return;
      const buf = fromBase64(event.data as string);
      const encoder = this.readFrames(buf);
      if (encoding.length(encoder) > 1) {
        this.send(encoding.toUint8Array(encoder));
      }
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

  private scheduleReconnect(): void {
    if (!this.shouldConnect || this.es !== null) return;
    const delay = Math.min(
      Math.pow(2, this.reconnectAttempts) * 200,
      this.maxBackoffTime
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
        let total = 0;
        for (const b of batch) total += b.length;
        const body = new Uint8Array(total);
        let off = 0;
        for (const b of batch) {
          body.set(b, off);
          off += b.length;
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
        if (messageType === messageSync) {
          encoding.writeVarUint(encoder, messageSync);
          const syncMessageType = syncProtocol.readSyncMessage(
            decoder,
            encoder,
            this.doc,
            this
          );
          if (
            syncMessageType === syncProtocol.messageYjsSyncStep2 &&
            !this.synced
          ) {
            this.synced = true;
          }
        } else if (messageType === messageAwareness) {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            this
          );
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
      const reply = new Uint8Array(await res.arrayBuffer());
      if (reply.length > 0) {
        const encoder = this.readFrames(reply);
        if (encoding.length(encoder) > 1) {
          this.send(encoding.toUint8Array(encoder));
        }
      }
    } catch {
      // transient network failure; the SSE stream reconnects and resyncs
    }
  }
}
