# Simulation: SPICE and logic

DRC checks that the fab can make a board. These tools check that the circuit does what it should,
before it is ordered. Both report findings as data, like `run_drc`: `error` and `warn` mean
something to look at, and `info` is context.

## Logic: `simulate_logic`

Follows a digital control path through one or more boards joined by cables. It evaluates every
combination of the *free* signals, which are MCU pins and port-expander registers, each driven 0,
driven 1, or Z (an input, in reset, or still booting). In every state it checks the *invariants*
you declare. When an invariant fails, the finding gives one counterexample state.

```json
{
  "instances": [
    { "name": "ctrl", "board": "ctrl/Ctrl.flamingo", "supplies": { "3V3": "1" } },
    { "name": "bank0", "board": "bank/Bank.flamingo" },
    { "name": "bank1", "board": "bank/Bank.flamingo", "fitted": ["J9"] }
  ],
  "links": [{ "from": "ctrl:J5", "to": ["bank0:J6", "bank1:J6"], "map": "straight" }],
  "free": [{ "net": "ctrl:U1.IO6" }, { "register": "bank*:U2", "pins": "connected" }],
  "invariants": [
    { "name": "one driver", "assert": { "atMostOneLow": "bank*:XL*.1" } },
    { "name": "mux follows", "selectFollows": { "enable": "bank*:XL{i}.1", "mux": "bank*:U4", "channel": "bank*:XL{i}.4" } },
    { "name": "reachable", "eachCanBeLowAlone": "bank*:XL*.1" }
  ]
}
```

- **Selectors.**
  - `inst:NET` names a net.
  - `inst:REF.PIN` names the net on a pin. PIN is a pad number or a symbol pin name.
  - `*` and `?` glob.
  - `{i}` captures a number, so `selectFollows` can pair the enables with the mux channels.
- **Conditions.**
  - `{net, is}` and `{anyLow}` / `{noneLow}`.
  - `{atMostOneLow}`, where X or Z on any of the nets also fails.
  - `{noneFloating}` and `{atMostOneConnected: mux}`.
  - `{all}` / `{any}` / `{not}`.
- **Model.**
  - Parts are recognised from their symbol pin names: MCP23017 (a register with reset), 74HC154,
    74HC4067, 74x125, and single gates 1G86/08/32/00/02.
  - Resistors over 100 ohm are pulls. At 100 ohm or less they are wires, so a series resistor joins
    its two nets.
  - Fitted jumpers short their pins. Ground nets and declared supplies are constants.
  - A floating input reads as X. Driving a net to 0 and 1 at once is contention, and is always
    checked.
  - ICs that aren't modelled are listed in the report, not guessed at.
- **Size.** States are enumerated exhaustively up to `maxStates` (2,000,000), and sampled at random
  past that. The report says which. The KinAura driver select has 531,441 states and runs in
  about 6 s.

## SPICE: `export_spice` and `run_spice`

`export_spice` with a list of nets writes the R, C, L, D and fuse parts on them as a netlist fragment.
- Values come from the board.
- A value it cannot read becomes a `.param` to fill in.
- Ground nets are node 0.

Add sources and an analysis to simulate it.

Templates build complete decks for circuits that recur, read their component values from the
boards, and evaluate the waveforms into findings:

| Template | Measures | Limit |
|---|---|---|
| `i2c` | 30-70 % rise time at every board, VOL and sink current, with pull-ups found on every board (plus plug-in modules) | UM10204: 1000 ns (Sm), 300 ns (Fm), 3 mA |
| `single-wire-uart` | VIL/VIH margins both ways through the TX-to-RX resistor, cable and mux; what-if resistor values | the receivers' thresholds |
| `rc-filter` | corner 3 dB below the DC gain, nominal and with large MLCCs derated; droop on an input dip | the corner the design states |
| `ldo-step` | output dip and overshoot under a load step (behavioural regulator), headroom against dropout | MCU minimum and maximum supply |
| `hot-plug` | inrush peak and overshoot into the bulk capacitors | the rail's maximum |

- **Assumed values.** Everything not on the board, such as cable capacitance, pin capacitance, mux
  on-resistance or source impedance, is a named parameter in `SPICE_PARAMS`, each with its source.
  Override any of them per run with `params`. Every summary lists what came from the board and
  what was assumed.
- **Spread.** Each template runs typical and worst case. On the KinAura boards the UART read-back
  only failed at worst-case mux on-resistance.

`run_spice` takes:
- a template and its config;
- or a `configPath`, a JSON file `{boards: {name: path}, runs: [{template, config, params}]}`;
- or a complete hand-written deck, whose `.measure` results it reports.

It uses a local `ngspice` if there is one, else Docker. The image `flamingo-ngspice:latest` is built
on first use from `packages/server/docker/ngspice`. Set `FLAMINGO_NGSPICE=local|docker` to choose,
and `FLAMINGO_NGSPICE_IMAGE` to use another image. With neither available it reports a skip.

Each run works in `~/.cache/flamingo/spice/run-*` (`FLAMINGO_SPICE_DIR` overrides), and removes it
afterwards.

## Tests and the KinAura boards

`packages/server/test/fixtures/{logic,spice}/kinaura*.json` are the specs for the two KinAura
boards. The boards themselves are not in this repo. Tests load them from `KINAURA_PCB` (default
`~/repos/kinaura/pcb`), and are skipped when the boards are absent. Tests that need ngspice are
skipped when neither ngspice nor Docker is available.
