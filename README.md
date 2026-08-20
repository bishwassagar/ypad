# YPad

A minimalist, self-hosted collaborative text editor, inspired by
[Rustpad](https://rustpad.io). Open a pad via a shared link, paste content, and
everyone on that link edits the same document in real time. Documents persist
in the cloud even when no one is connected.

## Features

- Real-time collaborative editing (Yjs CRDT)
- Remote cursors and selections with per-user colors
- Active users list and editable names
- Shared language selector (last-writer-wins)
- Dark mode by default, light mode opt-in (persisted locally)
- Connection status indicator
- Cloud persistence — pads survive all clients disconnecting
- Share link with copy-to-clipboard
- No auth: anyone with the link can edit (same as Rustpad)

## Stack

| Layer      | Choice                                              |
| ---------- | --------------------------------------------------- |
| Sync       | Yjs CRDT (`Y.Doc` + `Y.Text`)                       |
| Backend    | PartyKit + `y-partykit` (Cloudflare Workers / DOs)  |
| Frontend   | React + Vite + TypeScript                           |
| Editor     | CodeMirror 6 via `y-codemirror.next`                |
| Styling    | Tailwind CSS v4                                     |
| Icons      | `lucide-react`                                      |
| Routing    | Hash routing (`/#<roomId>`) — no rewrite rules      |

## Local development

```bash
npm install

# Terminal 1: PartyKit backend (http://localhost:1999)
npx partykit dev

# Terminal 2: Vite frontend
npm run dev
```

Open the printed URL in two browser windows (or one normal + one incognito),
type in one, and watch the other update live. Reloading keeps the content —
it is persisted by the backend.

`VITE_PARTYKIT_HOST` (see `.env.example`) overrides the PartyKit server URL,
defaulting to `localhost:1999`.

## Deploy

Backend (Cloudflare):

```bash
npx partykit deploy
```

Frontend (any static host — Vercel, Netlify, GitHub Pages):

```bash
npm run build   # outputs to dist/
```

Set `VITE_PARTYKIT_HOST` to your deployed party URL (e.g.
`ypad-<username>.partykit.dev`) at build time.

## Verification

```bash
npx tsc --noEmit        # typecheck
npm run build           # production build
npx partykit dev        # local backend smoke test
```

## License

MIT