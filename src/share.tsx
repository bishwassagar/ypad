import { useEffect, useRef, useState } from "react";
import { Check, Copy, Share2, X } from "lucide-react";

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
}

export function ShareModal({ open, onClose }: ShareModalProps) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) setCopied(false);
  }, [open]);

  if (!open) return null;

  const url = window.location.href;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      inputRef.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            <Share2 size={16} />
            Share this pad
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <X size={16} />
          </button>
        </div>
        <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
          Anyone with this link can view and edit the pad in real time.
        </p>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-700 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
          />
          <button
            type="button"
            onClick={copy}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="mt-4 border-t border-neutral-200 pt-3 text-center text-xs text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
          crafted with ☕ &amp; CRDTs by{" "}
          <a
            href="https://github.com/bishwassagar/ypad"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            Bishwas Sagar
          </a>
        </p>
      </div>
    </div>
  );
}