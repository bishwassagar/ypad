import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from "react";
import * as Y from "yjs";
import {
  cellValue,
  clearAll,
  clearRange as clearRangeOp,
  deleteCol,
  deleteRows as deleteRowsOp,
  getSheet,
  GROW_COLS,
  GROW_ROWS,
  INITIAL_COLS,
  INITIAL_ROWS,
  insertCol,
  insertRows as insertRowsOp,
  setCell,
  SHEET_ORIGIN,
  snapshot,
  writeBlock,
} from "./sheet";
import { parseTableClipboard, parseTableText } from "./smartPaste";
import { ContextMenu } from "./ui/ContextMenu";

interface CellRef {
  r: number;
  c: number;
}

export interface Rect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

interface MenuState {
  x: number;
  y: number;
  rect: Rect;
}

export type SheetCommand = (rect?: Rect) => void;

export interface SheetCommands {
  insertRowsAbove: SheetCommand;
  insertRowsBelow: SheetCommand;
  deleteSelectedRows: SheetCommand;
  insertColsLeft: SheetCommand;
  insertColsRight: SheetCommand;
  deleteSelectedCols: SheetCommand;
  clearSelection: SheetCommand;
  clearEverything: () => void;
  copyToClipboard: SheetCommand;
  cutToClipboard: SheetCommand;
  pasteFromClipboardText: (text: string, rect?: Rect) => void;
}

// Uniform row height keeps windowing math DOM-independent; long cell text is
// clipped in display mode, matching the single-line editor input.
const ROW_H = 26;
const OVERSCAN = 10;
const EMPTY_ROW: string[] = [];

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

// A copied line ending must not create an extra populated row; interior
// newlines mean one cell per row (column paste).
function plainTextRows(text: string): string[][] | null {
  if (!text) return null;
  const s = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (!s) return null;
  if (!s.includes("\n")) return [[s]];
  return s.split("\n").map((line) => [line]);
}

interface SheetRowProps {
  r: number;
  values: string[];
  displayCols: number;
  focusedC: number;
  rangeC0: number;
  rangeC1: number;
  editing: boolean;
  draft: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (v: string) => void;
  onInputKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  onInputBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onCellMouseDown: (
    e: ReactMouseEvent<HTMLTableCellElement>,
    r: number,
    c: number
  ) => void;
  onCellDrag: (r: number, c: number) => void;
  onCellDoubleClick: (r: number, c: number) => void;
  onRowHeaderMouseDown: (
    e: ReactMouseEvent<HTMLTableCellElement>,
    r: number
  ) => void;
}

const SheetRow = memo(
  function SheetRow(props: SheetRowProps) {
    const {
      r,
      values,
      displayCols,
      focusedC,
      rangeC0,
      rangeC1,
      editing,
      draft,
      inputRef,
      onDraftChange,
      onInputKeyDown,
      onInputBlur,
      onCompositionStart,
      onCompositionEnd,
      onCellMouseDown,
      onCellDrag,
      onCellDoubleClick,
      onRowHeaderMouseDown,
    } = props;
    return (
      <tr style={{ height: ROW_H }}>
        <th
          onMouseDown={(e) => onRowHeaderMouseDown(e, r)}
          className={`border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-center text-xs font-medium text-neutral-500 select-none sticky left-0 z-10 w-12 cursor-pointer dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400 ${
            focusedC >= 0 ? "bg-blue-100 dark:bg-blue-950" : ""
          }`}
        >
          {r + 1}
        </th>
        {Array.from({ length: displayCols }, (_, c) => {
          const focused = focusedC === c;
          const inRange = rangeC0 >= 0 && c >= rangeC0 && c <= rangeC1;
          return (
            <td
              key={c}
              data-r={r}
              data-c={c}
              style={{ height: ROW_H }}
              onMouseDown={(e) => onCellMouseDown(e, r, c)}
              onMouseEnter={() => onCellDrag(r, c)}
              onDoubleClick={() => onCellDoubleClick(r, c)}
              className={`max-w-64 min-w-24 cursor-cell overflow-hidden border border-neutral-200 px-2 align-top whitespace-nowrap dark:border-neutral-800 ${
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
                  autoFocus
                  value={draft}
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  onBlur={onInputBlur}
                  onCompositionStart={onCompositionStart}
                  onCompositionEnd={onCompositionEnd}
                  className="block w-full bg-transparent text-left outline-none select-text"
                />
              ) : (
                values[c] ?? ""
              )}
            </td>
          );
        })}
      </tr>
    );
  },
  (prev, next) =>
    prev.r === next.r &&
    prev.displayCols === next.displayCols &&
    prev.values.join("\u0000") === next.values.join("\u0000") &&
    prev.focusedC === next.focusedC &&
    prev.rangeC0 === next.rangeC0 &&
    prev.rangeC1 === next.rangeC1 &&
    prev.editing === next.editing &&
    (!next.editing || prev.draft === next.draft)
);

export function Sheet({ doc }: { doc: Y.Doc }) {
  const sheet = useMemo(() => getSheet(doc), [doc]);
  const [cells, setCells] = useState<string[][]>(() => snapshot(sheet));
  const [minRows, setMinRows] = useState(INITIAL_ROWS);
  const [minCols, setMinCols] = useState(INITIAL_COLS);
  const [sel, setSel] = useState<CellRef>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [win, setWin] = useState({ start: 0, end: 0 });
  const [viewportH, setViewportH] = useState(600);

  const undoRef = useRef<Y.UndoManager | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const draggingRef = useRef(false);
  const editingRef = useRef<CellRef | null>(null);
  const committedRef = useRef(true);
  const draftRef = useRef("");
  const composingRef = useRef(false);
  const scrollRafRef = useRef(0);

  const longestRow = useMemo(
    () => cells.reduce((n, row) => Math.max(n, row.length), 0),
    [cells]
  );
  const displayRows = Math.max(minRows, cells.length);
  const displayCols = Math.max(minCols, longestRow, INITIAL_COLS);

  const latestRef = useRef({
    sel,
    anchor,
    editing,
    displayRows,
    displayCols,
  });
  latestRef.current = { sel, anchor, editing, displayRows, displayCols };

  const rect = useMemo(() => normRect(anchor ?? sel, sel), [anchor, sel]);

  useEffect(() => {
    const onChange = () => setCells(snapshot(sheet));
    sheet.observeDeep(onChange);
    return () => sheet.unobserveDeep(onChange);
  }, [sheet]);

  useEffect(() => {
    const um = new Y.UndoManager([sheet], {
      trackedOrigins: new Set([SHEET_ORIGIN]),
    });
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
      // Clicks land on non-focusable table elements, leaving activeElement at
      // body where grid keybindings die; reclaim focus unless something
      // specific (name input, top-bar buttons) took it.
      if (!editingRef.current && document.activeElement === document.body) {
        gridRef.current?.focus();
      }
    };
    window.addEventListener("mouseup", stopDrag);
    return () => window.removeEventListener("mouseup", stopDrag);
  }, []);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const recomputeWin = useCallback(() => {
    const el = gridRef.current;
    const total = latestRef.current.displayRows;
    if (!el || total <= 0) {
      setWin({ start: 0, end: 0 });
      return;
    }
    const first = Math.max(0, Math.floor(el.scrollTop / ROW_H) - OVERSCAN);
    const count = Math.ceil(el.clientHeight / ROW_H) + OVERSCAN * 2;
    let start = Math.min(first, Math.max(0, total - 1));
    let end = Math.min(total, start + count);
    const er = editingRef.current?.r;
    if (er !== undefined) {
      start = Math.min(start, Math.max(0, er - OVERSCAN));
      end = Math.max(end, Math.min(total, er + OVERSCAN + 1));
    }
    setWin((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end }
    );
  }, []);

  // Selection lives in logical state; scrolling must be corrected before
  // paint so jumps into unrendered regions work without DOM round-trips.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const top = sel.r * ROW_H;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_H - el.clientHeight;
    }
  }, [sel]);

  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    el.querySelector<HTMLTableCellElement>(
      `td[data-r="${sel.r}"][data-c="${sel.c}"]`
    )?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sel]);

  useLayoutEffect(() => {
    recomputeWin();
  }, [recomputeWin, displayRows, viewportH, editing]);

  const onScroll = useCallback(() => {
    setMenu(null);
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      recomputeWin();
    });
  }, [recomputeWin]);

  useEffect(
    () => () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    },
    []
  );

  const setDraftBoth = useCallback((v: string) => {
    draftRef.current = v;
    setDraft(v);
  }, []);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
  }, []);

  const beginEdit = useCallback(
    (initial?: string, at?: CellRef) => {
      const cell = at ?? latestRef.current.sel;
      setSel(cell);
      setAnchor(null);
      editingRef.current = cell;
      committedRef.current = false;
      setDraftBoth(initial ?? cellValue(sheet, cell.r, cell.c));
      setEditing(true);
    },
    [sheet, setDraftBoth]
  );

  const commitEdit = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    const er = editingRef.current;
    setEditing(false);
    editingRef.current = null;
    if (!er) return;
    const v = draftRef.current;
    if (v !== cellValue(sheet, er.r, er.c)) {
      setCell(doc, sheet, er.r, er.c, v);
    }
    gridRef.current?.focus();
  }, [doc, sheet]);

  const discardEdit = useCallback(() => {
    committedRef.current = true;
    setEditing(false);
    editingRef.current = null;
    gridRef.current?.focus();
  }, []);

  const clampMove = useCallback((next: CellRef, extend: boolean) => {
    const L = latestRef.current;
    let dRows = L.displayRows;
    if (next.r >= dRows - 3) {
      dRows += GROW_ROWS;
      setMinRows(dRows);
    }
    let dCols = L.displayCols;
    if (next.c >= dCols - 3) {
      dCols += GROW_COLS;
      setMinCols(dCols);
    }
    setSel({
      r: Math.max(0, Math.min(dRows - 1, next.r)),
      c: Math.max(0, Math.min(dCols - 1, next.c)),
    });
    setAnchor(extend ? (L.anchor ?? L.sel) : null);
  }, []);

  const selectAll = useCallback(() => {
    const L = latestRef.current;
    setAnchor({ r: 0, c: 0 });
    setSel({ r: L.displayRows - 1, c: L.displayCols - 1 });
  }, []);

  const pasteRowsAt = useCallback(
    (start: CellRef, rows: string[][]) => {
      writeBlock(doc, sheet, start.r, start.c, rows);
      const maxW = rows.reduce((n, row) => Math.max(n, row.length), 0);
      const L = latestRef.current;
      if (start.r + rows.length + 3 >= L.displayRows) {
        setMinRows(L.displayRows + GROW_ROWS);
      }
      if (start.c + maxW - 1 >= L.displayCols - 3) {
        setMinCols(Math.max(L.displayCols, start.c + maxW) + GROW_COLS);
      }
      setSel(start);
      setAnchor(null);
    },
    [doc, sheet]
  );

  const rangeTsvOf = useCallback(
    (R: Rect): string => {
      const lines: string[] = [];
      for (let r = R.r0; r <= R.r1; r++) {
        const cols: string[] = [];
        for (let c = R.c0; c <= R.c1; c++) {
          cols.push(toTsv(cellValue(sheet, r, c)));
        }
        lines.push(cols.join("\t"));
      }
      return lines.join("\n");
    },
    [sheet]
  );

  const currentRect = useCallback(
    (): Rect =>
      normRect(
        latestRef.current.anchor ?? latestRef.current.sel,
        latestRef.current.sel
      ),
    []
  );

  const commands = useMemo<SheetCommands>(() => {
    const resolve = (maybe?: Rect): Rect => maybe ?? currentRect();
    const collapseTo = (r: number, c: number) => {
      setSel({ r, c });
      setAnchor(null);
    };
    return {
      insertRowsAbove: (rectArg) => {
        const R = resolve(rectArg);
        insertRowsOp(doc, sheet, R.r0, R.r1 - R.r0 + 1);
        collapseTo(R.r0, R.c0);
      },
      insertRowsBelow: (rectArg) => {
        const R = resolve(rectArg);
        insertRowsOp(doc, sheet, R.r1 + 1, R.r1 - R.r0 + 1);
        collapseTo(R.r1 + 1, R.c0);
      },
      deleteSelectedRows: (rectArg) => {
        const R = resolve(rectArg);
        const n = R.r1 - R.r0 + 1;
        deleteRowsOp(doc, sheet, R.r0, n);
        const remaining = Math.max(0, latestRef.current.displayRows - n);
        collapseTo(Math.min(R.r0, Math.max(0, remaining - 1)), R.c0);
      },
      insertColsLeft: (rectArg) => {
        const R = resolve(rectArg);
        insertCol(doc, sheet, R.c0);
        collapseTo(R.r0, R.c0);
      },
      insertColsRight: (rectArg) => {
        const R = resolve(rectArg);
        insertCol(doc, sheet, R.c1 + 1);
        collapseTo(R.r0, R.c1 + 1);
      },
      deleteSelectedCols: (rectArg) => {
        const R = resolve(rectArg);
        deleteCol(doc, sheet, R.c0);
        collapseTo(
          R.r0,
          Math.max(0, Math.min(R.c0, latestRef.current.displayCols - 2))
        );
      },
      clearSelection: (rectArg) => {
        const R = resolve(rectArg);
        clearRangeOp(doc, sheet, R.r0, R.c0, R.r1, R.c1);
      },
      clearEverything: () => {
        clearAll(doc, sheet);
        collapseTo(0, 0);
      },
      copyToClipboard: (rectArg) => {
        void navigator.clipboard
          .writeText(rangeTsvOf(resolve(rectArg)))
          .catch(() => {});
      },
      cutToClipboard: (rectArg) => {
        const R = resolve(rectArg);
        void navigator.clipboard.writeText(rangeTsvOf(R)).catch(() => {});
        clearRangeOp(doc, sheet, R.r0, R.c0, R.r1, R.c1);
      },
      pasteFromClipboardText: (text, rectArg) => {
        const R = resolve(rectArg);
        const rows = parseTableText(undefined, text) ?? plainTextRows(text);
        if (!rows) return;
        pasteRowsAt({ r: R.r0, c: R.c0 }, rows);
      },
    };
  }, [currentRect, doc, pasteRowsAt, rangeTsvOf, sheet]);

  const onGridKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (latestRef.current.editing) return;
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
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
      const L = latestRef.current;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          clampMove({ r: L.sel.r - 1, c: L.sel.c }, e.shiftKey);
          break;
        case "ArrowDown":
          e.preventDefault();
          clampMove({ r: L.sel.r + 1, c: L.sel.c }, e.shiftKey);
          break;
        case "ArrowLeft":
          e.preventDefault();
          clampMove({ r: L.sel.r, c: L.sel.c - 1 }, e.shiftKey);
          break;
        case "ArrowRight":
          e.preventDefault();
          clampMove({ r: L.sel.r, c: L.sel.c + 1 }, e.shiftKey);
          break;
        case "Tab":
          e.preventDefault();
          clampMove({ r: L.sel.r, c: L.sel.c + (e.shiftKey ? -1 : 1) }, false);
          break;
        case "Home":
          e.preventDefault();
          clampMove({ r: L.sel.r, c: 0 }, e.shiftKey);
          break;
        case "End":
          e.preventDefault();
          clampMove({ r: L.sel.r, c: L.displayCols - 1 }, e.shiftKey);
          break;
        case "PageUp":
        case "PageDown": {
          e.preventDefault();
          const page = Math.max(1, Math.floor(viewportH / ROW_H) - 1);
          clampMove(
            { r: L.sel.r + (e.key === "PageUp" ? -page : page), c: L.sel.c },
            e.shiftKey
          );
          break;
        }
        case "Enter":
        case "F2":
          e.preventDefault();
          beginEdit();
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          commands.clearSelection();
          break;
        default:
          if (!mod && !e.altKey && e.key.length === 1) {
            e.preventDefault();
            beginEdit(e.key);
          }
      }
    },
    [beginEdit, clampMove, commands, selectAll, viewportH]
  );

  const onInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (
        composingRef.current ||
        e.nativeEvent.isComposing ||
        e.keyCode === 229
      ) {
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit();
        const base = latestRef.current.sel;
        clampMove({ r: base.r + 1, c: base.c }, false);
      } else if (e.key === "Tab") {
        e.preventDefault();
        commitEdit();
        const base = latestRef.current.sel;
        clampMove({ r: base.r, c: base.c + (e.shiftKey ? -1 : 1) }, false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        discardEdit();
      }
    },
    [clampMove, commitEdit, discardEdit]
  );

  const onPaste = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      if (latestRef.current.editing) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const rows =
        parseTableClipboard(cd) ?? plainTextRows(cd.getData("text/plain"));
      if (!rows) return;
      e.preventDefault();
      pasteRowsAt(latestRef.current.sel, rows);
    },
    [pasteRowsAt]
  );

  const onCopy = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      if (latestRef.current.editing) return;
      e.clipboardData?.setData("text/plain", rangeTsvOf(currentRect()));
      e.preventDefault();
    },
    [currentRect, rangeTsvOf]
  );

  const onCut = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      if (latestRef.current.editing) return;
      const R = currentRect();
      e.clipboardData?.setData("text/plain", rangeTsvOf(R));
      e.preventDefault();
      clearRangeOp(doc, sheet, R.r0, R.c0, R.r1, R.c1);
    },
    [currentRect, doc, rangeTsvOf, sheet]
  );

  const onCellMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLTableCellElement>, r: number, c: number) => {
      if (latestRef.current.editing) commitEdit();
      draggingRef.current = true;
      setSel({ r, c });
      // Anchor must track the press point so mouse-drag produces a rect;
      // shift-click keeps the previous anchor to extend from it.
      if (!(e.shiftKey && latestRef.current.anchor)) setAnchor({ r, c });
    },
    [commitEdit]
  );

  const onCellDrag = useCallback((r: number, c: number) => {
    if (!draggingRef.current) return;
    const L = latestRef.current;
    if (r >= L.displayRows - 3) setMinRows(L.displayRows + GROW_ROWS);
    if (c >= L.displayCols - 3) setMinCols(L.displayCols + GROW_COLS);
    setSel({ r, c });
  }, []);

  const onCellDoubleClick = useCallback(
    (r: number, c: number) => {
      beginEdit(undefined, { r, c });
    },
    [beginEdit]
  );

  const onRowHeaderMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLTableCellElement>, r: number) => {
      const L = latestRef.current;
      if (e.shiftKey && L.anchor) {
        setSel({ r, c: L.displayCols - 1 });
      } else {
        setAnchor({ r, c: 0 });
        setSel({ r, c: L.displayCols - 1 });
      }
    },
    []
  );

  const onColHeaderMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLTableCellElement>, c: number) => {
      const L = latestRef.current;
      if (e.shiftKey && L.anchor) {
        setSel({ r: L.displayRows - 1, c });
      } else {
        setAnchor({ r: 0, c });
        setSel({ r: L.displayRows - 1, c });
      }
    },
    []
  );

  const onCornerMouseDown = useCallback(() => {
    selectAll();
  }, [selectAll]);

  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const td = (e.target as HTMLElement).closest<HTMLElement>("td[data-r]");
      if (!td) {
        setMenu(null);
        return;
      }
      const cell = { r: Number(td.dataset.r), c: Number(td.dataset.c) };
      const L = latestRef.current;
      const R = normRect(L.anchor ?? L.sel, L.sel);
      const inside =
        cell.r >= R.r0 && cell.r <= R.r1 && cell.c >= R.c0 && cell.c <= R.c1;
      if (inside) {
        setMenu({ x: e.clientX, y: e.clientY, rect: R });
      } else {
        setSel(cell);
        setAnchor(null);
        setMenu({ x: e.clientX, y: e.clientY, rect: normRect(cell, cell) });
      }
    },
    []
  );

  const headerCell =
    "border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-center text-xs font-medium text-neutral-500 select-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400";
  const headerHighlight = "bg-blue-100 dark:bg-blue-950";

  const rows: ReactNode[] = [];
  for (let r = win.start; r < win.end; r++) {
    const intersects = r >= rect.r0 && r <= rect.r1;
    rows.push(
      <SheetRow
        key={r}
        r={r}
        values={cells[r] ?? EMPTY_ROW}
        displayCols={displayCols}
        focusedC={sel.r === r ? sel.c : -1}
        rangeC0={intersects ? rect.c0 : -1}
        rangeC1={intersects ? rect.c1 : -1}
        editing={editing && sel.r === r}
        draft={draft}
        inputRef={inputRef}
        onDraftChange={setDraftBoth}
        onInputKeyDown={onInputKeyDown}
        onInputBlur={commitEdit}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onCellMouseDown={onCellMouseDown}
        onCellDrag={onCellDrag}
        onCellDoubleClick={onCellDoubleClick}
        onRowHeaderMouseDown={onRowHeaderMouseDown}
      />
    );
  }

  const leadingPad = win.start * ROW_H;
  const trailingPad = Math.max(0, (displayRows - win.end) * ROW_H);

  return (
    <div
      ref={gridRef}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
      onPaste={onPaste}
      onCopy={onCopy}
      onCut={onCut}
      onScroll={onScroll}
      onContextMenu={onContextMenu}
      className="h-full select-none overflow-auto outline-none"
    >
      <table className="border-collapse text-sm">
        <thead>
          <tr>
            <th
              onMouseDown={onCornerMouseDown}
              className={`${headerCell} sticky left-0 top-0 z-30 w-12 cursor-pointer`}
            />
            {Array.from({ length: displayCols }, (_, c) => (
              <th
                key={c}
                onMouseDown={(e) => onColHeaderMouseDown(e, c)}
                className={`${headerCell} sticky top-0 z-20 min-w-24 cursor-pointer ${
                  sel.c === c ? headerHighlight : ""
                }`}
              >
                {colLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {leadingPad > 0 && (
            <tr style={{ height: leadingPad }}>
              <td colSpan={displayCols + 1} style={{ padding: 0, border: "none" }} />
            </tr>
          )}
          {rows}
          {trailingPad > 0 && (
            <tr style={{ height: trailingPad }}>
              <td colSpan={displayCols + 1} style={{ padding: 0, border: "none" }} />
            </tr>
          )}
        </tbody>
      </table>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          rect={menu.rect}
          commands={commands}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
