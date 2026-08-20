const dot: Record<ConnectionStatus, string> = {
  connecting: "bg-amber-500 animate-pulse",
  connected: "bg-emerald-500",
  disconnected: "bg-red-500",
};

const label: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
};

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export function StatusDot({ status }: { status: ConnectionStatus }) {
  return (
    <span
      title={label[status]}
      className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400"
    >
      <span className={`h-2 w-2 rounded-full ${dot[status]}`} />
      <span className="hidden sm:inline">{label[status]}</span>
    </span>
  );
}