import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { Awareness } from "y-protocols/awareness";
import { HttpSyncProvider } from "./sync/httpProvider";
import { Languages, Moon, Share2, Sun, Table2 } from "lucide-react";
import { Editor } from "./editor";
import { Sheet } from "./Sheet";
import { ShareModal } from "./share";
import {
  loadTheme,
  loadUser,
  persistTheme,
  persistUser,
  peersFromStates,
  resolveHue,
  type Peer,
  type UserInfo,
} from "./presence";
import { LANGUAGES, languageLabel } from "./language";
import { AvatarCluster } from "./ui/AvatarCluster";
import { Dropdown } from "./ui/Dropdown";
import { StatusDot, type ConnectionStatus } from "./ui/StatusDot";
import { ToolbarButton } from "./ui/ToolbarButton";

const SYNC_HOST = import.meta.env.VITE_SYNC_HOST ?? "localhost:8787";
const WS_CONNECT_TIMEOUT_MS = 5000;
const WS_SYNC_TIMEOUT_MS = 10000;
// Tear the DO connection down after this much local inactivity so the Durable
// Object can hibernate; wall-clock duration is the free-tier constraint.
const IDLE_DISCONNECT_MS = 90_000;
const HTTP_IDLE_DISCONNECT_MS = 30_000;

type EditorMode = "text" | "excel";

function syncServerUrl(): string {
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(SYNC_HOST);
  return `${isLocal ? "ws" : "wss"}://${SYNC_HOST}`;
}

function httpSyncServerUrl(): string {
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(SYNC_HOST);
  return `${isLocal ? "http" : "https"}://${SYNC_HOST}`;
}

const CHARS = "abcdefghijklmnopqrstuvwxyz234567";

function randomRoomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CHARS[b % CHARS.length]).join("");
}

function roomIdFromHash(): string {
  const id = window.location.hash.slice(1);
  if (id) return id;
  const fresh = randomRoomId();
  window.history.replaceState(null, "", `#${fresh}`);
  return fresh;
}

interface SyncProviderLike {
  off(name: "status", f: (e: { status: string }) => void): unknown;
  off(name: "sync", f: (synced: boolean) => void): unknown;
  connect(): void;
  disconnect(): void;
  destroy(): void;
}

export default function App() {
  const [roomId] = useState(roomIdFromHash);
  const [doc] = useState(() => new Y.Doc());
  const [awareness] = useState(() => new Awareness(doc));
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [dark, setDark] = useState(loadTheme);
  const [language, setLanguage] = useState("plain");
  const [mode, setMode] = useState<EditorMode>("text");
  const [empty, setEmpty] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [user, setUser] = useState<UserInfo>(loadUser);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(user.name);
  const userRef = useRef(user);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    let current: WebsocketProvider | HttpSyncProvider | null = null;
    let wsEverConnected = false;
    let wsSynced = false;
    let connectTimeout: number | undefined;
    let syncTimeout: number | undefined;
    let idleTimer: number | undefined;
    let cancelled = false;
    let wantConnect = true;
    let lastActivity = 0;

    function setStatusFrom(e: { status: string }) {
      if (
        e.status === "connecting" ||
        e.status === "connected" ||
        e.status === "disconnected"
      ) {
        setStatus(e.status);
      }
    }

    function teardown(
      p: SyncProviderLike,
      statusHandler: (e: { status: string }) => void,
      syncHandler: (synced: boolean) => void
    ) {
      p.off("status", statusHandler);
      p.off("sync", syncHandler);
      p.disconnect();
      p.destroy();
    }

    function clearConnectTimeout() {
      if (connectTimeout !== undefined) {
        clearTimeout(connectTimeout);
        connectTimeout = undefined;
      }
    }

    function clearSyncTimeout() {
      if (syncTimeout !== undefined) {
        clearTimeout(syncTimeout);
        syncTimeout = undefined;
      }
    }

    function armConnectTimeout() {
      clearConnectTimeout();
      connectTimeout = setTimeout(() => {
        connectTimeout = undefined;
        if (!cancelled && !wsEverConnected && current instanceof WebsocketProvider) {
          switchToHttp();
        }
      }, WS_CONNECT_TIMEOUT_MS);
    }

    function switchToHttp() {
      if (cancelled || current instanceof HttpSyncProvider) return;
      clearConnectTimeout();
      clearSyncTimeout();
      if (current) teardown(current, onWsStatus, onWsSync);
      const p = new HttpSyncProvider(httpSyncServerUrl(), roomId, doc, {
        awareness,
      });
      current = p;
      p.on("status", setStatusFrom);
      p.connect();
    }

    function onWsSync(synced: boolean) {
      if (synced) {
        wsSynced = true;
        clearSyncTimeout();
      }
    }

    function onWsStatus(e: { status: string }) {
      setStatusFrom(e);
      if (e.status === "connected") {
        wsEverConnected = true;
        clearConnectTimeout();
        if (!wsSynced && syncTimeout === undefined) {
          syncTimeout = setTimeout(() => {
            syncTimeout = undefined;
            if (!cancelled && !wsSynced && current instanceof WebsocketProvider) {
              switchToHttp();
            }
          }, WS_SYNC_TIMEOUT_MS);
        }
      } else if (e.status === "disconnected" && !wsSynced && wantConnect) {
        switchToHttp();
      }
    }

    function clearIdle() {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    }

    function scheduleIdle() {
      clearIdle();
      const delay =
        current instanceof HttpSyncProvider
          ? HTTP_IDLE_DISCONNECT_MS
          : IDLE_DISCONNECT_MS;
      idleTimer = window.setTimeout(() => {
        idleTimer = undefined;
        if (!cancelled && wantConnect && current) {
          wantConnect = false;
          current.disconnect();
        }
      }, delay);
    }

    function reconnectIfNeeded() {
      if (cancelled) return;
      if (!wantConnect) {
        wantConnect = true;
        if (current) {
          current.connect();
          if (current instanceof WebsocketProvider) armConnectTimeout();
        } else {
          armConnectTimeout();
        }
      }
      scheduleIdle();
    }

    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivity < 1000) return;
      lastActivity = now;
      reconnectIfNeeded();
    };

    const onVisibility = () => {
      if (document.hidden) {
        wantConnect = false;
        clearIdle();
        if (current) current.disconnect();
      } else {
        reconnectIfNeeded();
      }
    };

    const p = new WebsocketProvider(syncServerUrl(), roomId, doc, {
      connect: false,
      awareness,
    });
    current = p;
    p.on("status", onWsStatus);
    p.on("sync", onWsSync);
    p.connect();
    armConnectTimeout();
    scheduleIdle();

    window.addEventListener("keydown", onActivity);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("pointermove", onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearConnectTimeout();
      clearSyncTimeout();
      clearIdle();
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("pointermove", onActivity);
      document.removeEventListener("visibilitychange", onVisibility);
      if (current) teardown(current, onWsStatus, onWsSync);
    };
  }, [roomId, doc, awareness]);

  useEffect(() => {
    awareness.setLocalStateField("user", userRef.current);

    const onAwareness = () => {
      const states = awareness.getStates();
      setPeers(peersFromStates(states, awareness.clientID));
      const next = resolveHue(states, awareness.clientID, userRef.current);
      if (next !== userRef.current) {
        userRef.current = next;
        persistUser(next);
        setUser(next);
        awareness.setLocalStateField("user", next);
      }
    };

    awareness.on("change", onAwareness);
    return () => {
      awareness.off("change", onAwareness);
    };
  }, [awareness]);

  useEffect(() => {
    const meta = doc.getMap<string>("ypad");
    const ytext = doc.getText("content");
    const onMeta = () => {
      const value = meta.get("language");
      if (value) setLanguage(value);
    };
    const onText = () => setEmpty(ytext.length === 0);
    meta.observe(onMeta);
    ytext.observe(onText);
    onMeta();
    onText();
    return () => {
      meta.unobserve(onMeta);
      ytext.unobserve(onText);
    };
  }, [doc]);

  const updateUser = useCallback((next: UserInfo) => {
    userRef.current = next;
    setUser(next);
    persistUser(next);
    awareness.setLocalStateField("user", next);
  }, [awareness]);

  const saveName = () => {
    const name = nameDraft.trim() || "Anonymous";
    setEditingName(false);
    updateUser({ ...userRef.current, name });
  };

  const toggleTheme = () => {
    setDark((prev) => {
      const next = !prev;
      persistTheme(next);
      document.documentElement.classList.toggle("dark", next);
      return next;
    });
  };

  const selectLanguage = (id: string) => {
    setLanguage(id);
    doc.getMap<string>("ypad").set("language", id);
  };

  const toggleMode = () => {
    const next: EditorMode = mode === "text" ? "excel" : "text";
    setMode(next);
  };

  const currentLangLabel = languageLabel(language);

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-200 px-3 dark:border-neutral-800 sm:px-4">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold tracking-tight">YPad</span>
          <span
            title={`Room ${roomId}`}
            className="hidden max-w-28 truncate rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300 sm:inline"
          >
            #{roomId}
          </span>
        </div>

        <div className="flex-1" />

        <StatusDot status={status} />

        <ToolbarButton
          onClick={toggleMode}
          title={mode === "excel" ? "Switch to text mode" : "Switch to excel mode"}
          className={
            mode === "excel"
              ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
              : ""
          }
        >
          <Table2 size={16} />
        </ToolbarButton>

        <Dropdown
          align="right"
          buttonClass="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          button={
            <>
              <Languages size={15} />
              <span className="hidden md:inline">{currentLangLabel}</span>
            </>
          }
        >
          {(close) => (
            <div className="w-44 py-0.5">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.id}
                  type="button"
                  onClick={() => {
                    selectLanguage(lang.id);
                    close();
                  }}
                  className={`flex w-full items-center px-3 py-1.5 text-left text-sm ${
                    lang.id === language
                      ? "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                      : "text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800/50"
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          )}
        </Dropdown>

        <ToolbarButton
          onClick={toggleTheme}
          title={dark ? "Switch to light mode" : "Switch to dark mode"}
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </ToolbarButton>

        <ToolbarButton onClick={() => setShareOpen(true)} title="Share pad">
          <Share2 size={16} />
        </ToolbarButton>

        <AvatarCluster peers={peers} />

        <div className="flex items-center">
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") setEditingName(false);
              }}
              className="w-28 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setNameDraft(user.name);
                setEditingName(true);
              }}
              title="Edit your name"
              className="max-w-28 truncate rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {user.name}
            </button>
          )}
        </div>
      </header>

      <main className="relative min-h-0 flex-1">
        {mode === "excel" ? (
          <Sheet doc={doc} />
        ) : (
          <Editor doc={doc} awareness={awareness} dark={dark} language={language} />
        )}
        {empty && status === "connected" && mode === "text" && (
          <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-16">
            <p className="rounded-md bg-white/60 px-3 py-1 text-sm text-neutral-500 backdrop-blur dark:bg-neutral-950/60 dark:text-neutral-400">
              Start typing — anyone with the link can join.
            </p>
          </div>
        )}
      </main>

      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  );
}