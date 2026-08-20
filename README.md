# YPad

A minimalist, self-hosted collaborative text editor, inspired by
[Rustpad](https://rustpad.io). Open a pad via a shared link, paste content, and
everyone on that link edits the same document in real time. Documents persist
in the cloud even when no one is connected.

## Try it

The app is live on both platforms, backed by the same Cloudflare sync worker:

- **Cloudflare Pages** → https://ypad.pages.dev/
- **GitHub Pages** → https://bishwassagar.github.io/ypad/

Open the same link in two browser windows (or one normal + one incognito),
type in one, and watch the other update live. Reload the page — content is
persisted in the cloud. You can also fork this repo and deploy it to your own
Cloudflare account and static host in minutes (see [Deploy](#deploy)).

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
| Backend    | Cloudflare Worker + Durable Object (`y-websocket` wire protocol) |
| Frontend   | React + Vite + TypeScript                           |
| Editor     | CodeMirror 6 via `y-codemirror.next`                |
| Styling    | Tailwind CSS v4                                     |
| Icons      | `lucide-react`                                      |
| Routing    | Hash routing (`/#<roomId>`) — no rewrite rules      |

## Local development

```bash
npm install

# Terminal 1: sync worker (http://localhost:8787)
npm run server

# Terminal 2: Vite frontend
npm run dev
```

Open the printed URL in two browser windows (or one normal + one incognito),
type in one, and watch the other update live. Reloading keeps the content —
it is persisted by the worker.

`VITE_SYNC_HOST` (see `.env.example`) overrides the sync worker URL,
defaulting to `localhost:8787`.

## Deploy

Backend (Cloudflare):

```bash
npx wrangler login      # once, to authorize your Cloudflare account
npm run server:deploy
```

The worker uses a free `*.workers.dev` subdomain — no custom domain needed.
Durable Object storage makes pads persist with zero clients connected.

Frontend (any static host — Vercel, Netlify, GitHub Pages):

```bash
npm run build   # outputs to dist/
```

Set `VITE_SYNC_HOST` to your deployed worker URL (e.g.
`ypad.<username>.workers.dev`) at build time.

### Automatic deploys

This repo ships two GitHub Actions workflows that redeploy the frontend on
every push to `main`:

- `deploy-cloudflare-pages.yml` — builds and publishes `dist/` to Cloudflare
  Pages (needs `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` repo secrets).
- `deploy-gh-pages.yml` — builds with `--base=/ypad/` and publishes to GitHub
  Pages.

Fork the repo, wire up the two secrets (and your own sync worker), and both
URLs update automatically on push.

## Verification

```bash
npm run build           # typecheck + production build
npm run server          # local backend smoke test
```

## License

MIT