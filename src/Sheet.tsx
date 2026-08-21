import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import * as Y from "yjs";
import {
  cellValue,
  getSheet,
  GROW_ROWS,
  INITIAL_COLS,
  INITIAL_ROWS,
  setCell,
  snapshot,
  writeBlock,
} from "./sheet";
import { parseTableClipboard } from "./smartPaste";

interface CellRef {
  r: number;
  c: number;
}

interface Rect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

function colLabel(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normRect(a: CellRef, b: CellRef): Rect {
  return {
    r0: Math.min(a.r, b.r),
    c0: Math.min(a.c, b.c),
    r1: Math.max(a.r, b.r),
    c1: Math.max(a.c, b.c),
  };
}

function toTsv(value: string): string {
  return value.includes("\n") || value.includes("\t") || value.includes('"')
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

export function Sheet({ doc }: { doc: Y.Doc }) {
  const sheet = useMemo(() => getSheet(doc), [doc]);
  const [cells, setCells] = useState<string[][]>(() => snapshot(sheet));
  const [minRows, setMinRows] = useState(INITIAL_ROWS);
  const [sel, setSel] = useState<CellRef>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const undoRef = useRef<Y.UndoManager | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const displayRows = Math.max(minRows, sheet.length);
  const rect = anchor ? normRect(anchor, sel) : normRect(sel, sel);
  const inRect = (r: number, c: number) =>
    r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;

  useEffect(() => {
    const onChange = () => setCells(snapshot(sheet));
    sheet.observeDeep(onChange);
    return () => sheet.unobserveDeep(onChange);
  }, [sheet]);

  useEffect(() => {
    const um = new Y.UndoManager([sheet]);
    undoRef.current = um;
    return () => {
      um.destroy();
      undoRef.current = null;
    };
  }, [sheet]);

  useEffect(() => {
    gridRef.current?.focus();
    const stopDrag = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mouseup", stopDrag);
    return () => window.removeEventListener("mouseup", stopDrag);
  }, []);

  useEffect(() => {
    gridRef.current
      ?.querySelector<HTMLTableCellElement>(`td[data-r="${sel.r}"][data-c="${sel.c}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sel]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const growIfNeeded = (r: number) => {
    if (r >= displayRows - 3) setMinRows(displayRows + GROW_ROWS);
  };

  const moveTo = (next: CellRef, extend: boolean) => {
    growIfNeeded(next.r);
    setSel(next);
    setAnchor(extend ? (anchor ?? sel) : null);
  };

  const moveSel = (dr: number, dc: number, extend: boolean) => {
    const r = Math.max(0, Math.min(displayRows - 1, sel.r + dr));
    const c = Math.max(0, Math.min(INITIAL_COLS - 1, sel.c + dc));
    moveTo({ r, c }, extend);
  };

  const commit = (value: string, then?: () => void) => {
    setEditing(false);
    if (value !== cellValue(sheet, sel.r, sel.c)) {
      setCell(doc, sheet, sel.r, sel.c, value);
    }
    gridRef.current?.focus();
    then?.();
  };

  const beginEdit = (initial?: string) => {
    setDraft(initial ?? cellValue(sheet, sel.r, sel.c));
    setEditing(true);
  };

  const rangeTsv = (): string => {
    const lines: string[] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const cols: string[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        cols.push(toTsv(cellValue(sheet, r, c)));
      }
      lines.push(cols.join("\t"));
    }
    return lines.join("\n");
  };

  const clearRange = () => {
    doc.transact(() => {
      for (let r = rect.r0; r <= rect.r1; r++) {
        for (let c = rect.c0; c <= rect.c1; c++) {
          if (cellValue(sheet, r, c) !== "") setCell(doc, sheet, r, c, "");
        }
      }
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) undoRef.current?.redo();
      else undoRef.current?.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      undoRef.current?.redo();
      return;
    }
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        moveSel(-1, 0, e.shiftKey);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveSel(1, 0, e.shiftKey);
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveSel(0, -1, e.shiftKey);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveSel(0, 1, e.shiftKey);
        break;
      case "Tab":
        e.preventDefault();
        moveSel(0, e.shiftKey ? -1 : 1, false);
        break;
      case "Enter":
      case "F2":
        e.preventDefault();
        beginEdit();
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        clearRange();
        break;
      default:
        if (!mod && !e.altKey && e.key.length === 1) {
          e.preventDefault();
          setAnchor(null);
          beginEdit(e.key);
        }
    }
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(draft, () => moveSel(1, 0, false));
    } else if (e.key === "Tab") {
      e.preventDefault();
      commit(draft, () => moveSel(0, e.shiftKey ? -1 : 1, false));
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
      gridRef.current?.focus();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const rows = parseTableClipboard(cd);
    if (!rows) return;
    e.preventDefault();
    writeBlock(doc, sheet, sel.r, sel.c, rows);
    growIfNeeded(sel.r + rows.length + 3);
  };

  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    e.clipboardData?.setData("text/plain", rangeTsv());
    e.preventDefault();
  };

  const onCut = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    e.clipboardData?.setData("text/plain", rangeTsv());
    e.preventDefault();
    clearRange();
  };

  const onCellMouseDown = (r: number, c: number) => {
    draggingRef.current = true;
    setEditing(false);
    setSel({ r, c });
    setAnchor({ r, c });
  };

  const onCellEnter = (r: number, c: number) => {
    if (!draggingRef.current) return;
    growIfNeeded(r);
    setSel({ r, c });
  };

  const headerCell =
    "border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-center text-xs font-medium text-neutral-500 select-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400";

  return (
    <div
      ref={gridRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onCopy={onCopy}
      onCut={onCut}
      className="h-full overflow-auto outline-none"
    >
      <table className="border-collapse text-sm">
        <thead>
          <tr>
            <th className={`${headerCell} sticky left-0 top-0 z-30 w-12`} />
            {Array.from({ length: INITIAL_COLS }, (_, c) => (
              <th
                key={c}
                className={`${headerCell} sticky top-0 z-20 min-w-24 ${
                  sel.c === c ? "bg-blue-100 dark:bg-blue-950" : ""
                }`}
              >
                {colLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: displayRows }, (_, r) => (
            <tr key={r}>
              <th
                className={`${headerCell} sticky left-0 z-10 w-12 ${
                  sel.r === r ? "bg-blue-100 dark:bg-blue-950" : ""
                }`}
              >
                {r + 1}
              </th>
              {Array.from({ length: INITIAL_COLS }, (_, c) => {
                const focused = sel.r === r && sel.c === c;
                const inRange = inRect(r, c);
                return (
                  <td
                    key={c}
                    data-r={r}
                    data-c={c}
                    onMouseDown={() => onCellMouseDown(r, c)}
                    onMouseEnter={() => onCellEnter(r, c)}
                    onDoubleClick={() => {
                      setSel({ r, c });
                      setAnchor(null);
                      beginEdit();
                    }}
                    className={`h-6 max-w-64 min-w-24 cursor-cell border border-neutral-200 px-2 py-0.5 align-top dark:border-neutral-800 ${
                      focused
                        ? "ring-2 ring-inset ring-blue-500"
                        : inRange
                          ? "bg-blue-50 dark:bg-blue-950/40"
                          : "hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
                    }`}
                  >
                    {focused && editing ? (
                      <input
                        ref={inputRef}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={onInputKeyDown}
                        onBlur={() => commit(draft)}
                        className="block w-full bg-transparent outline-none"
                      />
                    ) : (
                      cells[r]?.[c] ?? ""
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
