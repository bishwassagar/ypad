import * as Y from "yjs";

export type SheetData = Y.Array<Y.Array<string>>;

export const SHEET_KEY = "ypad-sheet";
export const INITIAL_ROWS = 100;
export const INITIAL_COLS = 26;
export const GROW_ROWS = 50;

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
  });
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
  });
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
