/**
 * SPICE templates: the circuits worth simulating that recur from board to
 * board. Each takes the boards involved (by name), a config naming the nets,
 * and parameter overrides; it reads component values from the boards, takes
 * everything else from SPICE_PARAMS, and returns the netlists to run plus an
 * `evaluate` that turns their waveforms into findings with limits and sources.
 *
 * Every template simulates a spread (typical and worst case), not one point,
 * and the ones that can fail report a what-if fix alongside the failure.
 */

import type { Board } from '../types.js';
import type { CheckFinding, CheckLevel } from '../checks/types.js';
import { formatSi } from '../values.js';
import { SpiceExtractError, between, capsOn, one, parallelR, requireNet, totalC, type CapOnNet, type Sourced } from './extract.js';
import { pwl, ribbon, spiceNum as n, uartBits, wrapNetlist } from './netlist.js';
import { SPICE_PARAMS, p, paramSource, type SpiceParamOverrides } from './params.js';
import type { Wave } from './waves.js';

export interface SpiceSim {
  name: string;
  netlist: string;
}

export interface SpiceCircuit {
  template: string;
  title: string;
  sims: SpiceSim[];
  /** Values taken from the boards: [what, value and source]. */
  inputs: [string, string][];
  /** Values assumed: key, value, source. */
  assumptions: { key: string; value: number; source: string }[];
  notes: string[];
  evaluate(waves: Record<string, Wave>): { findings: CheckFinding[]; summary: string[] };
}

export interface SpiceTemplate {
  name: string;
  title: string;
  /** What the config must name, for tool descriptions. */
  configHelp: string;
  build(boards: Record<string, Board>, config: unknown, params?: SpiceParamOverrides): SpiceCircuit;
}

const si = (v: number | null, unit: string): string =>
  v === null ? 'never' : Number.isFinite(v) ? formatSi(v, unit === 'ohm' ? ' ohm' : unit) : 'never';

function finding(level: CheckLevel, template: string, message: string, items: string[] = []): CheckFinding {
  return { check: 'spice', rule: template, level, message, items };
}

function boardOf(boards: Record<string, Board>, name: unknown, role: string): Board {
  if (typeof name !== 'string') throw new SpiceExtractError(`config.${role} must name a board`);
  const b = boards[name];
  if (!b) throw new SpiceExtractError(`config.${role}: no board named ${name} (have ${Object.keys(boards).join(', ')})`);
  return b;
}

function str(cfg: Record<string, unknown>, key: string, dflt?: string): string {
  const v = cfg[key] ?? dflt;
  if (typeof v !== 'string' || !v) throw new SpiceExtractError(`config.${key} must be a net name`);
  return v;
}

function assumptions(params: SpiceParamOverrides | undefined, keys: string[]): SpiceCircuit['assumptions'] {
  return keys.map((key) => ({ key, value: p(params, key), source: paramSource(params, key) }));
}

const fmtInputs = (pairs: [string, Sourced | undefined][]): [string, string][] =>
  pairs.map(([what, v]) => [what, v ? v.source : 'none']);

function ribbonPerM(params?: SpiceParamOverrides) {
  return { r: p(params, 'ribbon_r_per_m'), l: p(params, 'ribbon_l_per_m'), c: p(params, 'ribbon_c_per_m') };
}

/** Each capacitor with a small ESR, derated when asked (MLCC at DC bias). */
function capLines(tag: string, node: string, caps: CapOnNet[], derate?: number): string[] {
  return caps.flatMap(({ ref, farads }) => {
    const c = derate && farads >= 10e-6 ? farads * derate : farads;
    return [`C${tag}${ref} ${node} ${tag}${ref}e ${n(c)}`, `R${tag}${ref} ${tag}${ref}e 0 5m`];
  });
}

const SCHOTTKY_MODEL = '.model DSCH D(IS=5e-5 N=1.78 RS=0.02 CJO=200p) ; Schottky (SS34 class): ~0.35 V at 0.1 A, ~0.5 V at 3 A';

// ---------------------------------------------------------------------------
// I2C
// ---------------------------------------------------------------------------

/**
 * config: {
 *   controller: board name, device?: board name (repeated `copies` times down the cable),
 *   copies?: 2, rail?: "3V3", deviceRail?: "3V3", modulePullups?: false,
 *   lines: [{ name: "SDA", controllerNet: "I2C_SDA", connectorNet?: "BUS_SDA", deviceNet?: "SDA" }]
 * }
 */
const i2c: SpiceTemplate = {
  name: 'i2c',
  title: 'I2C rise time and low level over a cable',
  configHelp:
    'controller (board), device (board, optional), copies (default 2), rail (default 3V3), modulePullups (bool: plug-in modules add module_pullup each), lines [{name, controllerNet, connectorNet?, deviceNet?}]',
  build(boards, config, params) {
    const cfg = (config ?? {}) as Record<string, unknown>;
    const ctrl = boardOf(boards, cfg.controller, 'controller');
    const dev = cfg.device ? boardOf(boards, cfg.device, 'device') : undefined;
    const copies = dev ? Number(cfg.copies ?? 2) : 0;
    const rail = str(cfg, 'rail', '3V3');
    const devRail = str(cfg, 'deviceRail', rail);
    const modules = Boolean(cfg.modulePullups);
    const lines = cfg.lines as { name: string; controllerNet: string; connectorNet?: string; deviceNet?: string }[];
    if (!Array.isArray(lines) || lines.length === 0) throw new SpiceExtractError('config.lines must list the I2C lines');
    const vdd = p(params, 'vdd_logic');
    const inputs: [string, Sourced | undefined][] = [];
    const tRel = 1e-6;
    const tDev = 5e-6;
    const sims: SpiceSim[] = [];
    const meta = new Map<string, { line: string; withModules: boolean; rp: number }>();
    const lens = [p(params, 'ribbon_len_a'), p(params, 'ribbon_len_b')];
    for (const ln of lines) {
      requireNet(ctrl, ln.controllerNet);
      const rpu = parallelR(ctrl, ln.controllerNet, rail);
      if (!rpu) throw new SpiceExtractError(`${ctrl.name}: no pull-up from ${ln.controllerNet} to ${rail}`);
      const rser = ln.connectorNet ? one(ctrl, 'R', ln.controllerNet, ln.connectorNet, `${ln.name} series resistor`) : undefined;
      const devPu = dev && ln.deviceNet ? parallelR(dev, ln.deviceNet, devRail) : undefined;
      inputs.push([`${ln.name} pull-up`, rpu], [`${ln.name} series`, rser], [`${ln.name} device-board pull-up`, devPu]);
      const variants: [string, boolean][] = modules ? [['modules', true], ['no_module_pullups', false]] : [['board', false]];
      for (const [variant, withModules] of variants) {
        const name = `i2c_${ln.name.toLowerCase()}_${variant}`;
        const cDev = p(params, 'i2c_devices_per_board') * p(params, 'i2c_cin') + p(params, 'c_board_device');
        const body = [
          `Vdd vdd 0 ${vdd}`,
          `Rpu vdd mcu ${n(rpu.value)}`,
          `Cmcu mcu 0 ${n(p(params, 'mcu_cin') + p(params, 'c_board_ctrl'))}`,
          'Smcu mcu 0 ctlm 0 swm',
          `Vctlm ctlm 0 PWL(0 1 ${tRel} 1 ${tRel + 1e-9} 0)`,
          rser ? `Rser mcu conn ${n(rser.value)}` : 'Rser mcu conn 1m',
        ];
        let prev = 'conn';
        const taps: string[] = [];
        for (let k = 0; k < copies; k++) {
          const node = `b${k}`;
          body.push(...ribbon(String.fromCharCode(97 + k), prev, node, lens[Math.min(k, 1)]!, ribbonPerM(params)));
          body.push(`Cb${k} ${node} 0 ${n(cDev)}`);
          if (withModules) body.push(`Rmod${k} vdd ${node} ${p(params, 'module_pullup')}`);
          if (devPu) body.push(`Rdev${k} vdd ${node} ${n(devPu.value)}`);
          taps.push(node);
          prev = node;
        }
        const far = taps.length ? taps[taps.length - 1]! : 'conn';
        body.push(`Sdev ${far} sdev ctld 0 swd`, 'Vsense sdev 0 0', `Vctld ctld 0 PWL(0 0 ${tDev} 0 ${tDev + 1e-9} 1)`);
        const models = [
          `.model swm SW(VT=0.5 VH=0.1 RON=${p(params, 'i2c_ron')} ROFF=1e10)`,
          `.model swd SW(VT=0.5 VH=0.1 RON=${p(params, 'i2c_ron_device')} ROFF=1e10)`,
        ];
        sims.push({
          name,
          netlist: wrapNetlist({
            title: `I2C ${ln.name}, ${variant}`,
            name,
            body,
            models,
            analysis: 'tran 1n 8u 0 1n',
            vectors: ['v(mcu)', 'v(conn)', ...taps.map((t) => `v(${t})`), 'i(vsense)'],
          }),
        });
        const g = 1 / rpu.value + (withModules ? copies / p(params, 'module_pullup') : 0) + (devPu ? copies / devPu.value : 0);
        meta.set(name, { line: ln.name, withModules, rp: 1 / g });
      }
    }
    const devTaps = Array.from({ length: copies }, (_, k) => `b${k}`);
    const far = devTaps.length ? devTaps[devTaps.length - 1]! : 'conn';
    return {
      template: 'i2c',
      title: `I2C over the cable${dev ? ` to ${copies} x ${dev.name}` : ''}`,
      sims,
      inputs: fmtInputs(inputs),
      assumptions: assumptions(params, [
        'vdd_logic', 'ribbon_len_a', 'ribbon_len_b', 'ribbon_c_per_m', 'ribbon_l_per_m', 'i2c_cin',
        'i2c_devices_per_board', 'c_board_ctrl', 'c_board_device', 'mcu_cin', ...(modules ? ['module_pullup'] : []),
        'i2c_ron', 'i2c_ron_device', 'i2c_tr_sm', 'i2c_tr_fm', 'i2c_isink_max', 'mcu_vil_frac',
      ]),
      notes: ['The far device pulls the line low at 5 us; the controller releases it at 1 us.'],
      evaluate(waves) {
        const findings: CheckFinding[] = [];
        const summary: string[] = [];
        for (const [name, m] of meta) {
          const w = waves[name]!;
          const nodes = ['mcu', ...devTaps];
          const trs = nodes.map((node) => {
            const t30 = w.cross(node, 0.3 * vdd, true, tRel);
            const t70 = w.cross(node, 0.7 * vdd, true, tRel);
            return t30 !== null && t70 !== null && t70 < tDev ? t70 - t30 : Infinity;
          });
          const tr = Math.max(...trs);
          const volMcu = w.at('mcu', 7.5e-6);
          const volDev = w.at(far, 7.5e-6);
          const isink = Math.abs(w.at('i(vsense)', 7.5e-6));
          const vmin = Math.min(...nodes.map((x) => w.min(x, tDev, 8e-6)));
          summary.push(
            `${name}: pull-up ${si(m.rp, 'ohm')}, rise 30-70 % worst ${si(tr, 's')} (${nodes.map((x, i) => `${x} ${si(trs[i]!, 's')}`).join(', ')}); far device pulling low: ${si(volDev, 'V')} there, ${si(volMcu, 'V')} at the controller, sink ${si(isink, 'A')}; lowest point after the fall ${si(vmin, 'V')}`,
          );
          const nominal = m.withModules || !modules;
          const tag = `I2C ${m.line}${nominal ? '' : " without the modules' pull-ups"}`;
          const items = [`net:${m.line}`];
          if (tr > p(params, 'i2c_tr_sm')) {
            findings.push(finding(nominal ? 'error' : 'warn', 'i2c', `${tag}: rise time ${si(tr, 's')} exceeds Standard-mode 1000 ns`, items));
          } else if (tr > p(params, 'i2c_tr_fm')) {
            findings.push(finding(nominal ? 'warn' : 'info', 'i2c', `${tag}: rise time ${si(tr, 's')} exceeds Fast-mode 300 ns; run the bus at 100 kHz, or lower the pull-ups`, items));
          } else if (tr > 0.9 * p(params, 'i2c_tr_fm')) {
            findings.push(finding(nominal ? 'warn' : 'info', 'i2c', `${tag}: rise time ${si(tr, 's')} is within 10 % of Fast-mode 300 ns; 400 kHz has no margin, 100 kHz is safe`, items));
          } else {
            findings.push(finding('info', 'i2c', `${tag}: rise time ${si(tr, 's')} meets Fast-mode 300 ns`, items));
          }
          if (isink > p(params, 'i2c_isink_max') * 1.001) {
            findings.push(finding('error', 'i2c', `${tag}: a device must sink ${si(isink, 'A')} to pull low, more than the 3 mA the I2C spec guarantees`, items));
          }
          const vil = p(params, 'mcu_vil_frac') * vdd;
          if (volMcu > vil) {
            findings.push(finding('error', 'i2c', `${tag}: a low from the far device reaches the controller at ${si(volMcu, 'V')}, above its VIL ${si(vil, 'V')}`, items));
          }
          if (vmin < -0.3) findings.push(finding('warn', 'i2c', `${tag}: the falling edge rings to ${si(vmin, 'V')}, below the -0.3 V absolute maximum`, items));
        }
        return { findings, summary };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Single-wire UART through an analog mux
// ---------------------------------------------------------------------------

const UART_DATA = [0x55, 0x0f];

/**
 * config: {
 *   host: board, txNet, rxNet, lineNet (host side of the cable), device: board,
 *   channelNet (the device pin's net after the mux), copies?: 2, gnd?: "GND",
 *   whatIfTxRx?: [2200]  (TX-to-RX resistor values to try when it fails)
 * }
 */
const uart: SpiceTemplate = {
  name: 'single-wire-uart',
  title: 'Single-wire UART (TX through a resistor onto RX) through a cable and an analog mux',
  configHelp:
    'host (board), txNet, rxNet, lineNet (host side of the cable), device (board), channelNet (device pin after the mux, with its pull-down), copies (default 2), gnd (default GND), whatIfTxRx (ohms to try)',
  build(boards, config, params) {
    const cfg = (config ?? {}) as Record<string, unknown>;
    const host = boardOf(boards, cfg.host, 'host');
    const dev = boardOf(boards, cfg.device, 'device');
    const tx = str(cfg, 'txNet');
    const rx = str(cfg, 'rxNet');
    const line = str(cfg, 'lineNet');
    const chan = str(cfg, 'channelNet');
    const gnd = str(cfg, 'gnd', 'GND');
    const copies = Number(cfg.copies ?? 2);
    const whatIf = (cfg.whatIfTxRx as number[] | undefined) ?? [2200];
    const rTxRx = one(host, 'R', tx, rx, 'TX-to-RX resistor');
    const rSer = one(host, 'R', rx, line, 'series resistor at the connector');
    const rPd = parallelR(dev, chan, gnd);
    const vdd = p(params, 'vdd_logic');
    const bit = 1 / p(params, 'baud');
    const bits = uartBits(UART_DATA, bit, 10e-6);
    const tEnd = bits[bits.length - 1]![0] + 10e-6;
    const centres = bits.slice(1, -1).map(([t, b]) => [t + bit / 2, b] as [number, number]);
    type V = { dir: 'tx' | 'rx'; ron: number; rtr: number; whatIf: boolean; worst: boolean };
    const variants = new Map<string, V>();
    for (const [tag, ron, worst] of [
      ['typ', p(params, 'mux_ron_typ'), false],
      ['worst', p(params, 'mux_ron_max'), true],
    ] as const) {
      variants.set(`uart_tx_${tag}`, { dir: 'tx', ron, rtr: rTxRx.value, whatIf: false, worst });
      variants.set(`uart_rx_${tag}`, { dir: 'rx', ron, rtr: rTxRx.value, whatIf: false, worst });
    }
    for (const r of whatIf) {
      if (Math.abs(r - rTxRx.value) < 1e-9 * r) continue; // the board already has it
      variants.set(`uart_tx_worst_${formatSi(r, '')}`, { dir: 'tx', ron: p(params, 'mux_ron_max'), rtr: r, whatIf: true, worst: true });
      variants.set(`uart_rx_worst_${formatSi(r, '')}`, { dir: 'rx', ron: p(params, 'mux_ron_max'), rtr: r, whatIf: true, worst: true });
    }
    const sims: SpiceSim[] = [];
    for (const [name, v] of variants) {
      const body = [
        `Vdd vdd 0 ${vdd}`,
        `Vtx txsrc 0 ${v.dir === 'tx' ? pwl(bits, vdd) : vdd}`,
        `Rtxo txsrc tx ${p(params, 'mcu_rout')}`,
        `Rtxrx tx rx ${n(v.rtr)}`,
        `Crx rx 0 ${n(p(params, 'mcu_cin') + p(params, 'c_board_ctrl'))}`,
        `Rser rx conn ${n(rSer.value)}`,
      ];
      let prev = 'conn';
      for (let k = 0; k < copies; k++) {
        body.push(...ribbon(String.fromCharCode(97 + k), prev, `b${k}`, p(params, k === 0 ? 'ribbon_len_a' : 'ribbon_len_b'), ribbonPerM(params)));
        body.push(`Cb${k} b${k} 0 ${n(p(params, 'mux_c_common') + p(params, 'c_board_device'))}`);
        prev = `b${k}`;
      }
      body.push(
        `* the far board's mux is selected; the others are disabled and only load the line`,
        `Rmux ${prev} ch ${v.ron}`,
        `Cch ch 0 ${n(p(params, 'mux_c_channel') + p(params, 'dev_cin'))}`,
        rPd ? `Rpd ch 0 ${n(rPd.value)}` : '* no pull-down on the channel',
      );
      const vectors = ['v(txsrc)', 'v(rx)', `v(${prev})`, 'v(ch)'];
      if (v.dir === 'rx') {
        body.push(`Vdev dsrc 0 ${pwl(bits, vdd)}`, `Rdev dsrc ch ${p(params, 'dev_rout')}`);
        vectors.push('v(dsrc)');
      }
      sims.push({ name, netlist: wrapNetlist({ title: name, name, body, analysis: `tran 20n ${n(tEnd)} 0 20n`, vectors }) });
    }
    return {
      template: 'single-wire-uart',
      title: `Single-wire UART ${host.name} -> ${copies} x ${dev.name} through the mux`,
      sims,
      inputs: fmtInputs([
        ['TX to RX', rTxRx],
        ['series at connector', rSer],
        ['channel pull-down', rPd],
      ]),
      assumptions: assumptions(params, [
        'vdd_logic', 'baud', 'mcu_rout', 'mcu_cin', 'mcu_vil_frac', 'mcu_vih_frac', 'c_board_ctrl', 'c_board_device',
        'ribbon_len_a', 'ribbon_len_b', 'ribbon_c_per_m', 'mux_ron_typ', 'mux_ron_max', 'mux_c_common', 'mux_c_channel',
        'dev_rout', 'dev_cin', 'dev_vil_frac', 'dev_vih_frac',
      ]),
      notes: [
        `Frames sent: ${UART_DATA.map((b) => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`).join(', ')}, 8N1. The far board is selected.`,
      ],
      evaluate(waves) {
        const findings: CheckFinding[] = [];
        const summary: string[] = [];
        for (const [name, v] of variants) {
          const w = waves[name]!;
          const node = v.dir === 'tx' ? 'ch' : 'rx';
          const vil = p(params, v.dir === 'tx' ? 'dev_vil_frac' : 'mcu_vil_frac') * vdd;
          const vih = p(params, v.dir === 'tx' ? 'dev_vih_frac' : 'mcu_vih_frac') * vdd;
          const who = v.dir === 'tx' ? 'device pin' : 'host RX';
          const lowMax = Math.max(...centres.filter(([, b]) => b === 0).map(([t]) => w.at(node, t)));
          const highMin = Math.min(...centres.filter(([, b]) => b === 1).map(([t]) => w.at(node, t)));
          const delays: number[] = [];
          for (let i = 1; i < bits.length; i++) {
            const [t, b] = bits[i]!;
            if (b === bits[i - 1]![1]) continue;
            const hit = w.cross(node, b === 1 ? vih : vil, b === 1, t);
            delays.push(hit !== null && hit < t + bit ? hit - t : Infinity);
          }
          const worstDelay = Math.max(...delays);
          const label = `${name} (mux Ron ${v.ron} ohm, TX-RX ${si(v.rtr, 'ohm')}${v.whatIf ? ', what-if' : ''})`;
          summary.push(
            `${label}: at ${who} low max ${si(lowMax, 'V')} (VIL ${si(vil, 'V')}), high min ${si(highMin, 'V')} (VIH ${si(vih, 'V')}), ` +
              (Number.isFinite(worstDelay) ? `worst edge delay ${si(worstDelay, 's')} = ${((worstDelay / bit) * 100).toFixed(1)}% of a bit` : 'some edges never cross the threshold'),
          );
          const delayText = Number.isFinite(worstDelay) ? `${Math.round((worstDelay / bit) * 100)}% of a bit` : 'never reached';
          const ok = lowMax < vil && highMin > vih && worstDelay < 0.25 * bit;
          const items = [`net:${tx}`, `net:${rx}`];
          if (v.whatIf) {
            findings.push(
              finding('info', 'single-wire-uart', `what-if: a ${si(v.rtr, 'ohm')} TX-to-RX resistor with worst-case mux Ron ${ok ? 'passes' : 'still fails'}: low ${si(lowMax, 'V')}, high ${si(highMin, 'V')}, edge delay ${delayText}`, items),
            );
            continue;
          }
          const dirText = v.dir === 'rx' ? 'device -> host' : 'host -> device';
          if (!ok) {
            const problems: string[] = [];
            if (lowMax >= vil) problems.push(`low reaches only ${si(lowMax, 'V')}, VIL is ${si(vil, 'V')}`);
            if (highMin <= vih) problems.push(`high reaches only ${si(highMin, 'V')}, VIH is ${si(vih, 'V')}`);
            if (!Number.isFinite(worstDelay)) problems.push('some edges never cross the threshold within a bit');
            else if (worstDelay >= 0.25 * bit) problems.push(`edges take ${delayText}`);
            findings.push(finding(v.worst ? 'warn' : 'error', 'single-wire-uart', `UART ${dirText} with mux Ron ${v.ron} ohm at the ${who}: ${problems.join('; ')}`, items));
          } else if (v.dir === 'rx' && vil - lowMax < 0.1 * vdd) {
            findings.push(finding('warn', 'single-wire-uart', `UART device -> host with mux Ron ${v.ron} ohm: low at the host RX is ${si(lowMax, 'V')}, only ${si(vil - lowMax, 'V')} under VIL`, items));
          } else {
            findings.push(finding('info', 'single-wire-uart', `UART ${dirText} with mux Ron ${v.ron} ohm passes: low ${si(lowMax, 'V')}, high ${si(highMin, 'V')}, edge delay ${delayText}`, items));
          }
        }
        return { findings, summary };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// RC supply filter
// ---------------------------------------------------------------------------

/**
 * config: { board, inputNet: "5V", outputNet: "AVDD", gnd?: "GND", claimHz?: 240 }
 * The series element is the resistor (or resistors) between inputNet and outputNet.
 */
const rcFilter: SpiceTemplate = {
  name: 'rc-filter',
  title: 'RC supply filter: corner frequency and droop',
  configHelp: 'board, inputNet, outputNet, gnd (default GND), claimHz (the corner the design states, optional)',
  build(boards, config, params) {
    const cfg = (config ?? {}) as Record<string, unknown>;
    const b = boardOf(boards, cfg.board, 'board');
    const inNet = str(cfg, 'inputNet');
    const outNet = str(cfg, 'outputNet');
    const gnd = str(cfg, 'gnd', 'GND');
    const claim = cfg.claimHz === undefined ? undefined : Number(cfg.claimHz);
    const rs = parallelR(b, inNet, outNet);
    if (!rs) throw new SpiceExtractError(`${b.name}: no resistor from ${inNet} to ${outNet}`);
    const caps = capsOn(b, outNet, gnd);
    const cTot = totalC(b, outNet, gnd);
    const rl = p(params, 'rc_load_r');
    const il = p(params, 'rc_load_i');
    const fcEst = (1 / rs.value + 1 / rl) / (2 * Math.PI * cTot.value);
    const sims: SpiceSim[] = [];
    const tStep = 1e-3;
    const tLen = p(params, 'burst_len');
    for (const derated of [false, true]) {
      const tag = derated ? 'derated' : 'nominal';
      const derate = derated ? p(params, 'mlcc_derate') : undefined;
      const load = [`Rload out 0 ${rl}`, `Iload out 0 DC ${il}`];
      sims.push({
        name: `rc_ac_${tag}`,
        netlist: wrapNetlist({
          title: `RC filter ${inNet} -> ${outNet}, AC, ${tag}`,
          name: `rc_ac_${tag}`,
          body: ['Vs in 0 DC 5 AC 1', `Rs in out ${n(rs.value)}`, ...capLines('a', 'out', caps, derate), ...load],
          analysis: 'ac dec 50 1 1e6',
          vectors: ['vdb(out)'],
        }),
      });
      const v0 = 5;
      const v1 = v0 - p(params, 'rc_step_v');
      sims.push({
        name: `rc_tran_${tag}`,
        netlist: wrapNetlist({
          title: `RC filter ${inNet} -> ${outNet}, input dip, ${tag}`,
          name: `rc_tran_${tag}`,
          body: [
            `Vs in 0 PWL(0 ${v0} ${tStep} ${v0} ${tStep + 1e-6} ${v1} ${tStep + tLen} ${v1} ${tStep + tLen + 1e-6} ${v0})`,
            `Rs in out ${n(rs.value)}`,
            ...capLines('a', 'out', caps, derate),
            ...load,
          ],
          analysis: 'tran 1u 12m 0 2u',
          vectors: ['v(in)', 'v(out)'],
        }),
      });
    }
    return {
      template: 'rc-filter',
      title: `RC filter ${inNet} -> ${outNet} on ${b.name}`,
      sims,
      inputs: fmtInputs([
        ['series resistance', rs],
        ['capacitance on the output', cTot],
      ]),
      assumptions: assumptions(params, ['rc_load_r', 'rc_load_i', 'rc_step_v', 'burst_len', 'mlcc_derate']),
      notes: [`First-order estimate of the loaded corner: ${si(fcEst, 'Hz')}. The corner is measured 3 dB below the DC gain.`],
      evaluate(waves) {
        const findings: CheckFinding[] = [];
        const summary: string[] = [];
        for (const derated of [false, true]) {
          const tag = derated ? 'derated' : 'nominal';
          const ac = waves[`rc_ac_${tag}`]!;
          const dc = ac.at('vdb(out)', 1);
          const f3 = ac.cross('vdb(out)', dc - 3.0103, false);
          const att = [1e3, 10e3, 100e3].map((f) => [f, ac.at('vdb(out)', f) - dc] as const);
          const tr = waves[`rc_tran_${tag}`]!;
          const vOut0 = tr.at('out', 0.9e-3);
          const droopIn = tr.at('in', 0.9e-3) - tr.min('in', tStep, 12e-3);
          const droopOut = vOut0 - tr.min('out', tStep, 12e-3);
          summary.push(
            `rc_${tag}: -3 dB at ${si(f3, 'Hz')} (estimate ${si(fcEst, 'Hz')}); ${att.map(([f, db]) => `${si(f, 'Hz')} ${db.toFixed(1)} dB`).join(', ')}; a ${si(droopIn, 'V')} input dip moves the output ${si(droopOut, 'V')}`,
          );
          const what = derated ? 'large MLCCs derated for DC bias' : 'nominal capacitance';
          if (!derated && claim !== undefined && f3 !== null && Math.abs(f3 - claim) / claim > 0.2) {
            findings.push(finding('warn', 'rc-filter', `${outNet} filter corner is ${si(f3, 'Hz')}, not the ${claim} Hz the design states`, [`net:${outNet}`]));
          } else {
            findings.push(finding('info', 'rc-filter', `${outNet} filter (${what}): corner ${si(f3, 'Hz')}, ${att[1]![1].toFixed(0)} dB at 10 kHz; a ${si(droopIn, 'V')} input dip moves ${outNet} by ${si(droopOut, 'V')}`, [`net:${outNet}`]));
          }
        }
        return { findings, summary };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// LDO load step
// ---------------------------------------------------------------------------

/**
 * config: { board, inNet: "5V", outNet: "3V3", vout?: 3.3, sourceDiode?: false, gnd?: "GND" }
 * The load step is mcu_i_base -> mcu_i_burst for burst_len.
 */
const ldoStep: SpiceTemplate = {
  name: 'ldo-step',
  title: 'LDO output during a load step (behavioural regulator)',
  configHelp: 'board, inNet, outNet, vout (default from the net name, e.g. 3V3), sourceDiode (bool: a Schottky between the source and inNet), gnd',
  build(boards, config, params) {
    const cfg = (config ?? {}) as Record<string, unknown>;
    const b = boardOf(boards, cfg.board, 'board');
    const inNet = str(cfg, 'inNet');
    const outNet = str(cfg, 'outNet');
    const gnd = str(cfg, 'gnd', 'GND');
    const fromName = /^(\d+)V(\d*)$/i.exec(outNet);
    const vout = cfg.vout !== undefined ? Number(cfg.vout) : fromName ? Number(`${fromName[1]}.${fromName[2] || '0'}`) : NaN;
    if (!Number.isFinite(vout)) throw new SpiceExtractError(`config.vout is needed: cannot read a voltage from net ${outNet}`);
    const diode = Boolean(cfg.sourceDiode);
    const cIn = capsOn(b, inNet, gnd);
    const cOut = capsOn(b, outNet, gnd);
    const cOutTot = totalC(b, outNet, gnd);
    const cInTot = cIn.length ? totalC(b, inNet, gnd) : undefined;
    const t0 = 0.5e-3;
    const t1 = t0 + p(params, 'burst_len');
    const i0 = p(params, 'mcu_i_base');
    const i1 = p(params, 'mcu_i_burst');
    const block = (fc: number, rdo: number): string[] => {
      // PI error amplifier into a transconductance pass device, limited by current
      // limit and by dropout (Vin - Vout)/Rdo. Kp sets crossover at fc; the
      // integrator zero sits at fc/10; a pole at 5 fc stands in for the amplifier.
      const gm = 10;
      const kp = (2 * Math.PI * fc * cOutTot.value) / gm;
      const ki = (kp * 2 * Math.PI * fc) / 10;
      return [
        `Bint 0 int I = ${n(ki)} * (${vout} - V(out))`,
        'Cint int 0 1',
        `Rint int 0 ${n(1e5 / ki)}`,
        `Bea ea0 0 V = ${n(kp)} * (${vout} - V(out)) + V(int)`,
        'Rea ea0 ea 1k',
        `Cea ea 0 ${n(1 / (2 * Math.PI * 1e3 * 5 * fc))}`,
        `Bpass in out I = min(min(${gm} * max(V(ea), 0), ${p(params, 'ldo_ilim')}), max(V(in) - V(out), 0) / ${rdo})`,
        'Rfb out 0 100k',
        `.nodeset v(out)=${vout} v(int)=${n(i0 / gm)} v(ea)=${n(i0 / gm)} v(ea0)=${n(i0 / gm)}`,
      ];
    };
    const variants = new Map<string, { vs: number; rs: number; fc: number; rdo: number }>([
      ['ldo_typ', { vs: p(params, 'v_usb_typ'), rs: p(params, 'r_usb_cable'), fc: p(params, 'ldo_fc_typ'), rdo: p(params, 'ldo_rdo_typ') }],
      ['ldo_worst', { vs: p(params, 'v_usb_min'), rs: p(params, 'r_usb_cable'), fc: p(params, 'ldo_fc_slow'), rdo: p(params, 'ldo_rdo_max') }],
      ['ldo_worst_supply', { vs: p(params, 'v_usb_min'), rs: p(params, 'r_psu'), fc: p(params, 'ldo_fc_slow'), rdo: p(params, 'ldo_rdo_max') }],
    ]);
    const sims: SpiceSim[] = [];
    for (const [name, v] of variants) {
      const body = [
        `Vs src 0 ${v.vs}`,
        `Rs src s1 ${v.rs}`,
        `Ls s1 vsup ${p(params, 'l_usb_cable')}`,
        diode ? 'D1 vsup in DSCH' : 'Rjoin vsup in 1m',
        ...capLines('i', 'in', cIn),
        `Iextra in 0 ${p(params, 'i_input_extra')}`,
        ...block(v.fc, v.rdo),
        ...capLines('o', 'out', cOut),
        `Iload out 0 PWL(0 ${i0} ${t0} ${i0} ${t0 + 1e-6} ${i1} ${t1} ${i1} ${t1 + 1e-6} ${i0})`,
      ];
      sims.push({
        name,
        netlist: wrapNetlist({
          title: name,
          name,
          body,
          models: diode ? [SCHOTTKY_MODEL] : [],
          analysis: 'tran 20n 4m 0 50n',
          vectors: ['v(in)', 'v(out)'],
          options: 'method=gear',
        }),
      });
    }
    return {
      template: 'ldo-step',
      title: `${outNet} regulator during a ${si(i1 - i0, 'A')} load step on ${b.name}`,
      sims,
      inputs: fmtInputs([
        ['input caps', cInTot],
        ['output caps', cOutTot],
      ]),
      assumptions: assumptions(params, [
        'v_usb_typ', 'v_usb_min', 'r_usb_cable', 'l_usb_cable', 'r_psu', 'i_input_extra', 'mcu_i_base', 'mcu_i_burst',
        'burst_len', 'mcu_vdd_min', 'mcu_vdd_max', 'ldo_fc_typ', 'ldo_fc_slow', 'ldo_rdo_typ', 'ldo_rdo_max', 'ldo_ilim',
      ]),
      notes: [
        "Behavioural LDO: error amplifier and a current-limited pass device capped by (Vin - Vout)/Rdo. It reproduces dropout, current limit and a loop of chosen bandwidth, not the part's real compensation.",
        "The load's own decoupling is not included, which makes the dip pessimistic.",
      ],
      evaluate(waves) {
        const findings: CheckFinding[] = [];
        const summary: string[] = [];
        for (const [name, v] of variants) {
          const w = waves[name]!;
          const pre = w.min('out', 0, 0.45e-3);
          const vmax = w.max('out');
          if (Math.abs(pre - vout) > 0.02 || Math.abs(vmax - vout) > 0.3) {
            throw new Error(`${name}: the LDO model did not settle in regulation (before the step ${si(pre, 'V')}, max ${si(vmax, 'V')})`);
          }
          const vmin = w.min('out', t0, 4e-3);
          const vinMin = w.min('in', t0, 4e-3);
          const ins = w.window('in', t0, t1);
          const outs = w.window('out', t0, t1);
          const headroom = Math.min(...ins.map((x, i) => x - outs[i]!));
          const dropoutNeeded = i1 * v.rdo;
          summary.push(
            `${name} (source ${v.vs} V via ${v.rs} ohm, loop ${si(v.fc, 'Hz')}, Rdo ${v.rdo} ohm): ${outNet} dips to ${si(vmin, 'V')}, overshoots to ${si(vmax, 'V')}; input min ${si(vinMin, 'V')}, headroom min ${si(headroom, 'V')} vs ${si(dropoutNeeded, 'V')} dropout at ${si(i1, 'A')}`,
          );
          const items = [`net:${outNet}`];
          if (vmin < p(params, 'mcu_vdd_min')) {
            findings.push(finding('error', 'ldo-step', `${name}: ${outNet} dips to ${si(vmin, 'V')} during the load step, below the ${p(params, 'mcu_vdd_min')} V minimum`, items));
          } else if (vmin < vout * 0.95) {
            findings.push(finding('warn', 'ldo-step', `${name}: ${outNet} dips to ${si(vmin, 'V')} during the load step (more than 5 % low)`, items));
          } else {
            findings.push(finding('info', 'ldo-step', `${name}: ${outNet} holds at ${si(vmin, 'V')} or above during a ${si(i1, 'A')} step; headroom ${si(headroom, 'V')}`, items));
          }
          if (vmax > p(params, 'mcu_vdd_max')) {
            findings.push(finding('error', 'ldo-step', `${name}: ${outNet} overshoots to ${si(vmax, 'V')} when the step ends, above ${p(params, 'mcu_vdd_max')} V`, items));
          }
          if (headroom < dropoutNeeded * 1.2) {
            findings.push(finding('warn', 'ldo-step', `${name}: regulator headroom ${si(headroom, 'V')} is close to its dropout (${si(dropoutNeeded, 'V')} at ${si(i1, 'A')})`, items));
          }
        }
        return { findings, summary };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Hot plug
// ---------------------------------------------------------------------------

/**
 * config: { board, rails: [{ net: "VM", supplyV: 12, maxV: 29, terminalNet?: "VM_RAW" }], gnd?: "GND" }
 * With terminalNet, the fuse (F) between terminalNet and net is in the path.
 */
const hotPlug: SpiceTemplate = {
  name: 'hot-plug',
  title: 'Supply hot-plug: inrush into bulk capacitors, and overshoot',
  configHelp: 'board, rails [{net, supplyV, maxV, terminalNet? (fuse between terminalNet and net)}], gnd',
  build(boards, config, params) {
    const cfg = (config ?? {}) as Record<string, unknown>;
    const b = boardOf(boards, cfg.board, 'board');
    const gnd = str(cfg, 'gnd', 'GND');
    const rails = cfg.rails as { net: string; supplyV: number; maxV: number; terminalNet?: string }[];
    if (!Array.isArray(rails) || rails.length === 0) throw new SpiceExtractError('config.rails must list the rails to hot-plug');
    const tPlug = 10e-6;
    const sims: SpiceSim[] = [];
    const inputs: [string, Sourced | undefined][] = [];
    const meta = new Map<string, { rail: (typeof rails)[number]; caps: CapOnNet[] }>();
    for (const rail of rails) {
      const caps = capsOn(b, rail.net, gnd);
      if (caps.length === 0) throw new SpiceExtractError(`${b.name}: no capacitors on ${rail.net}`);
      let fuse: Sourced | undefined;
      if (rail.terminalNet) {
        const refs = between(b, 'F', rail.terminalNet, rail.net);
        if (refs.length !== 1) throw new SpiceExtractError(`${b.name}: expected one fuse between ${rail.terminalNet} and ${rail.net}, found ${refs.join(', ') || 'none'}`);
        fuse = { value: p(params, 'r_polyfuse'), source: `${refs[0]} (${b.name}), cold resistance assumed` };
      }
      inputs.push([`${rail.net} capacitance`, totalC(b, rail.net, gnd)], [`${rail.net} fuse`, fuse]);
      const name = `hotplug_${rail.net.replace(/\W/g, '_').toLowerCase()}`;
      const body = [
        `Vs src 0 PWL(0 0 ${tPlug} 0 ${tPlug + 100e-9} ${rail.supplyV})`,
        `Rs src s1 ${p(params, 'r_src_plug')}`,
        `Ls s1 term ${p(params, 'l_src_plug')}`,
        'Vsense term fin 0',
        `Rfuse fin rail ${fuse ? fuse.value : 1e-4}`,
        'Rbleed rail 0 1k',
      ];
      for (const { ref, farads } of caps) {
        if (farads >= 10e-6) {
          body.push(`C${ref} rail c${ref}a ${n(farads)}`, `R${ref} c${ref}a c${ref}b ${p(params, 'elko_esr')}`, `L${ref} c${ref}b 0 ${p(params, 'elko_esl')}`);
        } else {
          body.push(`C${ref} rail c${ref}a ${n(farads)}`, `R${ref} c${ref}a 0 10m`);
        }
      }
      sims.push({ name, netlist: wrapNetlist({ title: name, name, body, analysis: 'tran 10n 2m 0 50n', vectors: ['v(rail)', 'i(vsense)'], options: 'method=gear' }) });
      meta.set(name, { rail, caps });
    }
    return {
      template: 'hot-plug',
      title: `Hot plug of ${rails.map((r) => r.net).join(', ')} on ${b.name}`,
      sims,
      inputs: fmtInputs(inputs),
      assumptions: assumptions(params, ['r_src_plug', 'l_src_plug', 'r_polyfuse', 'elko_esr', 'elko_esl']),
      notes: [
        'Capacitors of 10 uF and more are modelled as aluminium electrolytics (ESR + ESL). Contact bounce is not modelled; the supply is already on and steps in 100 ns.',
      ],
      evaluate(waves) {
        const findings: CheckFinding[] = [];
        const summary: string[] = [];
        for (const [name, { rail, caps }] of meta) {
          const w = waves[name]!;
          const ipk = w.max('i(vsense)');
          const vpk = w.max('rail');
          const cTot = caps.reduce((s, c) => s + c.farads, 0);
          summary.push(`${name}: ${caps.length} caps, ${si(cTot, 'F')} on ${rail.net}; hot plug of ${rail.supplyV} V peaks at ${si(ipk, 'A')} and ${si(vpk, 'V')}`);
          const items = [`net:${rail.net}`];
          if (vpk > rail.maxV) {
            findings.push(finding('error', 'hot-plug', `Hot-plugging ${rail.supplyV} V overshoots ${rail.net} to ${si(vpk, 'V')}, above ${rail.maxV} V`, items));
          } else if (vpk > rail.supplyV * 1.25) {
            findings.push(finding('warn', 'hot-plug', `Hot-plugging ${rail.supplyV} V rings ${rail.net} up to ${si(vpk, 'V')}`, items));
          } else {
            findings.push(finding('info', 'hot-plug', `Hot plug on ${rail.net}: ${si(ipk, 'A')} peak inrush, rail peaks at ${si(vpk, 'V')} (limit ${rail.maxV} V)`, items));
          }
        }
        return { findings, summary };
      },
    };
  },
};

export const SPICE_TEMPLATES: Record<string, SpiceTemplate> = {
  i2c,
  'single-wire-uart': uart,
  'rc-filter': rcFilter,
  'ldo-step': ldoStep,
  'hot-plug': hotPlug,
};

export function buildSpiceCircuit(
  template: string,
  boards: Record<string, Board>,
  config: unknown,
  params?: SpiceParamOverrides,
): SpiceCircuit {
  const t = SPICE_TEMPLATES[template];
  if (!t) throw new SpiceExtractError(`unknown SPICE template ${template}; have ${Object.keys(SPICE_TEMPLATES).join(', ')}`);
  for (const k of Object.keys(params ?? {})) {
    if (!(k in SPICE_PARAMS)) throw new SpiceExtractError(`unknown SPICE parameter ${k}`);
  }
  return t.build(boards, config, params);
}

/** A plain-text summary of a circuit: inputs, assumptions, notes, results. */
export function spiceSummary(c: SpiceCircuit, results: string[]): string {
  return [
    `== ${c.template}: ${c.title}`,
    'From the boards:',
    ...c.inputs.map(([w, s]) => `  ${w}: ${s}`),
    'Assumed:',
    ...c.assumptions.map((a) => `  ${a.key} = ${a.value} (${a.source})`),
    ...c.notes.map((x) => `Note: ${x}`),
    'Results:',
    ...results.map((r) => `  ${r}`),
    '',
  ].join('\n');
}
