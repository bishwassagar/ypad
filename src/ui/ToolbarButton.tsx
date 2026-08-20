import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

export function ToolbarButton({
  children,
  className = "",
  ...rest
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-1.5 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}