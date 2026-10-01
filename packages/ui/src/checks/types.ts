/**
 * Flamingo UI - the checks API, as the editor sees it.
 *
 * Shapes follow docs/superpowers/specs/2026-10-01-checks-ui-design.md. They
 * are declared here rather than imported from the server so the UI bundle
 * never pulls server code; the engine owns CheckFinding / CheckWaiver.
 */

import type { CheckFinding, CheckLevel, CheckWaiver } from '@flamingo/engine';

export type { CheckFinding, CheckLevel, CheckWaiver };

/** One registered board check (GET /api/checks). */
export interface CheckInfo {
  name: string;
  description: string;
  /** Needs the network (the JLCPCB stock check): opt-in, never run by default. */
  network?: boolean;
}

export interface WaivedFinding {
  finding: CheckFinding;
  waiver: CheckWaiver;
}

/** GET /api/checks/run?only=<name> */
export interface CheckRunResult {
  sha: string;
  ms: number;
  findings: CheckFinding[];
  waived: WaivedFinding[];
}

export type SimKind = 'logic' | 'spice';

export interface SimSpecInfo {
  path: string;
  name: string;
  kind: SimKind;
  description?: string;
}

export interface SimTemplateInfo {
  name: string;
  description: string;
  /** The config keys the template reads, as one line of help. */
  config?: string;
}

/** GET /api/sim/specs */
export interface SimSpecsResponse {
  specs: SimSpecInfo[];
  templates: SimTemplateInfo[];
  spice: { available: boolean; backend?: 'local' | 'docker'; reason?: string };
}

export interface LogicInvariantResult {
  name: string;
  pass: boolean;
  /** Signal -> value of the first state that broke the invariant. */
  counterexample?: Record<string, string>;
}

/** POST /api/sim/run, by spec kind. */
export type SimRunResult =
  | { kind: 'logic'; states: number; results: LogicInvariantResult[]; findings: CheckFinding[] }
  | { kind: 'spice'; backend: string; runs: { template: string; summary: string[] }[]; findings: CheckFinding[] };

/** The two waiver ops, posted to /api/op (the engine's Op union gains them server-side). */
export type WaiverOp =
  | { op: 'addCheckWaiver'; waiver: CheckWaiver }
  | { op: 'removeCheckWaiver'; index: number };

export type Paper = 'a4' | 'letter';
