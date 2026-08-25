import * as Y from "yjs";

export type SheetData = Y.Array<Y.Array<string>>;

export const SHEET_KEY = "ypad-sheet";
// All local UI mutations go through this origin so UndoManager can track them
// exclusively; provider-applied remote updates carry their own origins.
export const SHEET_ORIGIN = "ypad-sheet-local";
export const INITIAL_ROWS = 100;
export const INITIAL_COLS = 26;
export const GROW_ROWS = 50;
export const GROW_COLS = 8;

export function getSheet(doc: Y.Doc): SheetData {
  return doc.getArray<Y.Array<string>>(SHEET_KEY);
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
  }, SHEET_ORIGIN);
}

export function insertCol(doc: Y.Doc, sheet: SheetData, at: number): void {
  doc.transact(() => {
    for (let r = 0; r < sheet.length; r++) {
      const row = sheet.get(r);
      row.insert(Math.min(Math.max(0, at), row.length), [""]);
    }
  }, SHEET_ORIGIN);
}

export function deleteCol(doc: Y.Doc, sheet: SheetData, at: number): void {
  doc.transact(() => {
    for (let r = 0; r < sheet.length; r++) {
      const row = sheet.get(r);
      if (at >= 0 && at < row.length) row.delete(at, 1);
    }
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
