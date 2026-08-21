import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import { cmTheme } from "./editorTheme";
import { loadLanguage } from "./language";
import { smartPaste } from "./smartPaste";

interface EditorProps {
  doc: Y.Doc;
  awareness: Awareness;
  dark: boolean;
  language: string;
}

export function Editor({ doc, awareness, dark, language }: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeRef = useRef(new Compartment());
  const languageRef = useRef(new Compartment());
  const langReqRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const ytext = doc.getText("content");
    const undoManager = new Y.UndoManager([ytext]);

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          yCollab(ytext, awareness, { undoManager }),
          basicSetup,
          themeRef.current.of(cmTheme(dark)),
          languageRef.current.of([]),
          smartPaste(),
        ],
      }),
    });
    viewRef.current = view;

    const req = ++langReqRef.current;
    void loadLanguage(language).then((ext) => {
      if (langReqRef.current === req) {
        view.dispatch({ effects: languageRef.current.reconfigure(ext) });
      }
    });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, awareness]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeRef.current.reconfigure(cmTheme(dark)),
    });
  }, [dark]);

  useEffect(() => {
    const req = ++langReqRef.current;
    void loadLanguage(language).then((ext) => {
      if (langReqRef.current === req) {
        viewRef.current?.dispatch({
          effects: languageRef.current.reconfigure(ext),
        });
      }
    });
  }, [language]);

  return <div ref={hostRef} className="h-full overflow-hidden" />;
}
