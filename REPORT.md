# Panelization + cost optimizer — work report

Branch: `panelize` (local only). Started 2026-09-28.

## 1. Git remotes and what was pushed

`git remote -v` at the start of the session:

```
origin	git@github.com:cheewee2000/flamingo-pcb.git (fetch)
origin	git@github.com:cheewee2000/flamingo-pcb.git (push)
```

**Nothing was pushed.** `origin` points at `cheewee2000/flamingo-pcb` (the original
repo), not at a fork, so per the git rules every commit stays local on the
`panelize` branch. No remotes were added, no pull request was opened, nothing was
fetched or merged from anywhere.

To publish the branch yourself once `origin` points at your fork:

```sh
git remote set-url origin git@github.com:<you>/flamingo-pcb.git   # or add your fork as origin
git push -u origin panelize
```

## 2. Baseline before any change

`npm install && npm run build && npm test` on untouched `main` (487b6b0):

| Package | Result |
| --- | --- |
| engine | 305 passed |
| fab | 67 passed, **1 failed** |
| parts | 41 passed |
| server | 147 passed, **2 failed**, 2 skipped |
| ui | 41 passed |

The three failures exist on `main` and are caused by this machine, not by the code:

- `fab/test/gerber.test.ts > demo board integration` reads
  `.superpowers/sdd/demo/board.flamingo`, which is gitignored and absent here.
- `server/test/screenshot.test.ts` (2 label-overlay tests) compare PNGs with and
  without `<text>` labels. This machine has no system fonts (`fc-list` prints
  nothing), so resvg draws no text and the images are identical.

They are left as they are (additive-only rule) and are the expected failures in
every test run below.

Also missing on this machine: **Java**. Freerouting cannot run, so the existing
`e2e-esp32.ts` cannot pass here as written. See "Known bugs and limitations".

## 3. Architecture note (existing code)

npm workspaces, ESM, strict TypeScript, Vitest. Five packages, built in
alphabetical order by `npm run build -ws`:

- **engine** — pure library. `Board` is plain JSON (`types.ts`); `applyOp(board, op)`
  is a pure reducer over a discriminated `Op` union that returns a new board or
  `{ok:false,error}`. Geometry (`geometry.ts`) is mm, y-up, degrees CCW, with
  polygon booleans from `polygon-clipping`. `fillAllZones` clips pours to the
  board outline. `runDRC` picks a ruleset by layer count. `renderSVG` draws a board.
- **parts** — LCSC/EasyEDA fetch + parse + cache; `PartInfo.basic` and
  `PartInfo.price`; `fetchJlcStock` for the JLC assembly library.
- **fab** — `generateGerbers(board)` (Gerber X2 + Excellon via a private
  `GerberBuilder`), `generateBOM`, `generateCPL`, `exportFab` (zips + writes).
- **server** — `Doc` owns the live board: snapshot undo/redo stacks (the "op
  log"), debounced atomic save, `change` events. `http.ts` serves the UI, a REST
  API under `/api/*`, a WebSocket at `/ws` that pushes `{type:'board'}` on every
  change and accepts `{type:'op'}`, and a stateless MCP endpoint at `/mcp`
  (`mcp.ts`, one `registerTool` per tool, zod schemas, text results).
  `cli.ts` has one command, `serve`.
- **ui** — Vite, no framework. A store (`state.ts`), a canvas renderer, pure
  view math (`view.ts`), tools, DOM panels. Talks to the server over `/ws` and
  `/api/*`.

Sync model: the server is the single source of truth. MCP tools and browser edits
both call `doc.apply(op)`; the `change` event fans the new board out to every
socket.

## 4. Architecture of the new code

(filled in as the work proceeds)
