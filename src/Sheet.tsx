import {
  Fragment,
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
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  cellRef,
  cellValue,
  clampColWidth,
  clampRowHeight,
  clearAll,
  clearRange as clearRangeOp,
  colLabel,
  colWidthOf,
  DEFAULT_COL_W,
  DEFAULT_ROW_H,
  deleteCols as deleteColsOp,
  deleteRows as deleteRowsOp,
  getColWidths,
  getRowHeights,
  getSheet,
  GROW_COLS,
  GROW_ROWS,
  INITIAL_COLS,
  INITIAL_ROWS,
  insertCol,
  insertRows as insertRowsOp,
  AUTOFIT_MAX_COL_W,
  rowHeightOf,
  setCell,
  setColWidth,
  setColWidths as setColWidthsBatch,
  resetRowHeights,
  setRowHeight,
  SHEET_ORIGIN,
  snapshot,
  snapshotSizes,
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

// Header clicks select whole rows/columns while the active cell stays on its
// current row/column (Excel behavior) so the viewport never jumps to the end.
// The active cell can sit inside the range, which anchor/sel alone cannot
// express, hence this separate selection.
type HeaderSel =
  | { kind: "row"; r0: number; r1: number }
  | { kind: "col"; c0: number; c1: number }
  | { kind: "all" };

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

// Row virtualization is DOM-independent: heights come from shared overrides,
// auto-growing for multiline content (see autoHeights).
const OVERSCAN = 10;
const EMPTY_ROW: string[] = [];
const BAR_FONT = "14px ui-sans-serif, system-ui, sans-serif";
// text-sm line height; auto row height fits every line of the tallest cell.
const LINE_H = 20;
// In-cell editor and live row growth stop here; beyond this the editor
// scrolls internally instead of pushing the grid around.
const EDIT_GROW_MAX_LINES = 12;

let measureCtx: CanvasRenderingContext2D | null = null;
function measureTextWidth(text: string): number {
  if (typeof document === "undefined") return text.length * 8;
  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
    if (!measureCtx) return text.length * 8;
  }
  measureCtx.font = BAR_FONT;
  return measureCtx.measureText(text).width;
}

function normRect(a: CellRef, b: CellRef): Rect {
  return {
    r0: Math.min(a.r, b.r),
    c0: Math.min(a.c, b.c),
    r1: Math.max(a.r, b.r),
    c1: Math.max(a.c, b.c),
  };
}

function renderMultiline(value: string): ReactNode {
  if (!value.includes("\n")) return value;
  return value.split("\n").map((line, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {line}
    </Fragment>
  ));
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
  widthOf: (c: number) => number;
  height: number;
  focusedC: number;
  rangeC0: number;
  rangeC1: number;
  rowSelected: boolean;
  editing: boolean;
  draft: string;
  autoFocusEditor: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (v: string) => void;
  onInputKeyDown: (
    e: ReactKeyboardEvent<HTMLTextAreaElement>
  ) => void;
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
  onRowResizeStart: (e: ReactMouseEvent, r: number) => void;
  onRowAutofit: (r: number) => void;
}

const SheetRow = memo(
  function SheetRow(props: SheetRowProps) {
    const {
      r,
      values,
      displayCols,
      widthOf,
      height,
      focusedC,
      rangeC0,
      rangeC1,
      rowSelected,
      editing,
      draft,
      autoFocusEditor,
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
      onRowResizeStart,
      onRowAutofit,
    } = props;
    return (
      <tr style={{ height }}>
        <th
          onMouseDown={(e) => onRowHeaderMouseDown(e, r)}
          className={`relative border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-center text-xs font-medium text-neutral-500 select-none sticky left-0 z-10 w-12 cursor-pointer dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400 ${
            rowSelected ? "bg-blue-100 dark:bg-blue-950" : ""
          }`}
        >
          {r + 1}
          <span
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize row. Double-click to reset selected rows."
            onMouseDown={(e) => onRowResizeStart(e, r)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRowAutofit(r);
            }}
            className="absolute right-0 bottom-0 left-0 h-1.5 cursor-ns-resize"
          />
        </th>
        {Array.from({ length: displayCols }, (_, c) => {
          const focused = focusedC === c;
          const inRange = rangeC0 >= 0 && c >= rangeC0 && c <= rangeC1;
          const w = widthOf(c);
          return (
            <td
              key={c}
              data-r={r}
              data-c={c}
              style={{ height, width: w, minWidth: w, maxWidth: w }}
              onMouseDown={(e) => onCellMouseDown(e, r, c)}
              onMouseEnter={() => onCellDrag(r, c)}
              onDoubleClick={() => onCellDoubleClick(r, c)}
              className={`cursor-cell overflow-hidden border border-neutral-200 px-2 align-top whitespace-nowrap dark:border-neutral-800 ${
                focused
                  ? "bg-white ring-2 ring-inset ring-blue-500 dark:bg-neutral-950"
                  : inRange
                    ? "bg-blue-50 dark:bg-blue-950/40"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
              }`}
            >
              {focused && editing ? (
                <textarea
                  ref={inputRef}
                  autoFocus={autoFocusEditor}
                  value={draft}
                  rows={Math.min(
                    Math.max(1, draft.split("\n").length),
                    EDIT_GROW_MAX_LINES
                  )}
                  wrap="off"
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  onPaste={(e) => e.stopPropagation()}
                  onBlur={onInputBlur}
                  onCompositionStart={onCompositionStart}
                  onCompositionEnd={onCompositionEnd}
                  className={`block w-full resize-none bg-transparent text-left outline-none select-text ${
                    draft.includes("\n")
                      ? "overflow-auto whitespace-pre"
                      : "overflow-x-auto whitespace-nowrap"
                  }`}
                />
              ) : (
                renderMultiline(values[c] ?? "")
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
    prev.rowSelected === next.rowSelected &&
    prev.height === next.height &&
    prev.widthOf === next.widthOf &&
    prev.editing === next.editing &&
    prev.autoFocusEditor === next.autoFocusEditor &&
    (!next.editing || prev.draft === next.draft)
);

export function Sheet({ doc }: { doc: Y.Doc }) {
  const sheet = useMemo(() => getSheet(doc), [doc]);
  const colWMap = useMemo(() => getColWidths(doc), [doc]);
  const rowHMap = useMemo(() => getRowHeights(doc), [doc]);
  const [cells, setCells] = useState<string[][]>(() => snapshot(sheet));
  const [colWidths, setColWidths] = useState<Record<number, number>>(() =>
    snapshotSizes(colWMap)
  );
  const [rowHeights, setRowHeights] = useState<Record<number, number>>(() =>
    snapshotSizes(rowHMap)
  );
  const [minRows, setMinRows] = useState(INITIAL_ROWS);
  const [minCols, setMinCols] = useState(INITIAL_COLS);
  const [sel, setSel] = useState<CellRef>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [headerSel, setHeaderSel] = useState<HeaderSel | null>(null);
  const [editing, setEditing] = useState(false);
  // Bar-originated edits keep focus in the bar (no autofocus steal, hence no
  // blur-commit race); cell/grid-originated edits focus the in-cell editor.
  const [editFocusCell, setEditFocusCell] = useState(true);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [win, setWin] = useState({ start: 0, end: 0 });
  const [viewportH, setViewportH] = useState(600);
  const [resizing, setResizing] = useState<
    { kind: "col" | "row"; index: number } | null
  >(null);
  const [fxExpanded, setFxExpanded] = useState(
    () =>
      typeof localStorage !== "undefined" &&
      localStorage.getItem("ypad-fx-expanded") === "1"
  );

  const undoRef = useRef<Y.UndoManager | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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

  const widthOf = useCallback(
    (c: number) => colWidthOf(colWidths, c),
    [colWidths]
  );
  // Effective row heights: a manual shared override wins; otherwise rows
  // auto-grow to fit every line of the tallest cell (Excel behavior).
  const autoHeights = useMemo(() => {
    const arr = new Array<number>(displayRows);
    for (let r = 0; r < displayRows; r++) {
      const manual = rowHeights[r];
      if (manual !== undefined) {
        arr[r] = manual;
        continue;
      }
      let lines = 1;
      const row = cells[r];
      if (row) {
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (v.indexOf("\n") !== -1) {
            let n = 1;
            for (let i = 0; i < v.length; i++) if (v[i] === "\n") n++;
            if (n > lines) lines = n;
          }
        }
      }
      arr[r] = lines <= 1 ? DEFAULT_ROW_H : lines * LINE_H + 4;
      if (editing && r === sel.r && rowHeights[r] === undefined) {
        // The row grows with the draft while editing so the editor never
        // scrolls for normal content; manual overrides stay pinned.
        const draftLines = draft.split("\n").length;
        if (draftLines > lines) {
          const grown = Math.min(draftLines, EDIT_GROW_MAX_LINES);
          arr[r] = grown <= 1 ? DEFAULT_ROW_H : grown * LINE_H + 4;
        }
      }
    }
    return arr;
  }, [displayRows, rowHeights, cells, editing, sel, draft]);

  const heightOf = useCallback(
    (r: number) => autoHeights[r] ?? DEFAULT_ROW_H,
    [autoHeights]
  );

  // Cumulative row tops for variable-height windowing.
  const rowTops = useMemo(() => {
    const tops = new Array<number>(displayRows + 1);
    tops[0] = 0;
    for (let r = 0; r < displayRows; r++) {
      tops[r + 1] = tops[r] + (autoHeights[r] ?? DEFAULT_ROW_H);
    }
    return tops;
  }, [displayRows, autoHeights]);
  const totalH = rowTops[displayRows] ?? 0;

  const latestRef = useRef({
    sel,
    anchor,
    headerSel,
    editing,
    displayRows,
    displayCols,
  });
  latestRef.current = {
    sel,
    anchor,
    headerSel,
    editing,
    displayRows,
    displayCols,
  };
  const topsRef = useRef(rowTops);
  topsRef.current = rowTops;

  const rect = useMemo(() => {
    if (headerSel?.kind === "row") {
      return { r0: headerSel.r0, c0: 0, r1: headerSel.r1, c1: displayCols - 1 };
    }
    if (headerSel?.kind === "col") {
      return { r0: 0, c0: headerSel.c0, r1: displayRows - 1, c1: headerSel.c1 };
    }
    if (headerSel?.kind === "all") {
      return { r0: 0, c0: 0, r1: displayRows - 1, c1: displayCols - 1 };
    }
    return normRect(anchor ?? sel, sel);
  }, [anchor, sel, headerSel, displayRows, displayCols]);

  useEffect(() => {
    const onChange = () => setCells(snapshot(sheet));
    sheet.observeDeep(onChange);
    return () => sheet.unobserveDeep(onChange);
  }, [sheet]);

  useEffect(() => {
    const onSizes = () => {
      setColWidths(snapshotSizes(colWMap));
      setRowHeights(snapshotSizes(rowHMap));
    };
    colWMap.observe(onSizes);
    rowHMap.observe(onSizes);
    return () => {
      colWMap.unobserve(onSizes);
      rowHMap.unobserve(onSizes);
    };
  }, [colWMap, rowHMap]);

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
    const tops = topsRef.current;
    if (!el || total <= 0) {
      setWin({ start: 0, end: 0 });
      return;
    }
    // Binary-search first row whose bottom passes scrollTop.
    let lo = 0;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid + 1] <= el.scrollTop) lo = mid + 1;
      else hi = mid;
    }
    const start = Math.max(0, lo - OVERSCAN);
    const bottom = el.scrollTop + el.clientHeight;
    let end = start;
    while (end < total && tops[end] < bottom + OVERSCAN * DEFAULT_ROW_H) {
      end++;
    }
    end = Math.min(total, Math.max(end, Math.min(total, lo + 1)));
    const er = editingRef.current?.r;
    const fStart =
      er !== undefined ? Math.min(start, Math.max(0, er - OVERSCAN)) : start;
    const fEnd =
      er !== undefined
        ? Math.max(end, Math.min(total, er + OVERSCAN + 1))
        : end;
    setWin((prev) =>
      prev.start === fStart && prev.end === fEnd
        ? prev
        : { start: fStart, end: fEnd }
    );
  }, []);

  // Selection lives in logical state; scrolling must be corrected before
  // paint so jumps into unrendered regions work without DOM round-trips.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const tops = topsRef.current;
    const top = tops[sel.r] ?? 0;
    const h = (tops[sel.r + 1] ?? top) - top || DEFAULT_ROW_H;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (top + h > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + h - el.clientHeight;
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
  }, [recomputeWin, displayRows, viewportH, editing, autoHeights]);

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
    (initial?: string, at?: CellRef, focusCell = true) => {
      const cell = at ?? latestRef.current.sel;
      setSel(cell);
      setAnchor(null);
      setHeaderSel(null);
      editingRef.current = cell;
      committedRef.current = false;
      setDraftBoth(initial ?? cellValue(sheet, cell.r, cell.c));
      setEditFocusCell(focusCell);
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

  const resizeRef = useRef<{
    kind: "col" | "row";
    index: number;
    startPos: number;
    startSize: number;
    lastSize: number;
  } | null>(null);

  const onResizeStart = useCallback(
    (kind: "col" | "row", index: number, e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startSize =
        kind === "col" ? colWidthOf(colWidths, index) : rowHeightOf(rowHeights, index);
      resizeRef.current = {
        kind,
        index,
        startPos: kind === "col" ? e.clientX : e.clientY,
        startSize,
        lastSize: startSize,
      };
      setResizing({ kind, index });
      const startPos = kind === "col" ? e.clientX : e.clientY;
      const onMove = (ev: MouseEvent) => {
        const cur = resizeRef.current;
        if (!cur) return;
        const delta = (kind === "col" ? ev.clientX : ev.clientY) - startPos;
        if (kind === "col") {
          const w = clampColWidth(cur.startSize + delta);
          cur.lastSize = w;
          setColWidths((prev) => (prev[index] === w ? prev : { ...prev, [index]: w }));
        } else {
          const h = clampRowHeight(cur.startSize + delta);
          cur.lastSize = h;
          setRowHeights((prev) => (prev[index] === h ? prev : { ...prev, [index]: h }));
        }
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        const cur = resizeRef.current;
        resizeRef.current = null;
        setResizing(null);
        if (cur) {
          if (cur.kind === "col") setColWidth(doc, colWMap, cur.index, cur.lastSize);
          else setRowHeight(doc, rowHMap, cur.index, cur.lastSize);
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [colWidths, rowHeights, colWMap, rowHMap, doc]
  );

  const onColResizeStart = useCallback(
    (e: ReactMouseEvent, c: number) => onResizeStart("col", c, e),
    [onResizeStart]
  );

  const onRowResizeStart = useCallback(
    (e: ReactMouseEvent, r: number) => onResizeStart("row", r, e),
    [onResizeStart]
  );

  // Excel behavior: with several columns selected, double-clicking any
  // boundary autofits every selected column. Empty columns reset to default.
  const autofitCols = useCallback(
    (c0: number, c1: number) => {
      const entries: Array<[number, number]> = [];
      const cap = Math.min(cells.length, 1000);
      for (let c = c0; c <= c1; c++) {
        let w = measureTextWidth(colLabel(c)) + 28;
        let hasContent = false;
        for (let r = 0; r < cap; r++) {
          const v = cells[r]?.[c];
          if (v) {
            hasContent = true;
            // Multiline cells fit the longest line, not the joined string.
            const lines = v.includes("\n") ? v.split("\n") : [v];
            for (const line of lines) {
              w = Math.max(w, measureTextWidth(line) + 28);
            }
          }
          if (w >= AUTOFIT_MAX_COL_W) break;
        }
        entries.push([c, hasContent ? w : DEFAULT_COL_W]);
      }
      setColWidthsBatch(doc, colWMap, entries);
    },
    [cells, colWMap, doc]
  );

  const onColAutofit = useCallback(
    (c: number) => {
      const L = latestRef.current;
      if (L.headerSel?.kind === "col") autofitCols(L.headerSel.c0, L.headerSel.c1);
      else if (L.headerSel?.kind === "all") {
        autofitCols(0, L.displayCols - 1);
      } else autofitCols(c, c);
    },
    [autofitCols]
  );

  // Row autofit means "back to auto height": drop manual overrides.
  const onRowAutofit = useCallback(
    (r: number) => {
      const L = latestRef.current;
      if (L.headerSel?.kind === "row") {
        resetRowHeights(doc, rowHMap, L.headerSel.r0, L.headerSel.r1);
      } else if (L.headerSel?.kind === "all") {
        resetRowHeights(doc, rowHMap, 0, L.displayRows - 1);
      } else {
        setRowHeight(doc, rowHMap, r, DEFAULT_ROW_H);
      }
    },
    [doc, rowHMap]
  );

  const barName =
    rect.r0 === rect.r1 && rect.c0 === rect.c1
      ? cellRef(rect.c0, rect.r0)
      : `${cellRef(rect.c0, rect.r0)}:${cellRef(rect.c1, rect.r1)}`;
  const activeValue = editing ? draft : cellValue(sheet, sel.r, sel.c);

  const onBarChange = useCallback(
    (v: string) => {
      if (editingRef.current) {
        setDraftBoth(v);
      } else {
        beginEdit(v, undefined, false);
      }
    },
    [beginEdit, setDraftBoth]
  );

  const insertTextAtCursor = useCallback(
    (el: HTMLTextAreaElement, text: string) => {
      const cur = draftRef.current;
      const s = el.selectionStart ?? cur.length;
      const en = el.selectionEnd ?? s;
      setDraftBoth(`${cur.slice(0, s)}${text}${cur.slice(en)}`);
      const pos = s + text.length;
      requestAnimationFrame(() => {
        try {
          el.setSelectionRange(pos, pos);
        } catch {
          // Non-text inputs never reach here; ignore.
        }
      });
    },
    [setDraftBoth]
  );

  const insertNewlineAtCursor = useCallback(
    (el: HTMLTextAreaElement) => {
      insertTextAtCursor(el, "\n");
    },
    [insertTextAtCursor]
  );

  // Bar paste always lands in the active cell as one value: the raw clipboard
  // text (newlines preserved) is spliced at the cursor instead of flowing
  // through the grid block-paste path.
  const onBarPaste = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      if (!editingRef.current) {
        beginEdit(cellValue(sheet, sel.r, sel.c), undefined, false);
      }
      insertTextAtCursor(e.currentTarget, text);
    },
    [beginEdit, insertTextAtCursor, sheet, sel]
  );

  const onBarKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && e.altKey) {
        e.preventDefault();
        if (!editingRef.current) {
          beginEdit(cellValue(sheet, sel.r, sel.c), undefined, false);
        }
        insertNewlineAtCursor(e.currentTarget);
      } else if (e.key === "Enter") {
        e.preventDefault();
        commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        discardEdit();
      }
    },
    [beginEdit, commitEdit, discardEdit, insertNewlineAtCursor, sheet, sel]
  );

  const toggleFxExpanded = useCallback(() => {
    setFxExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("ypad-fx-expanded", next ? "1" : "0");
      } catch {
        // Private-mode storage can throw; expansion still works for the session.
      }
      return next;
    });
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
    if (extend) {
      // Convert a header selection into an anchor so arrow-extend continues
      // from the active cell instead of collapsing the whole row/column.
      setAnchor(L.headerSel ? L.sel : (L.anchor ?? L.sel));
    } else {
      setAnchor(null);
    }
    setHeaderSel(null);
  }, []);

  const selectAll = useCallback(() => {
    // Active cell and viewport stay put; the full sheet is selected.
    setHeaderSel({ kind: "all" });
    setAnchor(null);
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

  const currentRect = useCallback((): Rect => {
    const L = latestRef.current;
    if (L.headerSel?.kind === "row") {
      return { r0: L.headerSel.r0, c0: 0, r1: L.headerSel.r1, c1: L.displayCols - 1 };
    }
    if (L.headerSel?.kind === "col") {
      return { r0: 0, c0: L.headerSel.c0, r1: L.displayRows - 1, c1: L.headerSel.c1 };
    }
    if (L.headerSel?.kind === "all") {
      return { r0: 0, c0: 0, r1: L.displayRows - 1, c1: L.displayCols - 1 };
    }
    return normRect(L.anchor ?? L.sel, L.sel);
  }, []);

  const commands = useMemo<SheetCommands>(() => {
    const resolve = (maybe?: Rect): Rect => maybe ?? currentRect();
    const collapseTo = (r: number, c: number) => {
      setSel({ r, c });
      setAnchor(null);
      setHeaderSel(null);
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
        const n = R.c1 - R.c0 + 1;
        deleteColsOp(doc, sheet, R.c0, n);
        collapseTo(
          R.r0,
          Math.max(0, Math.min(R.c0, latestRef.current.displayCols - n - 1))
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
          const page = Math.max(1, Math.floor(viewportH / DEFAULT_ROW_H) - 1);
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
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (
        composingRef.current ||
        e.nativeEvent.isComposing ||
        e.keyCode === 229
      ) {
        return;
      }
      if (e.key === "Enter" && e.altKey) {
        e.preventDefault();
        insertNewlineAtCursor(e.currentTarget);
      } else if (e.key === "Enter") {
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
    [clampMove, commitEdit, discardEdit, insertNewlineAtCursor]
  );

  const onPaste = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      // Text pasted inside an editor (cell or formula bar) is that editor's
      // business; the grid only handles block paste onto selected cells.
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input,textarea,[contenteditable]")
      ) {
        return;
      }
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
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input,textarea,[contenteditable]")
      ) {
        return;
      }
      if (latestRef.current.editing) return;
      e.clipboardData?.setData("text/plain", rangeTsvOf(currentRect()));
      e.preventDefault();
    },
    [currentRect, rangeTsvOf]
  );

  const onCut = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input,textarea,[contenteditable]")
      ) {
        return;
      }
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
      // Drags starting inside the in-cell editor are text selection, not
      // grid selection: leave the edit alone instead of committing it.
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input,textarea")
      ) {
        return;
      }
      if (latestRef.current.editing) commitEdit();
      draggingRef.current = true;
      setHeaderSel(null);
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
      if (e.shiftKey && (L.anchor || L.headerSel?.kind === "row")) {
        if (L.headerSel?.kind === "row") {
          setHeaderSel({
            kind: "row",
            r0: Math.min(L.headerSel.r0, r),
            r1: Math.max(L.headerSel.r1, r),
          });
        } else {
          setHeaderSel(null);
        }
        setSel({ r, c: L.sel.c });
      } else {
        // Active column stays put so the viewport doesn't jump to the edge.
        setHeaderSel({ kind: "row", r0: r, r1: r });
        setAnchor(null);
        setSel({ r, c: L.sel.c });
      }
    },
    []
  );

  const onColHeaderMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLTableCellElement>, c: number) => {
      const L = latestRef.current;
      if (e.shiftKey && (L.anchor || L.headerSel?.kind === "col")) {
        if (L.headerSel?.kind === "col") {
          setHeaderSel({
            kind: "col",
            c0: Math.min(L.headerSel.c0, c),
            c1: Math.max(L.headerSel.c1, c),
          });
        } else {
          setHeaderSel(null);
        }
        setSel({ r: L.sel.r, c });
      } else {
        // Active row stays put so the viewport doesn't jump to the end.
        setHeaderSel({ kind: "col", c0: c, c1: c });
        setAnchor(null);
        setSel({ r: L.sel.r, c });
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
      const R = currentRect();
      const inside =
        cell.r >= R.r0 && cell.r <= R.r1 && cell.c >= R.c0 && cell.c <= R.c1;
      if (inside) {
        setMenu({ x: e.clientX, y: e.clientY, rect: R });
      } else {
        setSel(cell);
        setAnchor(null);
        setHeaderSel(null);
        setMenu({ x: e.clientX, y: e.clientY, rect: normRect(cell, cell) });
      }
    },
    [currentRect]
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
        widthOf={widthOf}
        height={heightOf(r)}
        focusedC={sel.r === r ? sel.c : -1}
        rangeC0={intersects ? rect.c0 : -1}
        rangeC1={intersects ? rect.c1 : -1}
        rowSelected={r >= rect.r0 && r <= rect.r1}
        editing={editing && sel.r === r}
        draft={draft}
        autoFocusEditor={editFocusCell}
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
        onRowResizeStart={onRowResizeStart}
        onRowAutofit={onRowAutofit}
      />
    );
  }

  const leadingPad = rowTops[win.start] ?? 0;
  const trailingPad = Math.max(0, totalH - (rowTops[win.end] ?? totalH));

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b border-neutral-200 bg-neutral-50 px-2 py-1 dark:border-neutral-800 dark:bg-neutral-900">
        <span
          title="Active cell or range"
          className="mt-1 w-24 shrink-0 truncate rounded border border-neutral-200 bg-white px-2 py-1 text-center text-xs font-medium text-neutral-600 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
        >
          {barName}
        </span>
        <span
          aria-hidden
          className="mt-2 shrink-0 text-xs font-semibold text-neutral-400 italic select-none dark:text-neutral-500"
        >
          fx
        </span>
        {(() => {
          // A single-row textarea never sanitizes newlines (unlike <input>),
          // so typing after a multiline paste can't destroy line breaks. The
          // bar auto-expands while the content is multiline.
          const grown = fxExpanded || activeValue.includes("\n");
          return (
            <>
              <textarea
                value={activeValue}
                onChange={(e) => onBarChange(e.target.value)}
                onKeyDown={onBarKeyDown}
                onPaste={onBarPaste}
                onBlur={commitEdit}
                placeholder="Cell contents (Alt+Enter for a new line)"
                aria-label="Cell contents"
                rows={grown ? 4 : 1}
                wrap="off"
                className={`min-w-0 flex-1 rounded bg-transparent px-2 py-1 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:bg-white dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:bg-neutral-950 ${
                  grown
                    ? "min-h-20 resize-y whitespace-pre-wrap"
                    : "mt-0.5 resize-none overflow-x-auto whitespace-nowrap"
                }`}
              />
              <button
                type="button"
                onClick={toggleFxExpanded}
                aria-expanded={grown}
                title={grown ? "Collapse formula bar" : "Expand formula bar"}
                className="mt-1 shrink-0 rounded-md p-1.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              >
                {grown ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
            </>
          );
        })()}
      </div>
      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onPaste={onPaste}
        onCopy={onCopy}
        onCut={onCut}
        onScroll={onScroll}
        onContextMenu={onContextMenu}
        className={`min-h-0 flex-1 select-none overflow-auto outline-none ${
          resizing ? "cursor-ew-resize" : ""
        }`}
      >
        <table
          className="border-collapse text-sm"
          style={{ tableLayout: "fixed" }}
        >
          <colgroup>
            <col style={{ width: 48 }} />
            {Array.from({ length: displayCols }, (_, c) => (
              <col key={c} style={{ width: widthOf(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                onMouseDown={onCornerMouseDown}
                className={`${headerCell} sticky left-0 top-0 z-30 w-12 cursor-pointer`}
              />
              {Array.from({ length: displayCols }, (_, c) => {
                const w = widthOf(c);
                const inRange = c >= rect.c0 && c <= rect.c1;
                return (
                  <th
                    key={c}
                    onMouseDown={(e) => onColHeaderMouseDown(e, c)}
                    style={{ width: w }}
                    className={`${headerCell} relative sticky top-0 z-20 cursor-pointer ${
                      inRange ? headerHighlight : ""
                    }`}
                  >
                    {colLabel(c)}
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      title="Drag to resize column. Double-click to autofit selected columns."
                      onMouseDown={(e) => onColResizeStart(e, c)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onColAutofit(c);
                      }}
                      className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize"
                    />
                  </th>
                );
              })}
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
    </div>
  );
}
