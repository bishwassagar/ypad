import type { Peer } from "../presence";

const MAX_AVATARS = 4;

export function AvatarCluster({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null;
  const shown = peers.slice(0, MAX_AVATARS);
  const extra = peers.length - shown.length;
  return (
    <div className="flex items-center -space-x-2">
      {shown.map((peer) => (
        <span
          key={peer.clientId}
          title={peer.name}
          className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-neutral-900 ring-2 ring-white dark:ring-neutral-950 ${
            peer.isSelf ? "ring-offset-1 ring-offset-white dark:ring-offset-neutral-950" : ""
          }`}
          style={{ backgroundColor: peer.color }}
        >
          {peer.name.charAt(0).toUpperCase()}
        </span>
      ))}
      {extra > 0 && (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-200 text-[11px] font-medium text-neutral-600 ring-2 ring-white dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-950">
          +{extra}
        </span>
      )}
    </div>
  );
}