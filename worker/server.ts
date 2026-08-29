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
// Browser-facing SSE keepalive. Runs inside the plain front Worker, which has
// no duration dimension — cadence only needs to survive middlebox idle timeouts.
const SSE_KEEPALIVE_MS = 15_000;
// Relay->DO liveness. Answered at the edge by setWebSocketAutoResponse, so it
// never wakes or bills the DO.
const DO_LEG_PING_MS = 60_000;
const ROOM_TTL_MS = 48 * 60 * 60 * 1000;

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

    // Blocked-network clients: hold the open stream here in the plain Worker
    // (CPU-billed only) and bridge it to a hibernating WebSocket on the DO.
    if (request.method === "GET" && url.searchParams.get("transport") === "http") {
      return relaySse(request, stub);
    }
    return stub.fetch(request);
  },
};

async function relaySse(
  request: Request,
  stub: DurableObjectStub<YpadRoom>
): Promise<Response> {
  const url = new URL(request.url);
  const upgradeRes = await stub.fetch(
    new Request(url.toString(), { headers: { Upgrade: "websocket" } })
  );
  if (upgradeRes.status !== 101 || !upgradeRes.webSocket) {
    return new Response("relay upgrade failed", { status: 502 });
  }
  const ws = upgradeRes.webSocket;
  ws.accept();
  ws.binaryType = "arraybuffer";

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const text = new TextEncoder();
  let open = true;
  let ping: ReturnType<typeof setInterval>;
  let doPing: ReturnType<typeof setInterval>;

  const stop = () => {
    open = false;
    clearInterval(ping);
    clearInterval(doPing);
  };

  const write = async (chunk: string) => {
    if (!open) return;
    try {
      await writer.write(text.encode(chunk));
    } catch {
      stop();
      try { ws.close(1000, "stream closed"); } catch {}
      void writer.close().catch(() => {});
    }
  };

  ws.addEventListener("message", (e) => {
    if (!open) return;
    if (typeof e.data === "string") return; // "pong" from the auto-response leg
    void write(`data: ${toBase64(new Uint8Array(e.data))}\n\n`);
  });

  ws.addEventListener("close", () => {
    stop();
    void writer.close().catch(() => {});
  });
  ws.addEventListener("error", () => {
    stop();
    try { ws.close(1000, "stream error"); } catch {}
    void writer.close().catch(() => {});
  });
  request.signal.addEventListener("abort", () => {
    stop();
    try { ws.close(1000, "client gone"); } catch {}
    void writer.close().catch(() => {});
  });

  ping = setInterval(() => void write(": ping\n\n"), SSE_KEEPALIVE_MS);
  doPing = setInterval(() => {
    try { ws.send("ping"); } catch {}
  }, DO_LEG_PING_MS);

  // Writes must not be awaited before the Response exists — nothing is reading
  // the stream yet, and workerd holds the write until it is. The single writer
  // keeps chunks ordered once streaming starts.
  void write("retry: 5000\n\n");

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export class YpadRoom extends DurableObject<Env> {
  private doc!: Y.Doc;
  private awareness!: awarenessProtocol.Awareness;
  // Ephemeral per-socket awareness attribution; rebuilt lazily after hibernation
  // wakes (stale presence then expires via the protocol's own ~30s timeout).
  private controlled = new Map<WebSocket, Set<number>>();
  private loaded = false;
  private deleted = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private ttlMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ttlMs = Number(env.ROOM_TTL_MS ?? "") || ROOM_TTL_MS;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
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
        origin: WebSocket | null
      ) => {
        const changedClients = added.concat(updated, removed);
        if (origin !== null) {
          let controlled = this.controlled.get(origin);
          if (controlled === undefined) {
            controlled = new Set<number>();
            this.controlled.set(origin, controlled);
          }
          added.forEach((id) => controlled.add(id));
          removed.forEach((id) => controlled.delete(id));
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
      return this.handleWebSocket(request);
    }
    return this.handleHttp(request);
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    await this.ctx.storage.deleteAlarm();
    this.deleted = false;

    const pair = new WebSocketPair();
    // The token tag lets getWebSockets(token) resolve POST attribution and
    // close=1 beacons across hibernation without any heap-side registry.
    const token = new URL(request.url).searchParams.get("token");
    this.ctx.acceptWebSocket(pair[1], token ? [token] : []);
    this.sendInitialState(pair[1]);

    return new Response(null, { status: 101, webSocket: pair[0] });
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
    if (request.method === "POST") {
      const reqUrl = new URL(request.url);
      const token = reqUrl.searchParams.get("token");
      // Explicit goodbye from the client; closing the socket routes through
      // webSocketClose for cleanup and TTL arming.
      if (reqUrl.searchParams.get("close") === "1" && token) {
        const target = this.ctx.getWebSockets(token)[0];
        if (target) target.close(1000, "client goodbye");
        return new Response(null, { headers: cors });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      let reply: Uint8Array | null = null;
      if (body.length > 0) {
        const client = token ? (this.ctx.getWebSockets(token)[0] ?? null) : null;
        reply = this.handleMessage(client, body);
      }
      return new Response(reply, {
        headers: { "Content-Type": "application/octet-stream", ...cors },
      });
    }
    return new Response("Method not allowed", { status: 405 });
  }

  private sendInitialState(client: WebSocket): void {
    try {
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
    } catch {}
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === "string") return; // relay liveness frames are auto-answered
    const reply = this.handleMessage(ws, new Uint8Array(message));
    if (reply) {
      try {
        ws.send(reply);
      } catch {}
    }
  }

  async webSocketClose(ws: WebSocket) {
    const controlled = this.controlled.get(ws);
    this.controlled.delete(ws);
    if (controlled && controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        Array.from(controlled),
        "websocket close"
      );
    }
    const rest = this.ctx.getWebSockets().filter((w) => w !== ws);
    if (rest.length === 0) {
      void this.finalizeDisconnect();
    }
  }

  async webSocketError(ws: WebSocket) {
    const controlled = this.controlled.get(ws);
    this.controlled.delete(ws);
    if (controlled && controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        Array.from(controlled),
        "websocket error"
      );
    }
    try {
      ws.close(1000, "error");
    } catch {}
    const rest = this.ctx.getWebSockets().filter((w) => w !== ws);
    if (rest.length === 0) {
      void this.finalizeDisconnect();
    }
  }

  private handleMessage(client: WebSocket | null, message: Uint8Array): Uint8Array | null {
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

  // The runtime's socket registry is the source of truth; nothing connection-
  // related lives in the heap, so hibernation cycles can't orphan anything.
  private broadcast(message: Uint8Array) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {}
    }
  }

  // Last one out: persist final state, then arm the expiry countdown. Anyone
  // joining before it fires cancels the alarm.
  private async finalizeDisconnect(): Promise<void> {
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now() + this.ttlMs);
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + this.ttlMs);
      return;
    }
    this.deleted = true;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.initDoc();
    this.loaded = true;
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