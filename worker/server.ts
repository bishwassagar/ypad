import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;

// workerd shims `process` (so lib0's buffer picks the Node base64 path) but
// omits Buffer, so implement base64 with the standard Web APIs instead.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const STATE_KEY = "state";
const PERSIST_DEBOUNCE_MS = 500;
const SSE_KEEPALIVE_MS = 15_000;

// A bidirectional byte channel. WebSockets and SSE+POST clients both implement it.
interface Client {
  send(message: Uint8Array): void;
  close(): void;
}

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
  private conns = new Map<Client, Set<number>>();
  private clientsByToken = new Map<string, Client>();
  private wsClients = new Map<WebSocket, Client>();
  private sseTimers = new Map<Client, ReturnType<typeof setInterval>>();
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.doc.on("update", (update) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
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
        origin: Client | null
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
    await this.ensureLoaded();
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocket();
    }
    return this.handleHttp(request);
  }

  private handleWebSocket(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    let wsClient: Client;
    wsClient = {
      send: (message) => {
        try {
          server.send(message);
        } catch {
          this.closeConn(wsClient);
        }
      },
      close: () => this.closeConn(wsClient),
    };

    this.conns.set(wsClient, new Set());
    this.wsClients.set(server, wsClient);
    this.sendInitialState(wsClient);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleHttp(request: Request): Promise<Response> {
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method === "GET") {
      return this.handleSse(request);
    }
    if (request.method === "POST") {
      const body = new Uint8Array(await request.arrayBuffer());
      let reply: Uint8Array | null = null;
      if (body.length > 0) {
        const token = new URL(request.url).searchParams.get("token");
        const client = (token ? this.clientsByToken.get(token) : undefined) ?? null;
        reply = this.handleMessage(client, body);
      }
      return new Response(reply, {
        headers: { "Content-Type": "application/octet-stream", ...cors },
      });
    }
    return new Response("Method not allowed", { status: 405 });
  }

  private handleSse(request: Request): Response {
    const token = new URL(request.url).searchParams.get("token") ?? crypto.randomUUID();

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const text = new TextEncoder();
    let closed = false;

    const client: Client = {
      send: (message) => {
        if (closed) return;
        void writer.write(text.encode(`data: ${toBase64(message)}\n\n`)).catch(() => {
          closed = true;
          this.closeConn(client);
        });
      },
      close: () => {
        if (closed) return;
        closed = true;
        const timer = this.sseTimers.get(client);
        if (timer !== undefined) {
          clearInterval(timer);
          this.sseTimers.delete(client);
        }
        this.clientsByToken.delete(token);
        void writer.close().catch(() => {});
        this.closeConn(client);
      },
    };

    this.conns.set(client, new Set());
    this.clientsByToken.set(token, client);

    const timer = setInterval(() => {
      void writer.write(text.encode(": ping\n\n")).catch(() => {
        closed = true;
        this.closeConn(client);
      });
    }, SSE_KEEPALIVE_MS);
    this.sseTimers.set(client, timer);

    this.sendInitialState(client);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  private sendInitialState(client: Client): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    client.send(encoding.toUint8Array(encoder));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aEncoder = encoding.createEncoder();
      encoding.writeVarUint(aEncoder, messageAwareness);
      encoding.writeVarUint8Array(
        aEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(states.keys()))
      );
      client.send(encoding.toUint8Array(aEncoder));
    }
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === "string") return;
    const client = this.wsClients.get(ws);
    if (!client) return;
    const reply = this.handleMessage(client, new Uint8Array(message));
    if (reply) client.send(reply);
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ) {
    const client = this.wsClients.get(ws);
    if (client) {
      this.wsClients.delete(ws);
      this.closeConn(client);
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    const client = this.wsClients.get(ws);
    if (client) {
      this.wsClients.delete(ws);
      this.closeConn(client);
    }
  }

  private handleMessage(client: Client | null, message: Uint8Array): Uint8Array | null {
    try {
      const decoder = decoding.createDecoder(message);
      const encoder = encoding.createEncoder();
      const messageType = decoding.readVarUint(decoder);
      switch (messageType) {
        case messageSync:
          encoding.writeVarUint(encoder, messageSync);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, client);
          if (encoding.length(encoder) > 1) return encoding.toUint8Array(encoder);
          return null;
        case messageAwareness:
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            client
          );
          return null;
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
          return encoding.toUint8Array(aEncoder);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private closeConn(client: Client) {
    const controlled = this.conns.get(client);
    if (controlled === undefined) return;
    this.conns.delete(client);
    const timer = this.sseTimers.get(client);
    if (timer !== undefined) {
      clearInterval(timer);
      this.sseTimers.delete(client);
    }
    if (controlled.size > 0) {
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

  private broadcast(message: Uint8Array) {
    for (const client of this.conns.keys()) {
      client.send(message);
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
}