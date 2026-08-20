import { useEffect, useRef, useState, type ReactNode } from "react";

interface DropdownProps {
  button: ReactNode;
  buttonClass?: string;
  align?: "left" | "right";
  children: (close: () => void) => ReactNode;
}

export function Dropdown({
  button,
  buttonClass = "",
  align = "left",
  children,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={buttonClass}>
        {button}
      </button>
      {open && (
        <div
          className={`absolute z-40 mt-1 max-h-72 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}