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
const ROOM_TTL_MS = 48 * 60 * 60 * 1000;

// A bidirectional byte channel. WebSockets and SSE+POST clients both implement it.
interface Client {
  send(message: Uint8Array): void;
  close(): void;
}

interface Env {
  YPAD_ROOM: DurableObjectNamespace<YpadRoom>;
  ROOM_TTL_MS?: string;
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
  private deleted = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private ttlMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ttlMs = Number(env.ROOM_TTL_MS ?? "") || ROOM_TTL_MS;
    this.initDoc();
  }

  private initDoc(): void {
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
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

  private async handleWebSocket(): Promise<Response> {
    await this.ctx.storage.deleteAlarm();
    this.deleted = false;
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
      const reqUrl = new URL(request.url);
      const token = reqUrl.searchParams.get("token");
      // Explicit goodbye from the client (fetch keepalive survives navigation;
      // the abort signal below covers harder kills where supported).
      if (reqUrl.searchParams.get("close") === "1" && token) {
        const closing = this.clientsByToken.get(token);
        if (closing) closing.close();
        return new Response(null, { headers: { ...cors } });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      let reply: Uint8Array | null = null;
      if (body.length > 0) {
        const client = (token ? this.clientsByToken.get(token) : undefined) ?? null;
        reply = this.handleMessage(client, body);
      }
      return new Response(reply, {
        headers: { "Content-Type": "application/octet-stream", ...cors },
      });
    }
    return new Response("Method not allowed", { status: 405 });
  }

  private async handleSse(request: Request): Promise<Response> {
    await this.ctx.storage.deleteAlarm();
    this.deleted = false;
    const token = new URL(request.url).searchParams.get("token") ?? crypto.randomUUID();

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const text = new TextEncoder();
    let closed = false;

    // Writes into an abandoned stream don't reject in workerd, so detect
    // client disconnects via the request abort signal instead.
    const onAbort = () => {
      closed = true;
      this.closeConn(client);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    const client: Client = {
      send: (message) => {
        if (closed) return;
        void writer.write(text.encode(`data: ${toBase64(message)}\n\n`)).catch(() => {
          closed = true;
          request.signal.removeEventListener("abort", onAbort);
          this.closeConn(client);
        });
      },
      close: () => {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener("abort", onAbort);
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

    // Tell the browser's EventSource to wait 5s between reconnect attempts
    // instead of hammering the worker every ~3s when the stream drops.
    void writer.write(text.encode("retry: 5000\n\n")).catch(() => {
      closed = true;
      this.closeConn(client);
    });

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
    const replies = encoding.createEncoder();
    try {
      const decoder = decoding.createDecoder(message);
      while (decoder.pos < decoder.arr.length) {
        const encoder = encoding.createEncoder();
        const messageType = decoding.readVarUint(decoder);
        switch (messageType) {
          case messageSync:
            encoding.writeVarUint(encoder, messageSync);
            syncProtocol.readSyncMessage(decoder, encoder, this.doc, client);
            if (encoding.length(encoder) > 1) {
              encoding.writeUint8Array(replies, encoding.toUint8Array(encoder));
            }
            break;
          case messageAwareness:
            awarenessProtocol.applyAwarenessUpdate(
              this.awareness,
              decoding.readVarUint8Array(decoder),
              client
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
            encoding.writeUint8Array(replies, encoding.toUint8Array(aEncoder));
            break;
          }
        }
      }
    } catch {
      // truncated or corrupt trailing frame: keep the replies gathered so far
    }
    return encoding.length(replies) > 0 ? encoding.toUint8Array(replies) : null;
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
      void this.finalizeDisconnect();
    }
  }

  // Last one out: persist final state, then arm the expiry countdown. Anyone
  // joining before it fires cancels the alarm.
  private async finalizeDisconnect(): Promise<void> {
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now() + this.ttlMs);
  }

  async alarm(): Promise<void> {
    if (this.conns.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + this.ttlMs);
      return;
    }
    this.deleted = true;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.initDoc();
    this.loaded = true;
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
    if (this.deleted) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist() {
    if (this.deleted) return;
    await this.ctx.storage.put(STATE_KEY, Y.encodeStateAsUpdate(this.doc));
  }
}