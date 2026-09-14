import * as Y from "yjs";

export type SheetData = Y.Array<Y.Array<string>>;

export const SHEET_KEY = "ypad-sheet";
// All local UI mutations go through this origin so UndoManager can track them
// exclusively; provider-applied remote updates carry their own origins.
export const SHEET_ORIGIN = "ypad-sheet-local";
export const SHEET_META_ORIGIN = "ypad-sheet-meta";
export const SHEET_COLW_KEY = "ypad-sheet-colw";
export const SHEET_ROWH_KEY = "ypad-sheet-rowh";
export const DEFAULT_COL_W = 96;
export const DEFAULT_ROW_H = 26;
export const MIN_COL_W = 48;
export const MAX_COL_W = 1600;
export const MIN_ROW_H = 22;
export const MAX_ROW_H = 1000;
// Autofit stays conservative even though manual drags may go wider.
export const AUTOFIT_MAX_COL_W = 480;
export const INITIAL_ROWS = 100;
export const INITIAL_COLS = 26;
export const GROW_ROWS = 50;
export const GROW_COLS = 8;

export function getSheet(doc: Y.Doc): SheetData {
  return doc.getArray<Y.Array<string>>(SHEET_KEY);
}

export function getColWidths(doc: Y.Doc): Y.Map<number> {
  return doc.getMap<number>(SHEET_COLW_KEY);
}

export function getRowHeights(doc: Y.Doc): Y.Map<number> {
  return doc.getMap<number>(SHEET_ROWH_KEY);
}

export function snapshotSizes(map: Y.Map<number>): Record<number, number> {
  const out: Record<number, number> = {};
  map.forEach((v, k) => {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && typeof v === "number") out[i] = v;
  });
  return out;
}

export function colWidthOf(sizes: Record<number, number>, c: number): number {
  return sizes[c] ?? DEFAULT_COL_W;
}

export function rowHeightOf(sizes: Record<number, number>, r: number): number {
  return sizes[r] ?? DEFAULT_ROW_H;
}

export function clampColWidth(w: number): number {
  return Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.round(w)));
}

export function clampRowHeight(h: number): number {
  return Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, Math.round(h)));
}

export function setColWidth(
  doc: Y.Doc,
  map: Y.Map<number>,
  c: number,
  w: number
): void {
  const clamped = clampColWidth(w);
  doc.transact(() => {
    if (clamped === DEFAULT_COL_W) map.delete(String(c));
    else map.set(String(c), clamped);
  }, SHEET_META_ORIGIN);
}

export function setRowHeight(
  doc: Y.Doc,
  map: Y.Map<number>,
  r: number,
  h: number
): void {
  const clamped = clampRowHeight(h);
  doc.transact(() => {
    if (clamped === DEFAULT_ROW_H) map.delete(String(r));
    else map.set(String(r), clamped);
  }, SHEET_META_ORIGIN);
}

// One transaction for multi-column autofit so collaborators observe a single
// update and local state settles once.
export function setColWidths(
  doc: Y.Doc,
  map: Y.Map<number>,
  entries: ReadonlyArray<readonly [number, number]>
): void {
  doc.transact(() => {
    for (const [c, w] of entries) {
      const clamped = clampColWidth(w);
      if (clamped === DEFAULT_COL_W) map.delete(String(c));
      else map.set(String(c), clamped);
    }
  }, SHEET_META_ORIGIN);
}

// Row autofit means "back to auto height": drop manual overrides in range.
export function resetRowHeights(
  doc: Y.Doc,
  map: Y.Map<number>,
  r0: number,
  r1: number
): void {
  doc.transact(() => {
    for (let r = r0; r <= r1; r++) {
      if (map.has(String(r))) map.delete(String(r));
    }
  }, SHEET_META_ORIGIN);
}

export function colLabel(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function cellRef(c: number, r: number): string {
  return `${colLabel(c)}${r + 1}`;
}

function shiftKeys(
  map: Y.Map<number>,
  from: number,
  delta: number,
  count?: number
): void {
  const keys: number[] = [];
  map.forEach((_v, k) => {
    const i = Number(k);
    if (Number.isInteger(i) && i >= from) keys.push(i);
  });
  if (delta > 0) keys.sort((a, b) => b - a);
  else keys.sort((a, b) => a - b);
  for (const i of keys) {
    const v = map.get(String(i));
    map.delete(String(i));
    if (count !== undefined && i < from + count) continue;
    if (v !== undefined) map.set(String(i + delta), v);
  }
}

export function cellValue(sheet: SheetData, r: number, c: number): string {
  return sheet.get(r)?.get(c) ?? "";
}

export function setCell(
  doc: Y.Doc,
  sheet: SheetData,
  r: number,
  c: number,
  value: string
): void {
  doc.transact(() => {
    if (r >= sheet.length) {
      const added: Y.Array<string>[] = [];
      for (let i = sheet.length; i <= r; i++) {
        added.push(new Y.Array<string>());
      }
      sheet.insert(sheet.length, added);
    }
    const row = sheet.get(r);
    while (row.length <= c) {
      row.insert(row.length, [""]);
    }
    if (row.get(c) === value) return;
    row.delete(c, 1);
    row.insert(c, [value]);
  }, SHEET_ORIGIN);
}

export function writeBlock(
  doc: Y.Doc,
  sheet: SheetData,
  startR: number,
  startC: number,
  rows: string[][]
): void {
  doc.transact(() => {
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < rows[i].length; j++) {
        setCell(doc, sheet, startR + i, startC + j, rows[i][j]);
      }
    }
  }, SHEET_ORIGIN);
}

export function clearRange(
  doc: Y.Doc,
  sheet: SheetData,
  r0: number,
  c0: number,
  r1: number,
  c1: number
): void {
  doc.transact(() => {
    for (let r = r0; r <= Math.min(r1, sheet.length - 1); r++) {
      const row = sheet.get(r);
      if (c0 === 0 && row.length - 1 <= c1) {
        if (row.length > 0) row.delete(0, row.length);
        continue;
      }
      for (
        let c = Math.min(c1, row.length - 1);
        c >= Math.min(c0, row.length);
        c--
      ) {
        row.delete(c, 1);
      }
    }
  }, SHEET_ORIGIN);
}

export function insertRows(
  doc: Y.Doc,
  sheet: SheetData,
  at: number,
  count: number
): void {
  doc.transact(() => {
    const clampedAt = Math.max(0, Math.min(at, sheet.length));
    sheet.insert(
      clampedAt,
      Array.from({ length: count }, () => new Y.Array<string>())
    );
    shiftKeys(getRowHeights(doc), clampedAt, count);
  }, SHEET_ORIGIN);
}

export function deleteRows(
  doc: Y.Doc,
  sheet: SheetData,
  at: number,
  count: number
): void {
  doc.transact(() => {
    const end = Math.min(at + count, sheet.length);
    if (at < end) sheet.delete(Math.max(0, at), end - at);
    shiftKeys(getRowHeights(doc), Math.max(0, at), -(end - Math.max(0, at)), end - Math.max(0, at));
  }, SHEET_ORIGIN);
}

export function insertCol(doc: Y.Doc, sheet: SheetData, at: number): void {
  doc.transact(() => {
    for (let r = 0; r < sheet.length; r++) {
      const row = sheet.get(r);
      row.insert(Math.min(Math.max(0, at), row.length), [""]);
    }
    shiftKeys(getColWidths(doc), Math.max(0, at), 1);
  }, SHEET_ORIGIN);
}

export function deleteCol(doc: Y.Doc, sheet: SheetData, at: number): void {
  deleteCols(doc, sheet, at, 1);
}

export function deleteCols(
  doc: Y.Doc,
  sheet: SheetData,
  at: number,
  count: number
): void {
  doc.transact(() => {
    const start = Math.max(0, at);
    for (let r = 0; r < sheet.length; r++) {
      const row = sheet.get(r);
      const end = Math.min(start + count, row.length);
      if (start < end) row.delete(start, end - start);
    }
    shiftKeys(getColWidths(doc), start, -count, count);
  }, SHEET_ORIGIN);
}

// Clears cell contents only; dimensions and minRows/minCols are preserved.
export function clearAll(doc: Y.Doc, sheet: SheetData): void {
  doc.transact(() => {
    for (let r = 0; r < sheet.length; r++) {
      const row = sheet.get(r);
      if (row.length > 0) row.delete(0, row.length);
    }
  }, SHEET_ORIGIN);
}

export function snapshot(sheet: SheetData): string[][] {
  const out: string[][] = [];
  for (let r = 0; r < sheet.length; r++) {
    const row = sheet.get(r);
    const cells: string[] = [];
    for (let c = 0; c < row.length; c++) {
      cells.push(row.get(c));
    }
    out.push(cells);
  }
  return out;
}
