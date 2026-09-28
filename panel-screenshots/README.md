# Panel view screenshots

Taken by `packages/server/scripts/verify-panel-ui.ts` in headless Chromium
(1600 x 1000), on the boards `e2e-panel.ts` builds.

- `00-start.png` — A new panel: nothing on the plate, and the project's boards on offer under Boards.
- `00b-started.png` — Both boards added from the list: one instance of each on the plate, each in its board's colour.
- `01-loaded-empty.png` — The view as it opens: both boards listed with needed 1 and 5, nothing on the plate yet.
- `02-one-plus-five.png` — After pressing + once for S and five times for M: 1 + 5 on the plate, arranged as they were added, with the live cost.
- `03-dragging.png` — M3 picked up and on its way: drawn where the pointer has it, with its position beside it.
- `04-dropped-pinned-overlap.png` — M3 dropped on S1: pinned (filled corner square, PINNED), both marked with a second outline and ERROR, and the overlap listed under Checks with a chip per board involved.
- `05-arranged-around-pinned.png` — After A: five instances packed, M3 left where it was pinned, and the message saying so.
- `06-context-menu.png` — Right-click on M3: rotate 90°, duplicate, delete, make bare, unpin.
- `07-bare-instances.png` — M3 turned and made bare, then duplicated as M6: bare instances are hatched with a dashed outline and read BARE.
- `08-cost-follows-quantity.png` — Needed quantity of M raised to 12: more panels assembled, a new total, and new scenarios below.
- `09-scenario-loaded.png` — Scenario "Mouse-bite panel" selected: its cost below the list with Boards unfolded, its 1 + 3 panel on the plate, and the live cost equal to its total.
- `10-scenario-silk-divider.png` — The cheapest scenario: boards inside one outline, divided by silkscreen lines (dotted), no rails, no tabs.
- `11-exported.png` — Export fab files: the zip is ready and offered as a download link.
- `12-export-refused.png` — Export on a panel with an overlap: refused, with the findings that stopped it.
- `13-does-not-fit.png` — 44 + 3 instances: Arrange leaves the plate as it is and says why, with the smallest panel that would hold them.
- `14-stale-source.png` — usbc-breakout edited on disk: tagged stale in the board list, its instances dotted and labelled STALE, and listed under Checks.
