import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { Awareness } from "y-protocols/awareness";
import { HttpSyncProvider } from "./sync/httpProvider";
import { EncHttpSyncProvider } from "./sync/encHttpProvider";
import {
  base64ToBytes,
  checkVerifier,
  decryptFrame,
  deriveRoomKey,
  encryptFrame,
  exportRoomKey,
  importRoomKey,
  meetsMinLength,
  sessionKeyName,
  verifierPlaintext,
} from "./crypto";
import {
  FileText,
  Languages,
  Lock,
  LockOpen,
  Moon,
  Share2,
  Sun,
  Table2,
} from "lucide-react";
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

interface RoomStatus {
  mode: "plain" | "enc";
  hasData: boolean;
  verifier?: string;
}

// Fail closed: if the status cannot be verified, the caller must not open a
// plaintext session on what may be an encrypted pad. Retries ride out brief
// 5xx windows before the error gate shows.
async function fetchRoomStatus(roomId: string): Promise<RoomStatus> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
    try {
      const res = await fetch(
        `${httpSyncServerUrl()}/${encodeURIComponent(roomId)}?status=1`,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as RoomStatus;
      if (body.mode === "enc") {
        return { mode: "enc", hasData: body.hasData, verifier: body.verifier };
      }
      return { mode: "plain", hasData: body.hasData };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("status unreachable");
}

type LockKind = "checking" | "setup" | "plain" | "locked" | "unlocked" | "error";

function PasswordModal({
  title,
  subtitle,
  confirm,
  error,
  busy,
  onSubmit,
  onCancel,
  cancelLabel,
  extra,
}: {
  title: string;
  subtitle: string;
  confirm: boolean;
  error: string | null;
  busy: boolean;
  onSubmit: (password: string) => void;
  onCancel: (() => void) | null;
  cancelLabel: string;
  extra?: React.ReactNode;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const tooShort = confirm && pw.length > 0 && !meetsMinLength(pw);

  const submit = () => {
    if (confirm) {
      if (pw !== pw2) {
        setMismatch(true);
        return;
      }
      if (!meetsMinLength(pw)) return;
    }
    if (!pw) return;
    onSubmit(pw);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
          <Lock size={16} />
          {title}
        </div>
        <p className="mb-4 text-xs text-neutral-500 dark:text-neutral-400">
          {subtitle}
        </p>
        <input
          autoFocus
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={confirm ? "Choose a password" : "Pad password"}
          className="mb-2 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        />
        {confirm && (
          <>
            <input
              type="password"
              value={pw2}
              onChange={(e) => {
                setPw2(e.target.value);
                setMismatch(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="Confirm password"
              className="mb-2 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
            <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
              {tooShort
                ? "Use at least 8 characters."
                : "The password never leaves your device."}
            </p>
          </>
        )}
        {mismatch && (
          <p className="mb-2 text-xs text-red-600 dark:text-red-400">
            Passwords don&apos;t match.
          </p>
        )}
        {error && (
          <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
        {extra}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy || !pw || (confirm && !meetsMinLength(pw))}
            onClick={submit}
            className="flex-1 rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {busy ? "Working…" : confirm ? "Set password" : "Unlock"}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {cancelLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
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
  const [lock, setLock] = useState<LockKind>("checking");
  const [status2, setStatus2] = useState<RoomStatus | null>(null);
  const [encKey, setEncKey] = useState<CryptoKey | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [showAddPw, setShowAddPw] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [lockError, setLockError] = useState<string | null>(null);
  const encKeyRef = useRef<CryptoKey | null>(null);
  encKeyRef.current = encKey;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    let cancelled = false;
    setLock("checking");
    setStatus2(null);
    setEncKey(null);
    setPwError(null);
    setShowAddPw(false);
    setLockError(null);
    void fetchRoomStatus(roomId)
      .then(async (st) => {
        if (cancelled) return;
        setStatus2(st);
        if (st.mode === "enc") {
          if (!st.verifier) {
            setLockError(
              "This pad is encrypted, but its lock data is incomplete on the server.",
            );
            setLock("error");
            return;
          }
          const cached = sessionStorage.getItem(sessionKeyName(roomId));
          if (cached) {
            try {
              const key = await importRoomKey(cached);
              const plain = await decryptFrame(key, base64ToBytes(st.verifier));
              if (checkVerifier(plain, roomId)) {
                setEncKey(key);
                setLock("unlocked");
                return;
              }
            } catch {
              // fall through to password prompt
            }
            sessionStorage.removeItem(sessionKeyName(roomId));
          }
          setLock("locked");
        } else if (!st.hasData) {
          setLock("setup");
        } else {
          setLock("plain");
        }
      })
      .catch(() => {
        if (!cancelled) setLock("error");
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, checkAttempt]);

  async function cacheKey(key: CryptoKey) {
    try {
      sessionStorage.setItem(sessionKeyName(roomId), await exportRoomKey(key));
    } catch {
      // private mode / quota: memory-only is fine
    }
  }

  async function setupPassword(password: string, takeover: boolean) {
    setPwBusy(true);
    setPwError(null);
    try {
      const key = await deriveRoomKey(password, roomId);
      const verifier = await encryptFrame(key, verifierPlaintext(roomId));
      const res = await fetch(
        `${httpSyncServerUrl()}/${encodeURIComponent(roomId)}?initEnc=1${takeover ? "&takeover=1" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: new Blob([verifier as BlobPart]),
        },
      );
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string };
        if (body.error === "already-encrypted") {
          const st = await fetchRoomStatus(roomId);
          setStatus2(st);
          setLock("locked");
          setPwError("Someone just set a password — enter it to unlock.");
        } else {
          setPwError("This pad already has content on the server.");
        }
        return;
      }
      if (!res.ok) {
        setPwError("Couldn't reach the server. Try again.");
        return;
      }
      await cacheKey(key);
      setEncKey(key);
      setStatus2({ mode: "enc", hasData: false });
      setLock("unlocked");
      setShowAddPw(false);
    } catch {
      setPwError("Couldn't reach the server. Try again.");
    } finally {
      setPwBusy(false);
    }
  }

  async function unlockPassword(password: string) {
    const st = status2;
    if (!st || st.mode !== "enc" || !st.verifier) return;
    setPwBusy(true);
    setPwError(null);
    try {
      const key = await deriveRoomKey(password, roomId);
      let plain: Uint8Array;
      try {
        plain = await decryptFrame(key, base64ToBytes(st.verifier));
      } catch {
        setPwError("Wrong password. Try again.");
        return;
      }
      if (!checkVerifier(plain, roomId)) {
        setPwError("Wrong password. Try again.");
        return;
      }
      await cacheKey(key);
      setEncKey(key);
      setLock("unlocked");
    } finally {
      setPwBusy(false);
    }
  }

  function forgetKey() {
    sessionStorage.removeItem(sessionKeyName(roomId));
    setEncKey(null);
    setLock("locked");
  }

  function newPad() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const fresh = Array.from(bytes, (b) => CHARS[b % CHARS.length]).join("");
    window.location.hash = `#${fresh}`;
    window.location.reload();
  }

  useEffect(() => {
    if (lock !== "plain") return;
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
  }, [roomId, doc, awareness, lock]);

  useEffect(() => {
    if (lock !== "unlocked" || !encKey) return;
    const p = new EncHttpSyncProvider(httpSyncServerUrl(), roomId, doc, encKey, {
      awareness,
    });
    const onStatus = (e: { status: string }) => {
      if (
        e.status === "connecting" ||
        e.status === "connected" ||
        e.status === "disconnected"
      ) {
        setStatus(e.status as ConnectionStatus);
      }
    };
    p.on("status", onStatus);
    p.connect();
    return () => {
      p.off("status", onStatus);
      p.disconnect();
      p.destroy();
    };
  }, [roomId, doc, awareness, lock, encKey]);

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

        {lock === "unlocked" && (
          <span
            title="End-to-end encrypted: the server only holds ciphertext. Anyone opening this link needs the password."
            className="hidden items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 sm:flex dark:text-emerald-400"
          >
            <Lock size={12} />
            Encrypted
          </span>
        )}
        {lock === "plain" && (
          <span
            title="Not encrypted: the server operator can read this pad. Don't paste secrets."
            className="hidden items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 sm:flex dark:text-amber-400"
          >
            <LockOpen size={12} />
            Not encrypted
          </span>
        )}

        <div
          role="group"
          aria-label="Editor mode"
          className="flex h-8 items-center rounded-md border border-neutral-200 bg-neutral-100 p-0.5 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <button
            type="button"
            onClick={() => setMode("text")}
            aria-pressed={mode === "text"}
            title="Text mode"
            className={`flex h-full items-center gap-1.5 rounded px-2 text-xs font-medium ${
              mode === "text"
                ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100"
                : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }`}
          >
            <FileText size={14} />
            <span className="hidden sm:inline">Text</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("excel")}
            aria-pressed={mode === "excel"}
            title="Table mode"
            className={`flex h-full items-center gap-1.5 rounded px-2 text-xs font-medium ${
              mode === "excel"
                ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100"
                : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }`}
          >
            <Table2 size={14} />
            <span className="hidden sm:inline">Table</span>
          </button>
        </div>

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

        {lock === "unlocked" && (
          <ToolbarButton onClick={forgetKey} title="Lock pad (forget password)">
            <Lock size={16} />
          </ToolbarButton>
        )}
        {lock === "plain" && status2?.hasData && (
          <ToolbarButton
            onClick={() => {
              setPwError(null);
              setShowAddPw(true);
            }}
            title="Protect with password"
          >
            <Lock size={16} />
          </ToolbarButton>
        )}

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

      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        encrypted={lock === "unlocked"}
      />

      {lock === "checking" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white dark:bg-neutral-950">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Checking pad…
          </p>
        </div>
      )}

      {lock === "error" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white p-4 dark:bg-neutral-950">
          <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-1 flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
              <Lock size={16} />
              Couldn&apos;t verify this pad
            </div>
            <p className="mb-4 text-xs text-neutral-500 dark:text-neutral-400">
              {lockError ??
                "The sync server couldn't be reached. The pad stays locked rather than risk opening an encrypted pad as plaintext — your content is safe on the server."}
            </p>
            <button
              type="button"
              onClick={() => setCheckAttempt((n) => n + 1)}
              className="w-full rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {lock === "setup" && (
        <PasswordModal
          title="Protect this pad?"
          subtitle="Set a password to encrypt it end-to-end — the server will only hold ciphertext. Anyone opening the link needs the password."
          confirm
          error={pwError}
          busy={pwBusy}
          onSubmit={(pw) => void setupPassword(pw, false)}
          onCancel={() => setLock("plain")}
          cancelLabel="Skip (not encrypted)"
        />
      )}

      {lock === "locked" && (
        <PasswordModal
          title="This pad is encrypted"
          subtitle="Enter the password to decrypt it. The password never leaves your device."
          confirm={false}
          error={pwError}
          busy={pwBusy}
          onSubmit={(pw) => void unlockPassword(pw)}
          onCancel={newPad}
          cancelLabel="New pad instead"
        />
      )}

      {showAddPw && lock === "plain" && (
        <PasswordModal
          title="Protect this pad?"
          subtitle="Anything already on the server was readable before this. Setting a password encrypts everything from now on — tell others to reload and enter it."
          confirm
          error={pwError}
          busy={pwBusy}
          onSubmit={(pw) => void setupPassword(pw, true)}
          onCancel={() => setShowAddPw(false)}
          cancelLabel="Cancel"
        />
      )}
    </div>
  );
}