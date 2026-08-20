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

export interface HttpSyncProviderEvents {
  status: (event: { status: "connecting" | "connected" | "disconnected" }) => void;
}

/**
 * Yjs provider that rides the same y-protocols wire messages over plain HTTPS:
 * server -> client via SSE, client -> server via POST. Used as a fallback when
 * the network blocks WebSocket upgrades (SSE is a plain HTTP GET/POST and passes
 * through most proxies and captive portals).
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
    this.maxBackoffTime = opts.maxBackoffTime ?? 2500;
    this.token = crypto.randomUUID();

    this._updateHandler = (update, origin) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeUpdate(encoder, update);
        this.post(encoding.toUint8Array(encoder));
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
      this.post(encoding.toUint8Array(encoder));
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
    if (this.es !== null) {
      this.es.close();
      this.es = null;
    }
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "client disconnected"
    );
    this.emit("status", [{ status: "disconnected" }]);
  }

  destroy(): void {
    this.disconnect();
    this.awareness.off("update", this._awarenessUpdateHandler);
    this.doc.off("update", this._updateHandler);
    super.destroy();
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
      void this.post(encoding.toUint8Array(encoder));

      if (this.awareness.getLocalState() !== null) {
        const aEncoder = encoding.createEncoder();
        encoding.writeVarUint(aEncoder, messageAwareness);
        encoding.writeVarUint8Array(
          aEncoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
        );
        void this.post(encoding.toUint8Array(aEncoder));
      }
    };

    es.onmessage = (event) => {
      if (this.es !== es) return;
      const buf = fromBase64(event.data as string);
      const encoder = this.readMessage(buf, true);
      if (encoding.length(encoder) > 1) {
        void this.post(encoding.toUint8Array(encoder));
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

  private readMessage(buf: Uint8Array, emitSynced: boolean): encoding.Encoder {
    const decoder = decoding.createDecoder(buf);
    const encoder = encoding.createEncoder();
    const messageType = decoding.readVarUint(decoder);
    if (messageType === messageSync) {
      encoding.writeVarUint(encoder, messageSync);
      const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (
        emitSynced &&
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
    return encoder;
  }

  private async post(buf: Uint8Array): Promise<void> {
    if (!this.shouldConnect) return;
    try {
      const res = await fetch(`${this.url}?transport=http&token=${this.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(buf),
      });
      if (!res.ok) return;
      const reply = new Uint8Array(await res.arrayBuffer());
      if (reply.length > 0) {
        const encoder = this.readMessage(reply, true);
        if (encoding.length(encoder) > 1) {
          await this.post(encoding.toUint8Array(encoder));
        }
      }
    } catch {
      // transient network failure; the SSE stream reconnects and resyncs
    }
  }
}