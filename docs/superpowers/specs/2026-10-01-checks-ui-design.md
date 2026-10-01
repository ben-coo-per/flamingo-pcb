# Checks UI

1 Oct 2026. A UI for the electrical-checks suite (PR #3): one place in the editor to run every
check, read and act on the findings, run simulations and print the board, plus cable editing
and checking in the panel view.

## Editor: the Checks workspace

The **DRC** and **ERC** sections in the right panel become one **Checks** section. It shows a
summary line (`2 errors · 5 warnings`, or "not run" / "stale since last edit") and an **Open
checks** button (shortcut `K`). These open the workspace: a drawer docked to the right, over the
right panel, about 520 px wide on desktop and full width under 900 px. The canvas stays visible
and interactive beside it. `Esc` closes it.

The drawer has a header (board name, file sha256 prefix, time of last run) and three tabs.

### Findings tab

- **Check chips**, one per registered check (DRC, ERC, ...), each with a checkbox, its
  description as a tooltip, and its own status: idle, running with a spinner, done with counts,
  or failed with the message. Stock is a separate opt-in chip, because it needs the network.
- **Run selected**, which runs the selected checks one at a time (`GET /api/checks/run?only=<name>`),
  so progress shows per check and a slow DRC never hides a fast ERC.
- **Filters:** level toggles (error / warn / info; info off by default), a text filter over
  message, rule and items, and group by **check → rule** (default) or **severity**.
- **Each finding row** shows:
  - a level badge, `check/rule`, the message, and the items as chips;
  - clicking the row centres the canvas on `at` when there is one, or on the first item that
    resolves to a component or pad;
  - hovering a row highlights its marker on the canvas;
  - a row action **Waive…** opens an inline form with a reason field (required) and the items to
    match (prefilled with the finding's items; each chip can be removed). Saving posts the
    `addCheckWaiver` op.
- **Waived** is a collapsed section at the end. It lists each waived finding with its waiver's
  reason and a **Remove waiver** action (`removeCheckWaiver` op).
- **Canvas markers:** every finding with `at` gets a ring, red for error, amber for warn and grey
  for info, using the existing `drcMarkers` mechanism extended with a level. The selected or
  hovered finding's ring is drawn thicker. Markers stay until the next run, or until the drawer's
  **Clear markers** is pressed.
- **Staleness:** after any board op following a run, the header shows "board changed since this
  run" and the summary in the right panel says *stale*.
- **Export gate:** when `export_fab` is refused for ERC or DRC errors, its error toast gets a
  **Show in Checks** link that opens the drawer with those findings.

### Simulation tab

- **Spec files:** a list of the `*.json` files in the board's directory that the server
  recognises as a logic spec or a SPICE config (`GET /api/sim/specs`). Each entry shows its kind,
  file name and `description`.
- **Run** on an entry runs that spec (`POST /api/sim/run`). The results show:
  - for logic, the states explored, then each invariant as pass or fail, with the counterexample
    state shown as a table of signal and value;
  - for SPICE, the backend used (local or docker), each run's summary lines, and its findings.
- **Templates:** the SPICE templates with their descriptions, read-only, plus a link to
  `docs/simulation.md` so a user knows what a config looks like. No in-UI config editor yet.
- When neither ngspice nor Docker is available, the tab says so plainly and disables SPICE runs.
  Logic runs still work.

### Printout tab

- Paper (A4 / Letter), an SVG checkbox, and **Download PDF** (`GET /api/export.print?paper=a4`).
- Short instructions: print at 100 %, measure the bars, and what each page is for.

## Panel view: cables

The panel sidebar gets a **Cables** section:

- **The list of `panel.links`**, each shown as `S:J5 → D:J6 ×2 (straight)`, with remove.
- **Add cable:**
  - pick the from-board and header (headers are components whose refdes starts with J or P, or
    any refdes typed in);
  - pick one or more to-boards and headers;
  - choose a map, straight or a custom pin map (pin to pin text pairs);
  - add optional aliases (`MOTION_EN = M_EN`).
  - Saving posts the panel `addLink` op.
- **Check cables** runs `GET /api/panel/interconnect` and lists the findings with the same row
  component as the editor drawer (badge, rule, message, items). Findings name `link.id` and pins.

## API

All JSON. Errors are `{ ok: false, error }` with a 4xx or 5xx status.

| Method, path | Body / query | Response |
|---|---|---|
| `GET /api/checks` | | `{ ok, checks: [{ name, description, network?: boolean }] }`: the board checks in registry order. `stock` is listed with `network: true` |
| `GET /api/checks/run` | `?only=a,b` (default: every non-network check) | `{ ok, sha, ms, findings: CheckFinding[], waived: { finding, waiver }[] }`: waivers applied with `applyWaivers(board.checkWaivers)` |
| `POST /api/op` | `{ op: 'addCheckWaiver', waiver: CheckWaiver }` | existing op endpoint. Undoable, broadcast over `/ws` |
| `POST /api/op` | `{ op: 'removeCheckWaiver', index: number }` | ditto. Index into `board.checkWaivers` |
| `GET /api/sim/specs` | | `{ ok, specs: [{ path, name, kind: 'logic' \| 'spice', description? }], templates: [{ name, description }], spice: { available: boolean, backend?: 'local' \| 'docker', reason?: string } }` |
| `POST /api/sim/run` | `{ path }` (one from `/api/sim/specs`; paths outside the board directory are refused) | logic: `{ ok, kind: 'logic', states, results: [{ name, pass, counterexample?: Record<string, string> }], findings }`; spice: `{ ok, kind: 'spice', backend, runs: [{ template, summary: string[] }], findings }` |
| `GET /api/export.print` | `?paper=a4\|letter` | `application/pdf`, `content-disposition: attachment; filename="<board>.print.pdf"` |
| `GET /api/panel/interconnect` | | `{ ok, findings: CheckFinding[] }` |
| `POST /api/panel/op` | `{ op: 'addLink', link }` / `{ op: 'removeLink', id }` | the existing panel op route |

`/api/drc` and `/api/erc` stay, for compatibility and the MCP screenshots.

## Engine

- Ops: `{ op: 'addCheckWaiver'; waiver: CheckWaiver }` and `{ op: 'removeCheckWaiver'; index: number }`.
  - `addCheckWaiver` validates a non-empty `rule`, a non-empty trimmed `reason` and string
    `items`.
  - `removeCheckWaiver` validates the index.
  - Both go into the op log, so undo and redo work.
- `drcMarkers` in UI state becomes `checkMarkers: { at: Point; level: CheckLevel; key: string }[]`
  plus `checkMarkerFocus?: string`.

## Testing

- Server: route tests for every endpoint, including the path-traversal refusal on `/api/sim/run`
  and the waived/kept split.
- Engine: op tests for both waiver ops and their undo.
- UI:
  - unit tests for the pure parts: grouping, filtering, the summary text, and staleness;
  - a Playwright run in the Playwright Docker image (see `~/.config/dev-previews/flamingo-pcb.md`)
    that opens the editor on the blinker fixture, runs DRC and ERC, filters, clicks a finding,
    waives one, removes the waiver, and downloads the print PDF;
  - screenshots of the drawer, which the author reviews.
- The panel's cable section has unit tests and a Playwright pass.
