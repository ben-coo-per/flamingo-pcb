/**
 * Netlist-driven logic simulation: types.
 *
 * A logic run takes one or more board *instances* (the same board file can
 * appear twice, e.g. two identical driver banks with different jumpers),
 * joins them with *links* (cables between headers), and evaluates every
 * combination of a set of *free* signals: MCU pins and port-expander
 * registers, each over 0 / 1 / Z. Every state is checked against
 * user-declared *invariants*.
 *
 * Selectors name nets across instances:
 *   "bank0:SEL_N"        net SEL_N on instance bank0
 *   "bank*:EN*"          glob over instances and net names
 *   "bank*:XL*.1"        pad 1 of every XL* part (pins: pad number or symbol pin name)
 *   "ctrl:U1.IO6"        the net on U1's pin named IO6
 *   "bank*:XL{i}.1"      {i} captures a number, used to pair selectors in selectFollows
 */

import type { Board } from '../types.js';

/** 0 and 1; Z = nothing drives or pulls the net; X = unknown (contention, floating input). */
export type Level = '0' | '1' | 'Z' | 'X';

export interface LogicInstance {
  /** Instance name, used as the selector prefix ("bank0"). */
  name: string;
  board: Board;
  /** 2-pin jumpers fitted on this instance (shorted). Other jumpers are open. */
  fitted?: string[];
  /** Nets this instance itself sources, with their level ({"3V3": "1"}). Ground nets are always 0. */
  supplies?: Record<string, '0' | '1'>;
}

/** A cable: pin n of `from` joined to pin n of every header in `to` ("straight"), or by an explicit map. */
export interface LogicLink {
  from: string; // "ctrl:J5"
  to: string[]; // ["bank0:J6", "bank1:J6"]
  map?: 'straight' | Record<string, string>;
}

export type FreeSignal =
  /** A net forced by something outside the model (an MCU pin). Z means "not driven". */
  | { net: string; levels?: Level[] }
  /**
   * Port-expander pins (MCP23017 GPIO): output 0, output 1, or input (Z).
   * `pins` lists symbol pin names, or 'connected' for every GPIO pin on a net.
   */
  | { register: string; pins: string[] | 'connected'; levels?: Level[] };

export type Cond =
  | { net: string; is: Level | Level[] }
  | { anyLow: string }
  | { noneLow: string }
  /** At most one of the nets is low. X or Z on any of them fails unless allowFloating. */
  | { atMostOneLow: string; allowFloating?: boolean }
  | { noneFloating: string }
  /** At most one analog mux (selector over parts) connects its common pin; unknown counts as connected. */
  | { atMostOneConnected: string }
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond };

export type Invariant = { name: string; level?: 'error' | 'warn' } & (
  | { assert: Cond; when?: Cond }
  /**
   * Per instance of `mux`: when exactly one `enable` net (with index {i}) is
   * low, the mux connects its common pin to that index's `channel` net.
   */
  | { selectFollows: { enable: string; mux: string; channel: string } }
  /** Each matched net can be the only low one in some state (every driver is reachable). */
  | { eachCanBeLowAlone: string }
);

export interface LogicSpec {
  instances: LogicInstance[];
  links?: LogicLink[];
  free: FreeSignal[];
  invariants: Invariant[];
  /** Add the built-in "no net is driven high and low at once" invariant (default true). */
  checkContention?: boolean;
}

export interface InvariantResult {
  name: string;
  level: 'error' | 'warn';
  pass: boolean;
  /** States in which the invariant failed (or, for eachCanBeLowAlone, nets never low alone). */
  failures: number;
  /** One failing state, as "signal=level" pairs, or the unreachable nets. */
  counterexample?: string;
  detail?: string;
}

export interface LogicReport {
  states: number;
  /** True when the state space exceeded maxStates and was sampled at random. */
  sampled: boolean;
  totalStates: number;
  results: InvariantResult[];
  /** Parts recognised and modelled, as "inst:REF kind". */
  modelled: string[];
  /** ICs that were not modelled (their outputs float in the simulation). */
  unmodelled: string[];
}
