import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { Languages, Moon, Share2, Sun } from "lucide-react";
import { Editor } from "./editor";
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

function syncServerUrl(): string {
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(SYNC_HOST);
  return `${isLocal ? "ws" : "wss"}://${SYNC_HOST}`;
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

export default function App() {
  const [roomId] = useState(roomIdFromHash);
  const [doc] = useState(() => new Y.Doc());
  const providerRef = useRef<WebsocketProvider | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [dark, setDark] = useState(loadTheme);
  const [language, setLanguage] = useState("plain");
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
    const p = new WebsocketProvider(syncServerUrl(), roomId, doc, {
      connect: false,
    });
    providerRef.current = p;
    setProvider(p);

    const awareness = p.awareness;
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

    const onStatus = (e: { status: string }) => {
      if (
        e.status === "connecting" ||
        e.status === "connected" ||
        e.status === "disconnected"
      ) {
        setStatus(e.status);
      }
    };

    awareness.on("change", onAwareness);
    p.on("status", onStatus);
    p.connect();

    return () => {
      awareness.off("change", onAwareness);
      p.off("status", onStatus);
      p.disconnect();
      p.destroy();
      providerRef.current = null;
      setProvider(null);
    };
  }, [roomId, doc]);

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
    providerRef.current?.awareness.setLocalStateField("user", next);
  }, []);

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
          <span className="hidden rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300 sm:inline">
            #{roomId.slice(0, 6)}
          </span>
        </div>

        <div className="flex-1" />

        <StatusDot status={status} />

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
        {provider && (
          <Editor doc={doc} awareness={provider.awareness} dark={dark} language={language} />
        )}
        {empty && status === "connected" && (
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