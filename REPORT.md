# Panelization + cost optimizer — work report

Branch `panelize`, 13 commits on top of `main` (487b6b0). Written 2026-09-28.
All ten steps of the order of work are done and committed. Nothing was pushed.

## 1. Git remotes and what was pushed

`git remote -v` at the start of the session:

```
origin	git@github.com:cheewee2000/flamingo-pcb.git (fetch)
origin	git@github.com:cheewee2000/flamingo-pcb.git (push)
```

**Nothing was pushed.** `origin` points at `cheewee2000/flamingo-pcb`, the
original repo, not at a fork. Per the git rules every commit stays local on
`panelize`. No remote was added, no pull request was opened, nothing was fetched
or merged, `main` was not touched, nothing was force-pushed.

To publish the branch once `origin` points at your fork:

```sh
git remote set-url origin git@github.com:<you>/flamingo-pcb.git
git push -u origin panelize
```

## 2. Summary

Given two or more board files and quantities, Flamingo now lays out a panel,
checks it against JLCPCB's limits, ranks the ways to order the boards with
itemized costs, and exports one fileset for the panel. All of it is drivable
over MCP (23 new tools), from the shell (`flamingo panel ...`), and from a
slicer-style view at `/panel`.

For the brief's example, 1 ESP32 board + 5 USB-C breakouts, the optimizer's
answer is:

| Rank | Scenario | Total | Boards received |
| --- | --- | --- | --- |
| 1 | One board, silkscreen dividers, 1×S + 3×M, 2 of 5 assembled | ~$30.48 | S 2, M 6 |
| 2 | One board, silkscreen dividers, 1×S + 1×M, 5 of 5 assembled | ~$32.18 | S 5, M 5 |
| 3 | One panel, mouse bites, 1×S + 3×M, 2 of 5 assembled | ~$46.69 | S 2, M 6 |
| 4 | One panel, mouse bites, 1×S + 1×M, 5 of 5 assembled | ~$48.39 | S 5, M 5 |
| 5 | Separate orders | ~$53.46 | S 2, M 5 |

Three things to know before trusting those numbers:

1. **They are estimates, and low.** Every bare-board price is an estimate, and
   the ESP32 module has no price in Flamingo's part data, so it is missing
   from every total (section 9).
2. **The gap between ranks 1–2 and 3–4 is mostly two fees**: the
   different-designs fee, whose amount is my guess ($8), and the panel fee
   ($8.21, verified, but whether it applies is my reading).
3. **The panel gerbers parse cleanly but have not been opened in a Gerber
   viewer.** Do that before ordering (section 13).

## 3. Status

| # | Step | Status |
| --- | --- | --- |
| 1 | Read the codebase, architecture note | done (section 5) |
| 2 | Panel format, op log, load/save, stale detection | done |
| 3 | Constraint checks | done |
| 4 | Auto-layout and render | done |
| 5 | Merged BOM, CPL, gerbers | done |
| 6 | Cost model and fee table | done; bare-board prices are estimates (section 9) |
| 7 | Scenario optimizer | done |
| 8 | MCP tools, CLI, README section | done; CLI has no undo/redo (section 6.9) |
| 9 | E2E script | done; passes routed and unrouted |
| 10 | UI | done as specified; section 14 lists what the spec left open |

Partial: nothing is half-built. Not started: nothing from the brief. What is
deliberately absent is in sections 13 and 14.

## 4. Baseline and this machine

`npm test` on untouched `main` has three failures that come from this machine,
not from the code. They are unchanged on `panelize` and are the only failures
in any run below.

- `fab/test/gerber.test.ts > demo board integration` reads
  `.superpowers/sdd/demo/board.flamingo`, which is gitignored and absent here.
- `server/test/screenshot.test.ts`, two label-overlay tests: they compare PNGs
  with and without `<text>`. This machine has no fonts installed (`fc-list`
  prints nothing), so resvg draws no text and the images are identical.

Two tools the work needed are not installed here, and nothing was installed
system-wide to get them:

- **Java.** Freerouting needs it (2.4.1 needs Java 25). I downloaded a Temurin
  JRE tarball into this session's temporary scratch directory and pointed
  `JAVA_HOME` at it for the routed e2e runs only. It is not on `PATH` and goes
  away with the session. Without Java the panel e2e still runs, on unrouted
  boards; see section 11.
- **Chromium's system libraries.** Playwright's Chromium is in
  `~/.cache/ms-playwright` but cannot start (`libglib-2.0.so.0` missing). The
  UI check ran the browser in the `mcr.microsoft.com/playwright:v1.61.1-noble`
  image that was already on this machine, as container `flamingo-pw-panelize`
  on port 4103. I started that container and stopped it again; no other
  container or port was touched.

Side effects outside the repo, all from running the existing tools:
`~/.flamingo/parts/` (part cache) and `~/.flamingo/freerouting.jar` now exist.
I also wrote `~/.config/dev-previews/flamingo-pcb.md` with the above.

## 5. Architecture

### What was there

npm workspaces, ESM, strict TypeScript, Vitest. `engine` is a pure library:
`Board` is plain JSON, `applyOp(board, op)` is a pure reducer over a
discriminated `Op` union, geometry is mm / y-up / degrees CCW. `fab` writes
Gerber, Excellon, BOM and CPL from a `Board`. `server` owns the live `Doc`
(snapshot undo/redo, debounced atomic save, `change` events), serves REST under
`/api/*`, a WebSocket at `/ws` that pushes the board on every change, and a
stateless MCP endpoint at `/mcp`. `ui` is Vite with no framework: a store, a
canvas renderer, pure view math. The server is the single source of truth; MCP
and browser both call `doc.apply(op)`.

### What was added

```
packages/panel/            new package, @flamingo/panel
  config/panel-limits.json   size limits, rail/tab/fiducial geometry, with sources
  config/fee-table.json      every fee, with source and verified flag
  src/                       pure and browser-safe (the default entry point)
    types, panel, ops        the format and its reducer
    history                  generic snapshot undo/redo
    source                   what a panel needs to know about a board; blocked edges
    transform                where an instance is
    geometry                 frame, rails, tabs, fiducials, tooling holes, routed profile
    check                    constraint checks
    layout                   arrange
    merge                    the one Board a panel amounts to
    cost, order, scenarios   cost model, panel -> order, optimizer
    view                     the data a client draws
  src/node/                  needs Node (entry point @flamingo/panel/node)
    config, hash, load       config files, content hash, source resolution
    render                   SVG
    exportPanelFab           fab files, through packages/fab
packages/server/src/panel/
  doc                        PanelDoc: the panel counterpart of Doc
  session                    PanelSession: everything the server can do with a panel
  mcp, http, cli, format     thin wrappers over the session
packages/ui/panel.html, src/panel/   the panel view, a second page
```

The same shape as the board side, one level up: a pure reducer over plain JSON,
a server-side document with an op log, and one derived view pushed to every
client. `PanelSession` is the single place panel work happens, so MCP, HTTP,
WebSocket and CLI cannot drift apart.

## 6. Technical decisions

### 6.1 Format

- **A new package** rather than more code in `engine`. Panels depend on `fab`
  for output, and `engine` must not. The package has two entry points so the
  browser never bundles `node:fs` or `archiver`.
- **Instance position is the bottom-left corner of the rotated bounding box.**
  Rotation never moves an instance off its corner, and packing, hit testing and
  the UI all work in the same terms. `panel_rotate_instance` and the UI turn
  about the centre by computing the corner that keeps the centre still.
- **The hash covers the board's canonical serialization, not the file bytes.**
  Re-indenting or re-saving an unchanged board does not mark panels stale.
- **The panel always uses the board as it is on disk.** `stale` means "this
  changed since you last looked", not "the old version is being used". It is a
  warning and does not gate export. `panel_refresh_boards` acknowledges it.
- **Op log: an equivalent, not a generalization.** `History<T>` in
  `@flamingo/panel` is the generic snapshot stack and `PanelDoc` uses it. `Doc`
  was left untouched rather than rebuilt on it, because that would have meant
  changing a class the board editor depends on. `Doc` could move onto `History`
  later with no behaviour change.
- **The frame is derived, never stored.** It wraps the instances wherever they
  are. Nothing can be "outside the panel", and the panel's size is always what
  the cost is computed from.

### 6.2 Blocked edges

- **Per edge, not per stretch of edge.** One connector blocks the whole side it
  overhangs. Coarser than necessary, always safe, and what the brief describes.
- "Edges" are the four sides of the outline's bounding box. A part that sticks
  into the notch of a non-rectangular board blocks every side nearest to a
  stray corner.
- A footprint without a courtyard is judged by its pads.
- **Two parts overhanging toward each other must clear each other**
  (overhang + overhang + margin), not just the opposite board. The first e2e
  run put two USB-C shells 8 µm apart; this rule is the fix.

### 6.3 Layout

- **Bottom-left packing of grown rectangles over a range of strip widths.**
  Each instance grows by the clearance each side needs, so grown rectangles may
  touch. It leaves holes that a smarter packer would fill; it never produces an
  invalid panel.
- **Preference order**: a panel an assembly line accepts, then rails along the
  long sides, then smaller area (with strips beyond 3:1 penalized). Without the
  second rule two boards stack into a 40 × 76 mm strip with its rails on the
  short sides.
- **Rotations tried: as it is, and a quarter turn.** A deliberate 180° flip by
  the user survives an arrange.
- **One exception, the support pass.** A board left with too few tabs is turned
  180° inside the space it already occupies when that gets it held better and
  makes nothing worse. Costs no area. Off when rotation is off.
- **A failed arrange changes nothing** and returns the reason plus the smallest
  panel the packer found ignoring the limit.
- **The binding limit** is the fab maximum for the layer count, tightened to the
  roomier assembly service's limit when any instance is populated.

### 6.4 Tabs and rail features

- Tabs bridge from a board's unblocked edge to the nearest facing board or rail
  within `tabs.maxLength` (8 mm). Each pair of boards is tabbed once.
- One tab per edge, two as soon as two fit with a gap between them, more at
  `tabs.pitch`.
- **Mouse-bite holes on board ends of a tab only**, none on rail ends, one third
  of the hole inside the board. Both per JLCPCB's mouse-bite guide.
- **Three fiducials, four tooling holes.** Three marks make the pattern
  unambiguous; JLCPCB's figure of 3.85 mm is the distance to the rail's outer
  edge. Bottom-side fiducials are added when a populated board has bottom parts.
- **No V-cut.** The brief asks for mouse bites; Economic PCBA does not take
  V-cut panels; V-cut needs zero spacing and straight full-width lines, which
  is a different layout problem.

### 6.5 Fab output

- **A panel is merged into one `Board` and handed to the existing writers.**
  That is the reuse of `packages/fab` the brief asks for.
- **Net names are prefixed per instance** (`S1/GND`). Two boards' GND nets are
  not connected and nothing may treat them as one.
- **Pours are filled on each source board and the finished fill is moved.**
  `fillAllZones` clips to the board outline; on the merged board the outline is
  the panel frame, so re-pouring would flood the gaps.
- **Silkscreen labels are placed on the source board and moved**, so a board on
  a panel carries exactly the legend it carries alone (`U2`, not `S1_U2`).
- **The `.GKO` is the union of boards, tabs and rails**: the panel outline plus
  a closed contour per routed opening.
- **Bare instances are fabricated, without paste**, and absent from BOM and CPL.
- **One BOM comment per LCSC part across boards.** Two boards naming one part
  differently would put it on two BOM rows, which JLCPCB stops on. The first
  name wins and the export says so.
- **No DRC on the merged board.** Each source board's own DRC is run (cached by
  hash) and gates the export; the panel check covers what is between boards.

### 6.6 Cost model

- `computeCost(order, fees)` is pure. It holds no price. Each line carries
  `estimate` and `sources` from the fee entries it used.
- **Bare-board price** = special offer when the piece fits 100 × 100 mm and the
  quantity is on offer, else engineering fee + area × rate. The offer is never
  allowed to cost more than the area price.
- **Part prices come from the EasyEDA part data Flamingo already caches.** They
  are always flagged as estimates. A part with no price is listed at $0 and
  named in a note. **The ESP32-S3 module has no price in that data**, so every
  total for the reference board is low by about two modules' worth.
- **Through-hole joints are counted from plated through-hole pads**, which
  includes the mounting legs of the USB-C connector. JLCPCB may not charge
  those as hand-soldered; a note says so wherever the line appears.
- **Panel fee** ($8.21, "applicable when the number of panelized designs > 1")
  is applied once to an assembly order whose piece is a routed panel of more
  than one board. That reading is mine.
- **The stock check is not run for panels.** It calls jlcpcb.com; I kept new
  code off JLCPCB's API entirely. `e2e-panel.ts` sets
  `FLAMINGO_STOCK_CHECK=off` unless the caller set it.

### 6.7 Scenarios

- **`needed`** = assembled boards the order must deliver. **`niceToHave`** =
  total boards welcome if cheap, assembled or bare. The brief does not define
  it; this is my reading. Change it in `scenarios.ts` (`variants`).
- **Quantities come in steps**: boards in 5, 10, 15 ..., assembly in 2, 5, 10
  .... Needing 1 + 5 therefore yields 2 + 6 at best. Every scenario shows
  received against needed.
- **Partial population** appears when a design has a nice-to-have quantity: the
  needed boards populated, the rest of the wish bare.
- **Silkscreen-divider is offered when** every outline fills 98% of its
  bounding box and there are at most 10 designs.
- **"Cost per needed board"** divides by needed boards plus nice-to-have boards
  actually delivered. With no nice-to-have it is total / needed.
- Scenarios that cannot be built are returned in `rejected` with the reason.

### 6.8 Server

- **Panel support is opt-in on `startServer`; the CLI turns it on.** An existing
  test asserts that the MCP endpoint serves exactly 34 tools. Rather than edit
  that test, a server started without `panel` behaves exactly as before.
- **The panel socket is `/ws?channel=panel`**, the same `WebSocketServer`.
  Two servers on one HTTP server with different paths abort each other's
  handshakes in `ws`.
- **The view is derived server-side and pushed whole.** The browser draws what
  MCP reads, by construction.
- **An unsaved panel gets a file when it gains its first board**, as
  `flamingo serve` creates a missing board file.

### 6.9 CLI

- `flamingo panel <command> <file>` works on the file directly, no server.
- **No `undo` / `redo` commands.** The op log is in memory, as for boards, and
  each command is a process of its own.

## 7. UX decisions

Everything here is mine to have made only because the brief left it open.

**Canvas**

1. White plate, black ink (the board editor's canvas is dark).
2. Selected = 4 px outline + square handles at the corners.
3. Pinned = filled square in the top-left corner + label `PINNED`.
4. Bare = dashed outline + sparse diagonal hatch + label `BARE`.
5. Blocked edge = 5 px line with a comb of ticks pointing outward.
6. Error / warning = a second outline just outside the board, solid / dashed,
   + label `ERROR` / `WARNING`.
7. Stale = dotted outline + label `STALE`.
8. Overhanging part = thin dashed polygon. Board-edge keepout = cross hatch.
9. Rails = diagonal hatch. Tabs = solid bars. Mouse-bite holes = open circles,
   drawn only when zoomed in far enough to be more than a speck.
10. Size limits = long-dash rectangles anchored at the panel's bottom-left
    corner. The one arrange packs against is heavier and says so. Labels are
    kept on screen when the limit's corner is not.
11. Labels scale with the instance; tags that do not fit are dropped from the
    right.
12. While dragging, the instance shows its position in mm.

**Interaction**

13. A press becomes a drag after 3 px.
14. Drop positions are rounded to 0.01 mm. No grid snap.
15. Dragging is not constrained by collisions. You can drop a board on another;
    the check reports it.
16. `+` adds an instance **and arranges everything unpinned**, as one undo step.
    Otherwise the new instance would land on top of the first.
17. `−` removes unpinned instances first, highest number first.
18. Duplicate places the copy to the right of the original, unpinned, keeping
    populated/bare.
19. Rotate turns about the instance's centre.
20. The plate re-fits on first load, after Arrange, and after a scenario loads.
    Nothing else moves the view.
21. **Extra hotkeys**: `Backspace` also deletes (Mac keyboards have no Delete);
    `Escape` closes the menu, cancels a drag, deselects.
22. The right-click menu shows "Make bare" or "Make populated" by state.
    "Unpin" is struck through when the instance is not pinned.
23. Right-click on empty plate does nothing.

**Sidebar**

24. Order: Boards, Arrange, Estimated cost, Compare scenarios, Warnings, Export.
25. 420 px wide, scrolls on its own.
26. Estimates are marked `est.` after the amount, with a legend under the cost.
    (Reports for agents mark them `~`.)
27. The scenario table has four columns: rank, scenario, total, per board.
    Received-versus-needed and the warning count sit under the title, because
    a fifth and sixth column do not fit 420 px.
28. **Selecting a scenario loads it at once, without asking.** It is one undo
    step and the message says so.
29. A scenario of single boards has no panel; selecting it shows its fees and a
    note, and leaves the plate alone.
30. A scenario with several panels loads the first and says so in its warnings.
31. Warnings are listed errors first. The "Warnings" section also holds notes
    (blocked edges, promotion).
32. **Export in the UI cannot waive.** A panel with errors is refused with the
    findings. Waiving is `export_panel_fab waive:true` or `--waive`.
33. Export shows a download link rather than starting the download itself.
34. Messages stay until the next action replaces them. No toasts.
35. **No debounce.** The server derives a view, checks and cost included, in
    about 5 ms; see section 10.
36. Scenarios are re-fetched when boards, quantities or settings change, not
    when an instance moves.
37. A link to the board editor in the header. The editor has no link back,
    because that would mean editing the editor.

## 8. Changed existing files

Nine existing files and two existing documents. Everything else is new.

| File | Change | Why |
| --- | --- | --- |
| `packages/fab/src/gerber.ts` | `generateGerbers(b, extras = {})`. Extras: `prefilled`, `profile`, `fiducials`, `labels`, `noPaste`. | A panel needs a routed profile instead of one outline, fiducials without paste, pours that are not re-poured, labels that keep their text. With no extras the output is byte-identical; every fab test passes as before. |
| `packages/fab/src/index.ts` | Exports the two new types. | |
| `packages/server/src/mcp.ts` | `McpContext.panel?`; registers the panel tools when present. | Same endpoint as the board tools. |
| `packages/server/src/http.ts` | `StartServerOptions.panel`, dispatch of `/api/panel/*` and `/panel`, the panel channel on `/ws`, a nudge to the panel when the board changes. | All behind `if (ctx.panel)`. |
| `packages/server/src/cli.ts` | `serve --panel <file>`, the `panel` command. | |
| `packages/server/package.json` | Depends on `@flamingo/panel`; dev-depends on `playwright-core`. | |
| `packages/ui/package.json` | Depends on `@flamingo/panel`. | |
| `packages/ui/vite.config.ts` | Two HTML entry points. | The panel view is a page of its own. **Side effect:** the editor's bundle is now `main-*.js` plus a chunk shared with the panel page, where it was `index-*.js`. Same code; the CSS hash is unchanged. |
| `package-lock.json` | The new workspace and `playwright-core`. | |
| `README.md` | New section "Panels and order cost"; one line in Architecture. | |
| `CLAUDE.md` | New section "Panels"; two lines under Build & test. | So an agent in this repo finds the panel tools. Not asked for; revert if unwanted. |

No existing test was edited. `e2e-esp32.ts` was not touched; it passes
(exit 0) with Java available.

## 9. Fee values and their status

**verified** = read from a JLCPCB `/help/` article with WebFetch on 2026-09-28.
Everything else is flagged unverified and surfaces as an estimate:

- **published, not a help page** = read with WebFetch from JLCPCB's
  capabilities pages. Real published numbers, but not from a help article, so
  by the brief's rule they are not marked verified. Two of them
  (`assembly.*.qtySteps`) cite that page for the range only; the steps inside
  the range are from memory.
- **ESTIMATE** = JLCPCB publishes no figure, or I found it only in a blog post
  or a search-result summary.
- **design choice** = Flamingo's own default, not a claim about JLCPCB.

What matters most:

- **Every bare-board price is an estimate.** JLCPCB publishes them only through
  its quote calculator, which was never called. The 4-layer numbers are fitted
  to one published data point; the 2-layer and 6-layer numbers have less behind
  them. Expect the ranking to be more reliable than the totals.
- **The different-designs fee ($8 per extra design) is a guess.** The help page
  confirms the charge and gives no amount. It decides between the merged and
  the silk-divider scenarios, so check it on the quote page before relying on
  that choice.
- **Assembly fees are verified**, all from one page.
- `assembly.*.panelSize` is marked verified for its maximum (250 × 250 mm, from
  the FAQ); its minimum is from the capabilities page.

### Fee table (`packages/panel/config/fee-table.json`)

| Entry | Value | Status | Source |
| --- | --- | --- | --- |
| `pcb.qtySteps` | `[5,10,15,20,25,30,50,75,100,125,150,200,250,300,400,500]` | **ESTIMATE** | cart.jlcpcb.com/quote |
| `pcb.promo.maxSize` | `{"width":100,"height":100}` | **ESTIMATE** | jlcpcb.com/blog/custom-pcb-cost |
| `pcb.promo.prices.2` | `[{"qty":5,"price":2},{"qty":10,"price":5}]` | **ESTIMATE** | jlcpcb.com/blog/custom-pcb-cost |
| `pcb.promo.prices.4` | `[{"qty":5,"price":7}]` | **ESTIMATE** | jlcpcb.com/blog/special-discount-on-quality-4-layers-pcbs |
| `pcb.promo.prices.6` | `[]` | **ESTIMATE** | cart.jlcpcb.com/quote |
| `pcb.engineeringFee.2` | `8` | **ESTIMATE** | cart.jlcpcb.com/quote |
| `pcb.engineeringFee.4` | `20` | **ESTIMATE** | jlcpcb.com/blog/special-discount-on-quality-4-layers-pcbs |
| `pcb.engineeringFee.6` | `50` | **ESTIMATE** | cart.jlcpcb.com/quote |
| `pcb.areaRate.2` | `[{"upToM2":0.5,"perM2":45},{"upToM2":3,"perM2":35},{"upToM2":null,"perM2":30}]` | **ESTIMATE** | cart.jlcpcb.com/quote |
| `pcb.areaRate.4` | `[{"upToM2":0.5,"perM2":65},{"upToM2":3,"perM2":50},{"upToM2":null,"perM2":45}]` | **ESTIMATE** | jlcpcb.com/blog/special-discount-on-quality-4-layers-pcbs |
| `pcb.areaRate.6` | `[{"upToM2":0.5,"perM2":160},{"upToM2":3,"perM2":130},{"upToM2":null,"perM2":120}]` | **ESTIMATE** | cart.jlcpcb.com/quote |
| `pcb.differentDesigns.perExtraDesign` | `8` | **ESTIMATE** | jlcpcb.com/help/article/in-what-cases-will-there-be-charged-extra |
| `pcb.differentDesigns.rule` | `"separable"` | verified 2026-09-28 | jlcpcb.com/help/article/different-design-in-your-pcb-files |
| `pcb.differentDesigns.maxDesigns` | `10` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-panelization |
| `pcb.smallBoardDeburring` | `[{"underMm":15,"perPiece":0.05},{"underMm":30,"perPiece":0.02}]` | verified 2026-09-28 | jlcpcb.com/help/article/in-what-cases-will-there-be-charged-extra |
| `assembly.economic.setupFee` | `{"single":8.18,"double":null}` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.economic.stencil` | `{"single":1.53,"double":null}` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.economic.smtJoint` | `[{"upTo":100000,"price":0.0016}]` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.economic.feederLoading` | `{"basic":0,"extended":3.07}` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.economic.qtySteps` | `[2,5,10,15,20,25,30,50]` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.standard.setupFee` | `{"single":25.56,"double":51.12}` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.standard.stencil` | `{"single":8.21,"double":16.42}` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.standard.smtJoint` | `[{"upTo":50000,"price":0.0016},{"upTo":100000,"price":0.0013},{"upTo":1000000,"price":0.0012}]` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.standard.feederLoading` | `{"basic":1.53,"extended":1.53}` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.standard.qtySteps` | `[2,5,10,15,20,25,30,50,75,100,125,150,200,250,300,400,500]` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.manualJoint` | `0.0164` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.handSolderLabor` | `3.58` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.panelFee` | `8.21` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `assembly.largePcb` | `{"overCm2":650,"fee":57.46}` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-price |
| `parts.attrition` | `[{"maxJoints":2,"extra":8,"minimum":20,"kind":"two-pad passives"},{"maxJoints":8,"extra":3,"m...` | **ESTIMATE** | jlcpcb.com/help/answers/detail/92-What-are-the-MOQ-and-attrition |

### Limits and panel geometry (`packages/panel/config/panel-limits.json`)

| Entry | Value | Status | Source |
| --- | --- | --- | --- |
| `fab.maxSize.2` | `{"width":670,"height":600}` | published, not a help page | jlcpcb.com/capabilities/pcb-capabilities |
| `fab.maxSize.4` | `{"width":663,"height":593}` | published, not a help page | jlcpcb.com/capabilities/pcb-capabilities |
| `fab.maxSize.6` | `{"width":656,"height":586}` | published, not a help page | jlcpcb.com/capabilities/pcb-capabilities |
| `fab.minSize` | `{"width":3,"height":3}` | published, not a help page | jlcpcb.com/capabilities/pcb-capabilities |
| `fab.minSpacing` | `1.6` | published, not a help page | jlcpcb.com/capabilities/pcb-capabilities |
| `fab.minNpthDiameter` | `0.5` | published, not a help page | jlcpcb.com/capabilities/pcb-capabilities |
| `assembly.economic.singleSize` | `{"minWidth":10,"minHeight":10,"maxWidth":470,"maxHeight":500}` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.economic.panelSize` | `{"minWidth":10,"minHeight":10,"maxWidth":250,"maxHeight":250}` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-faqs |
| `assembly.economic.quantity` | `{"min":2,"max":50}` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.economic.layers` | `[2,4,6]` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.economic.sides` | `1` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.economic.separations` | `["mouse-bite"]` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-faqs |
| `assembly.economic.railsRequired` | `false` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.standard.singleSize` | `{"minWidth":70,"minHeight":70,"maxWidth":460,"maxHeight":500}` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.standard.panelSize` | `{"minWidth":70,"minHeight":70,"maxWidth":250,"maxHeight":250}` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-assembly-faqs |
| `assembly.standard.quantity` | `{"min":2,"max":80000}` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.standard.layers` | `[2,4,6]` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.standard.sides` | `2` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.standard.separations` | `["mouse-bite"]` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `assembly.standard.railsRequired` | `true` | published, not a help page | jlcpcb.com/capabilities/pcb-assembly-capabilities |
| `rails.width` | `5` | verified 2026-09-28 | jlcpcb.com/help/article/specifications-for-adding-process-edges-and-positioning-holes |
| `rails.toolingHoleDiameter` | `2` | verified 2026-09-28 | jlcpcb.com/help/article/specifications-for-adding-process-edges-and-positioning-holes |
| `rails.toolingHoleCornerOffset` | `5` | design choice | — |
| `rails.fiducialCopperDiameter` | `1` | verified 2026-09-28 | jlcpcb.com/help/article/specifications-for-adding-process-edges-and-positioning-holes |
| `rails.fiducialMaskDiameter` | `2` | design choice | — |
| `rails.fiducialEdgeDistance` | `3.85` | verified 2026-09-28 | jlcpcb.com/help/article/specifications-for-adding-process-edges-and-positioning-holes |
| `rails.fiducialCornerOffset` | `10` | design choice | — |
| `tabs.width` | `5` | **ESTIMATE** | jlcpcb.com/blog/technical-guidance-mouse-bite-panelization-guide |
| `tabs.pitch` | `50` | **ESTIMATE** | jlcpcb.com/blog/technical-guidance-mouse-bite-panelization-guide |
| `tabs.maxLength` | `8` | design choice | — |
| `tabs.holeDiameter` | `0.6` | **ESTIMATE** | jlcpcb.com/blog/technical-guidance-mouse-bite-panelization-guide |
| `tabs.holePitch` | `1` | **ESTIMATE** | jlcpcb.com/blog/technical-guidance-mouse-bite-panelization-guide |
| `tabs.holeOverlap` | `0.3333` | **ESTIMATE** | jlcpcb.com/blog/technical-guidance-mouse-bite-panelization-guide |
| `tabs.minPerInstance` | `2` | **ESTIMATE** | jlcpcb.com/blog/technical-guidance-mouse-bite-panelization-guide |
| `tabs.copperClearance` | `0.5` | design choice | — |
| `blockedEdges.overhangMargin` | `1` | design choice | — |
| `blockedEdges.keepoutClearance` | `3` | design choice | — |
| `blockedEdges.keepoutEdgeTolerance` | `0.5` | design choice | — |
| `silkDivider.maxDesigns` | `10` | verified 2026-09-28 | jlcpcb.com/help/article/pcb-panelization |
| `silkDivider.freeDesigns` | `5` | **ESTIMATE** | jlcpcb.com/help/article/different-design-in-your-pcb-files |
| `silkDivider.lineWidth` | `0.15` | design choice | — |
| `silkDivider.minFillRatio` | `0.98` | design choice | — |

Counts: 72 entries: 23 verified on a help page, 19 read from a JLCPCB capabilities page (flagged unverified), 20 estimates, 10 design choices.

Seen on the help pages and not modelled: X-ray inspection, the single-board
assembly surcharge ($0.48, for bulk orders), routing fee for dense slots,
expedite fees, ENIG area, stencil extras.

## 10. Timing

| What | Time | Measured by |
| --- | --- | --- |
| `computeCost`, 60 part lines, Standard, two sides | **25 µs** per call | `packages/panel/test/cost.test.ts`, 2000 calls |
| `quoteOrder`, 2 designs, 13 scenarios | **11 ms** warm, 53 ms first call | 20 consecutive calls |
| Server view (geometry, checks, cost), 4–6 instances | **5 ms** | `derivedMs` in the view, read in the UI check |
| Server view, first time a routed board is seen | **818 ms** | same; it is that board's own DRC with zone fill, cached by content hash |

The cost model is about 600 times faster than a 60 Hz frame. The UI does not
debounce. The one slow moment is the first view after a board is added or
edited, when its DRC runs once.

## 11. Test results

`npm run build && npm test`, final run on `panelize`:

| Package | Passed | Failed | Skipped | New tests |
| --- | --- | --- | --- | --- |
| engine | 305 | 0 | 0 | 0 |
| fab | 67 | 1 (baseline) | 0 | 0 |
| panel | 214 | 0 | 0 | 214 |
| parts | 41 | 0 | 0 | 0 |
| server | 198 | 2 (baseline) | 2 | 51 |
| ui | 53 | 0 | 0 | 12 |
| **total** | **878** | **3 (all baseline)** | 2 | **277** |

Where the brief's list of unit tests lives:

| Asked for | File |
| --- | --- |
| format load/save, stale detection | `panel/test/panel.test.ts`, `stale.test.ts`, `server/test/panel-doc.test.ts` |
| op log, undo/redo | `panel/test/ops.test.ts` |
| constraint detection | `panel/test/check.test.ts` |
| packing, pinned, don't-fit | `panel/test/layout.test.ts` |
| refdes prefixing, coordinate transforms | `panel/test/merge.test.ts` |
| cost model | `panel/test/cost.test.ts` |
| scenario enumeration | `panel/test/scenarios.test.ts` |
| MCP tools, sync, CLI | `server/test/panel-mcp.test.ts`, `panel-sync.test.ts`, `panel-cli.test.ts` |

Scripts:

| Command | Result |
| --- | --- |
| `npx tsx packages/server/scripts/e2e-panel.ts` with Java | **PASS**, exit 0. Both boards routed and DRC-clean, panel check 0 errors, export not waived, 9 gerbers + 2 drill files parsed by tracespace, BOM 34 designators on 7 rows, CPL 34 rows. 11 s. |
| same, without Java (this machine as it is) | **PASS**, exit 0, on unrouted boards. The only errors are each board's own unconnected nets, and only those are waived. 2 s. |
| `npx tsx packages/server/scripts/verify-panel-ui.ts` | **PASS**, exit 0. 17 checks, 14 screenshots. |
| `npx tsx packages/server/scripts/e2e-esp32.ts` with Java, stock check off | **PASS**, exit 0. Unchanged script. It rewrites `docs/images/esp32-breakout.png`; I restored the file. |

## 12. UI screenshots

In `panel-screenshots/`, 1600 × 1000, headless Chromium, on the boards
`e2e-panel.ts` builds (routed).

| File | What it shows |
| --- | --- |
| `01-loaded-empty.png` | The view as it opens: both boards listed with needed 1 and 5, nothing on the plate. |
| `02-one-plus-five.png` | After `+` once for S and five times for M: 1 + 5 on the plate with the live cost. |
| `03-dragging.png` | M3 picked up: drawn where the pointer has it, its position beside it. |
| `04-dropped-pinned-overlap.png` | M3 dropped on S1: pinned, both marked as errors, the overlap listed under Warnings. |
| `05-arranged-around-pinned.png` | After `A`: five instances packed, M3 left where it was pinned. |
| `06-context-menu.png` | Right-click on M3: rotate 90°, duplicate, delete, make bare, unpin. |
| `07-bare-instances.png` | M3 made bare and duplicated as M6: hatched, dashed, labelled BARE. |
| `08-cost-follows-quantity.png` | Needed quantity of M raised to 12: more panels assembled, a new total. |
| `09-scenario-loaded.png` | A scenario selected: its fee lines, its 1 + 3 panel on the plate, live cost equal to its total. |
| `10-scenario-silk-divider.png` | The cheapest scenario: boards in one outline divided by silkscreen lines, no rails, no tabs. |
| `11-exported.png` | Export: the zip is ready and offered as a link. |
| `12-export-refused.png` | Export on a panel with an overlap: refused, with the findings. |
| `13-does-not-fit.png` | 47 instances: Arrange leaves the plate alone and says why. |
| `14-stale-source.png` | A board edited on disk: tagged stale, its instances dotted and labelled STALE. |

What the script asserts beyond the pictures: the download is a zip holding
`combo.GTL`, `.GBL`, `.GKO`, both drill files, `bom.csv`, `cpl.csv`; Delete,
Ctrl+Z and Ctrl+Shift+Z; pan and zoom; an edit made outside the browser appears
without a reload; every pixel is grey and no element has a colour, transition,
animation, shadow or gradient; the board editor still loads.

The every-pixel-is-grey test needs a browser that antialiases text in grey.
Chromium on Linux tints text edges for LCDs by default; the container was
started with `packages/server/scripts/lib/greyscale-fonts.conf` to turn that
off. The script's header has the command.

## 13. Known bugs and limitations

**Cost**

- Totals are estimates wherever a bare-board price or a part price is in them,
  which is always. Use the ranking first and the totals second.
- Parts with no price in the EasyEDA data are left out of the total. On the
  reference board that is the ESP32 module, its most expensive part.
- Not modelled: shipping, tax, coupons, surface finish, colour, thickness, lead
  time, stock.
- Attrition is three classes by joint count. JLCPCB sets it per part.

**Layout**

- The packer is a heuristic. It leaves gaps a person would close.
- Arrange considers tab support only in its last pass. It can return a layout
  with a board held by one tab, or by none. The check reports both, and none is
  an error that stops the export.
- Tab placement does not avoid copper. A mouse-bite hole within 0.5 mm of
  copper or a drill is a warning.
- A blocked edge blocks its whole side.
- Instances turn in 90° steps only.

**Fab output**

- No V-cut panels, no solid rails between rows, no instance labels or panel
  name in silkscreen.
- The merged board is not run through DRC as a whole.
- Promotion leaves the promoted boards' inner layers empty and does not check
  impedance or thickness.
- Panel gerbers have been validated by tracespace's parser and by counting
  primitives against the single-board gerbers. **They have not been opened in
  JLCPCB's viewer or any other Gerber viewer.** Do that before ordering.

**Server and CLI**

- One panel per server, as there is one board per server.
- No undo/redo in the CLI.
- The first view after a board changes takes as long as that board's DRC.

**UI**

- See section 14. Also: no touch support, no keyboard access to the canvas.

## 14. UI questions I could not resolve

Each is something the brief does not settle. In every case I built the simplest
thing and did not add a control.

| Question | What I did meanwhile |
| --- | --- |
| How do boards get onto a panel from the browser? | They do not. An empty panel says how to add them over MCP or the CLI. |
| Should a board be removable from the list? | No control. Count 0 leaves the board listed; `panel_remove_board` removes it. |
| Should panel settings (rails, spacing, separation, layers) be editable in the view? | No. `panel_set_settings`. Loading a scenario does change them. |
| Should a stale board have a "refresh" button? | No. It is tagged and listed; `panel_refresh_boards` clears it. |
| Should a stackup mismatch offer a "promote" button? | No. The message names the fix. |
| Should the ranking objective be selectable? | No. Always total cost. |
| Should Export be able to waive errors? | No. Refused with reasons. |
| Should there be Undo/Redo buttons? | No. Hotkeys only. |
| Open / new / save panel in the view? | No. Header shows name and path. Edits autosave. |
| Should a scenario load on click, or need a confirm? | On click, one undo step. |
| Several panels in one scenario: which goes on the plate? | The first. A warning says so. |
| Should dragging refuse to overlap? | No. The check reports it. |
| Should `+` arrange? | Yes. |
| Light or dark plate? | Light. |
| Should the board editor link to the panel view? | Not added. |

## 15. Suggested next steps

1. **Check the two numbers that decide the ranking** on JLCPCB's quote page by
   hand: the different-designs fee, and a bare-board price or two for panels
   around 80 × 60 mm. Put them in `fee-table.json` with `verified: true`.
2. **Open an exported panel in a Gerber viewer**, then in JLCPCB's. The profile
   layer and the mouse-bite holes are what to look at.
3. Point `origin` at your fork and push `panelize`.
4. Answer section 14. The first four rows are what makes the view usable
   without an agent.
5. Part prices from a source that has them for modules.
6. Tab placement that avoids copper, and per-stretch blocked edges.
7. Install Java 25 and a font on this machine if the three baseline failures
   and the unrouted e2e should go away here.
