import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export function parseTableClipboard(cd: DataTransfer): string[][] | null {
  return parseTableText(cd.getData("text/html"), cd.getData("text/plain"));
}

export function parseTableText(
  html: string | undefined,
  plain: string | undefined
): string[][] | null {
  // TSV wins over HTML so multiline cells survive round-trips; Excel,
  // Google Sheets and YPad all emit proper quoted TSV alongside HTML.
  return rowsFromTsv(plain) ?? (html ? rowsFromHtml(html) : null);
}

function rowsFromHtml(html: string): string[][] | null {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const tableEl = parsed.querySelector("table");
  if (!tableEl) return null;
  const rows: string[][] = [];
  for (const tr of tableEl.querySelectorAll("tr")) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll("td, th")) {
      cells.push((cell.textContent ?? "").replace(/\s+/g, " ").trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows.length > 0 ? rows : null;
}

function rowsFromTsv(plain: string | undefined): string[][] | null {
  if (!plain || !plain.includes("\t")) return null;
  // Strip exactly one trailing newline so a copied line ending doesn't
  // create an extra populated row.
  const text = plain.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === "\t") {
      endField();
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  endRow();
  return rows;
}

function markdownTable(rows: string[][]): string {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const esc = (cell: string) => cell.replace(/\|/g, "\\|") || " ";
  const pad = (r: string[]) => {
    const out = r.slice();
    while (out.length < cols) out.push("");
    return out;
  };
  const lines = [
    `| ${pad(rows[0]).map(esc).join(" | ")} |`,
    `| ${Array<string>(cols).fill("---").join(" | ")} |`,
    ...rows.slice(1).map(
      (r) => `| ${pad(r).map(esc).join(" | ")} |`
    ),
  ];
  return lines.join("\n");
}

export function smartPaste(): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const cd = event.clipboardData;
      if (!cd) return false;
      const rows = parseTableClipboard(cd);
      if (!rows || (rows.length === 1 && rows[0].length === 1)) return false;

      event.preventDefault();
      view.dispatch({
        ...view.state.replaceSelection(markdownTable(rows)),
        userEvent: "input.paste",
      });
      return true;
    },
  });
}
