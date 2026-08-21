import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export function parseTableClipboard(cd: DataTransfer): string[][] | null {
  const html = cd.getData("text/html");
  const plain = cd.getData("text/plain");
  return (html && rowsFromHtml(html)) || rowsFromTsv(plain);
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

function rowsFromTsv(plain: string): string[][] | null {
  if (!plain.includes("\t")) return null;
  return plain
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").map((cell) => cell.trim()));
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
