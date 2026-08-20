import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;

const STATE_KEY = "state";
const PERSIST_DEBOUNCE_MS = 500;

interface Env {
  YPAD_ROOM: DurableObjectNamespace<YpadRoom>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = decodeURIComponent(url.pathname.slice(1));
    if (!room) return new Response("YPad sync server", { status: 200 });

    const id = env.YPAD_ROOM.idFromName(room);
    const stub = env.YPAD_ROOM.get(id);
    return stub.fetch(request);
  },
};

export class YpadRoom extends DurableObject<Env> {
  private doc = new Y.Doc();
  private awareness = new awarenessProtocol.Awareness(this.doc);
  private conns = new Map<WebSocket, Set<number>>();
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.doc.on("update", (update) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      this.broadcast(message);
      this.schedulePersist();
    });
    this.awareness.on(
      "update",
      (
        {
          added,
          updated,
          removed,
        }: {
          added: number[];
          updated: number[];
          removed: number[];
        },
        origin: WebSocket | null
      ) => {
        const changedClients = added.concat(updated, removed);
        if (origin !== null) {
          const controlled = this.conns.get(origin);
          if (controlled !== undefined) {
            added.forEach((id) => controlled.add(id));
            removed.forEach((id) => controlled.delete(id));
          }
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
        );
        this.broadcast(encoding.toUint8Array(encoder));
      }
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    await this.ensureLoaded();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.conns.set(server, new Set());

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(server, encoding.toUint8Array(encoder));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aEncoder = encoding.createEncoder();
      encoding.writeVarUint(aEncoder, messageAwareness);
      encoding.writeVarUint8Array(
        aEncoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          Array.from(states.keys())
        )
      );
      this.send(server, encoding.toUint8Array(aEncoder));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === "string") return;
    const decoder = decoding.createDecoder(new Uint8Array(message));
    const encoder = encoding.createEncoder();
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
        if (encoding.length(encoder) > 1) {
          this.send(ws, encoding.toUint8Array(encoder));
        }
        break;
      case messageAwareness:
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          ws
        );
        break;
      case messageQueryAwareness: {
        const aEncoder = encoding.createEncoder();
        encoding.writeVarUint(aEncoder, messageAwareness);
        encoding.writeVarUint8Array(
          aEncoder,
          awarenessProtocol.encodeAwarenessUpdate(
            this.awareness,
            Array.from(this.awareness.getStates().keys())
          )
        );
        this.send(ws, encoding.toUint8Array(aEncoder));
        break;
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ) {
    this.closeConn(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    this.closeConn(ws);
  }

  private closeConn(ws: WebSocket) {
    const controlled = this.conns.get(ws);
    this.conns.delete(ws);
    if (controlled) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        Array.from(controlled),
        null
      );
    }
    if (this.conns.size === 0) {
      void this.persist();
    }
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const state = await this.ctx.storage.get<Uint8Array>(STATE_KEY);
    if (state) Y.applyUpdate(this.doc, state);
  }

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist() {
    await this.ctx.storage.put(STATE_KEY, Y.encodeStateAsUpdate(this.doc));
  }

  private send(ws: WebSocket, message: Uint8Array) {
    try {
      ws.send(message);
    } catch {
      this.closeConn(ws);
    }
  }

  private broadcast(message: Uint8Array) {
    for (const ws of this.conns.keys()) {
      this.send(ws, message);
    }
  }
}