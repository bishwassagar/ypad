import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

interface Palette {
  bg: string;
  fg: string;
  caret: string;
  selection: string;
  line: string;
  gutter: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  functionName: string;
  typeName: string;
  variableName: string;
  propertyName: string;
  tagName: string;
  attributeName: string;
  operator: string;
  punctuation: string;
}

const dark: Palette = {
  bg: "#0a0a0a",
  fg: "#e7e5e4",
  caret: "#fafafa",
  selection: "rgba(255, 255, 255, 0.15)",
  line: "rgba(255, 255, 255, 0.04)",
  gutter: "#525252",
  comment: "#78716c",
  keyword: "#f472b6",
  string: "#4ade80",
  number: "#fbbf24",
  functionName: "#60a5fa",
  typeName: "#c084fc",
  variableName: "#e7e5e4",
  propertyName: "#fda4af",
  tagName: "#fb7185",
  attributeName: "#a3e635",
  operator: "#fca5a5",
  punctuation: "#a8a29e",
};

const light: Palette = {
  bg: "#ffffff",
  fg: "#1c1917",
  caret: "#000000",
  selection: "rgba(0, 0, 0, 0.12)",
  line: "rgba(0, 0, 0, 0.04)",
  gutter: "#a8a29e",
  comment: "#78716c",
  keyword: "#be185d",
  string: "#15803d",
  number: "#b45309",
  functionName: "#1d4ed8",
  typeName: "#7c3aed",
  variableName: "#1c1917",
  propertyName: "#be185d",
  tagName: "#be123c",
  attributeName: "#4d7c0f",
  operator: "#b91c1c",
  punctuation: "#57534e",
};

function highlightStyle(p: Palette) {
  return HighlightStyle.define([
    { tag: tags.comment, color: p.comment, fontStyle: "italic" },
    { tag: tags.keyword, color: p.keyword },
    { tag: tags.string, color: p.string },
    { tag: tags.regexp, color: p.string },
    { tag: tags.number, color: p.number },
    { tag: tags.bool, color: p.number },
    { tag: tags.null, color: p.number },
    { tag: tags.function(tags.variableName), color: p.functionName },
    { tag: tags.variableName, color: p.variableName },
    { tag: tags.typeName, color: p.typeName },
    { tag: tags.className, color: p.typeName },
    { tag: tags.namespace, color: p.typeName },
    { tag: tags.propertyName, color: p.propertyName },
    { tag: tags.tagName, color: p.tagName },
    { tag: tags.attributeName, color: p.attributeName },
    { tag: tags.operator, color: p.operator },
    { tag: tags.punctuation, color: p.punctuation },
    { tag: tags.heading, color: p.functionName, fontWeight: "bold" },
    { tag: tags.link, color: p.string, textDecoration: "underline" },
  ]);
}

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export function cmTheme(darkMode: boolean) {
  const p = darkMode ? dark : light;
  return [
    EditorView.theme(
      {
        "&": {
          height: "100%",
          fontSize: "15px",
          backgroundColor: p.bg,
          color: p.fg,
        },
        ".cm-scroller": {
          fontFamily: mono,
          lineHeight: "1.65",
        },
        ".cm-content": {
          fontFamily: mono,
          caretColor: p.caret,
          paddingBottom: "96px",
        },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.caret },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
          backgroundColor: p.selection,
        },
        ".cm-activeLine": { backgroundColor: p.line },
        ".cm-gutters": {
          backgroundColor: p.bg,
          color: p.gutter,
          border: "none",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          padding: "0 16px",
          minWidth: "16px",
        },
        "&.cm-focused": { outline: "none" },
        ".cm-matchingBracket": {
          backgroundColor: "transparent",
          outline: `1px solid ${p.punctuation}`,
        },
      },
      { dark: darkMode },
    ),
    syntaxHighlighting(highlightStyle(p)),
  ];
}