export interface UserInfo {
  name: string;
  hue: number;
  color: string;
  colorLight: string;
}

export interface Peer {
  clientId: number;
  name: string;
  hue: number;
  color: string;
  colorLight: string;
  isSelf: boolean;
}

const NAME_KEY = "ypad-name";
const HUE_KEY = "ypad-hue";
const THEME_KEY = "ypad-theme";

const ADJACENT = [15, 30, 60, 105, 150, 195, 240, 285, 330];

const ADJECTIVES = [
  "Swift",
  "Quiet",
  "Brave",
  "Calm",
  "Lucky",
  "Clever",
  "Bold",
  "Kind",
];
const ANIMALS = ["Otter", "Fox", "Hawk", "Wolf", "Lynx", "Heron", "Owl", "Falcon"];

export function colorFor(hue: number): string {
  return `hsl(${hue} 70% 60%)`;
}

export function colorLightFor(hue: number): string {
  return `hsla(${hue} 70% 60% / 0.25)`;
}

function generateName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a} ${b}`;
}

export function loadUser(): UserInfo {
  let name = localStorage.getItem(NAME_KEY);
  if (!name) {
    name = generateName();
    localStorage.setItem(NAME_KEY, name);
  }
  const hue = Number(localStorage.getItem(HUE_KEY) ?? 0);
  return { name, hue, color: colorFor(hue), colorLight: colorLightFor(hue) };
}

export function persistUser(user: UserInfo): void {
  localStorage.setItem(NAME_KEY, user.name);
  localStorage.setItem(HUE_KEY, String(user.hue));
}

export function resolveHue(
  states: Map<number, unknown>,
  selfId: number,
  user: UserInfo,
): UserInfo {
  const used = new Set<number>();
  for (const [clientId, state] of states) {
    if (clientId === selfId) continue;
    const other = (state as { user?: UserInfo } | null | undefined)?.user;
    if (other && Number.isFinite(other.hue) && other.hue !== 0) used.add(other.hue);
  }
  if (user.hue !== 0 && !used.has(user.hue)) return user;
  const hue = ADJACENT.find((h) => !used.has(h)) ?? Math.floor(Math.random() * 360);
  return { ...user, hue, color: colorFor(hue), colorLight: colorLightFor(hue) };
}

export function peersFromStates(
  states: Map<number, unknown>,
  selfId: number,
): Peer[] {
  const peers: Peer[] = [];
  for (const [clientId, state] of states) {
    const user = (state as { user?: UserInfo } | null | undefined)?.user;
    if (!user) continue;
    peers.push({
      clientId,
      name: user.name,
      hue: user.hue,
      color: user.color,
      colorLight: user.colorLight,
      isSelf: clientId === selfId,
    });
  }
  return peers.sort(
    (a, b) => Number(a.isSelf) - Number(b.isSelf) || a.name.localeCompare(b.name),
  );
}

export function loadTheme(): boolean {
  return localStorage.getItem(THEME_KEY) !== "light";
}

export function persistTheme(dark: boolean): void {
  localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
}