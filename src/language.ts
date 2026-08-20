import type { Extension } from "@codemirror/state";

export interface LanguageDef {
  id: string;
  label: string;
}

export const LANGUAGES: LanguageDef[] = [
  { id: "plain", label: "Plain text" },
  { id: "markdown", label: "Markdown" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "jsx", label: "JSX" },
  { id: "tsx", label: "TSX" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "json", label: "JSON" },
  { id: "python", label: "Python" },
  { id: "rust", label: "Rust" },
  { id: "go", label: "Go" },
  { id: "java", label: "Java" },
  { id: "cpp", label: "C/C++" },
  { id: "sql", label: "SQL" },
  { id: "shell", label: "Shell" },
];

const byId = new Map(LANGUAGES.map((l) => [l.id, l]));

export function languageLabel(id: string): string {
  return byId.get(id)?.label ?? LANGUAGES[0].label;
}

// Language extensions are dynamic-imported so each CodeMirror language is its
// own code-split chunk and the initial bundle stays small.
export async function loadLanguage(id: string): Promise<Extension> {
  switch (id) {
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "cpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "shell": {
      const [{ shell }, { StreamLanguage }] = await Promise.all([
        import("@codemirror/legacy-modes/mode/shell"),
        import("@codemirror/language"),
      ]);
      return StreamLanguage.define(shell);
    }
    case "javascript":
    default:
      return (await import("@codemirror/lang-javascript")).javascript();
  }
}