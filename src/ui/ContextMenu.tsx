import { useEffect, useRef } from "react";
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  ClipboardPaste,
  Copy,
  Eraser,
  Scissors,
  Trash2,
} from "lucide-react";
import type { Rect, SheetCommands } from "../Sheet";

interface ContextMenuProps {
  x: number;
  y: number;
  rect: Rect;
  commands: SheetCommands;
  onClose: () => void;
}

const item =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800";
const sep = "my-1 border-t border-neutral-200 dark:border-neutral-800";

// Operates only on the selection snapshot captured at open time; the grid may
// re-render underneath while the menu is up.
export function ContextMenu({ x, y, rect, commands, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  const rows = rect.r1 - rect.r0 + 1;
  const cols = rect.c1 - rect.c0 + 1;
  const rowLabel = rows > 1 ? `${rows} rows` : "row";
  const colLabel = cols > 1 ? `${cols} columns` : "column";
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const paste = () => {
    navigator.clipboard
      .readText()
      .then((t) => commands.pasteFromClipboardText(t, rect))
      .catch(() => {});
    onClose();
  };

  // Clamp so the menu never spills past the viewport edges.
  const left = Math.max(8, Math.min(x, window.innerWidth - 232));
  const top = Math.max(8, Math.min(y, window.innerHeight - 420));

  return (
    <div
      ref={ref}
      style={{ left, top }}
      className="fixed z-50 w-56 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
    >
      <button
        type="button"
        className={item}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run(() => commands.cutToClipboard(rect))}
      >
        <Scissors size={14} /> Cut
      </button>
      <button
        type="button"
        className={item}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run(() => commands.copyToClipboard(rect))}
      >
        <Copy size={14} /> Copy
      </button>
      {typeof navigator.clipboard?.readText === "function" && (
        <button
          type="button"
          className={item}
          onMouseDown={(e) => e.preventDefault()}
          onClick={paste}
        >
          <ClipboardPaste size={14} /> Paste
        </button>
      )}
      <div className={sep} />
      <button
        type="button"
        className={item}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run(() => commands.clearSelection(rect))}
      >
        <Eraser size={14} /> Clear contents
      </button>
      <div className={sep} />
      <button
        type="button"
        className={item}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run(() => commands.insertRowsAbove(rect))}
      >
        <ArrowUpToLine size={14} /> Insert {rowLabel} above
      </button>
      <button
        type="button"
        className={item}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run(() => commands.insertRowsBelow(rect))}
      >
        <ArrowDownToLine size={14} /> Insert {rowLabel} below
      </button>
      <button
        type="button"
        className={item}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run(() => commands.deleteSelectedRows(rect))}
      >
        <Trash2 size={14} /> Delete {rowLabel}
      </button>
      <div className={sep} />
      <button
        type="button"
        className={item}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run(() => commands.insertColsLeft(rect))}
      >
        <ArrowLeftToLine size={14} /> Insert {colLabel} left
      </button>
      <button
        type="button"
        className={item}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run(() => commands.insertColsRight(rect))}
      >
        <ArrowRightToLine size={14} /> Insert {colLabel} right
      </button>
      <button
        type="button"
        className={item}
        onMouseDown={(e) => e.preventDefault()}
        onClick={run(() => commands.deleteSelectedCols(rect))}
      >
        <Trash2 size={14} /> Delete {colLabel}
      </button>
    </div>
  );
}
