/**
 * ERC against real boards: the two KinAura boards as committed in their own
 * repo at fa82a27 (30 Sep 2026), the revision the prototype checks ran on.
 * They are read from that commit with `git show`, so later fixes to the boards
 * do not move the expectations, and the board files are never copied into
 * this (public) repo. Skipped where the KinAura checkout or the parts cache
 * is missing; set KINAURA_PCB to point at another checkout.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseBoard, runErc, type CheckFinding } from '@flamingo/engine';
import { cacheDir, symbolPinsFromCache } from '@flamingo/parts';
import { boardPinLookup } from '../src/checks.js';

const REPO = process.env.KINAURA_PCB ?? join(homedir(), 'repos', 'kinaura', 'pcb');
const REV = 'fa82a27';

function boardAt(path: string): string | null {
  try {
    return execFileSync('git', ['-C', REPO, 'show', `${REV}:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
}

const bank = existsSync(REPO) ? boardAt('driver-bank/DriverBank.flamingo') : null;
const sc = existsSync(REPO) ? boardAt('scale-controller-flamingo/ScaleController.flamingo') : null;
const cached = existsSync(join(cacheDir(), 'C2290.json')) && existsSync(join(cacheDir(), 'C506653.json'));
const why = !bank || !sc ? `no KinAura pcb checkout at ${REPO} with ${REV}` : !cached ? `parts cache ${cacheDir()} lacks the boards' parts` : '';

async function erc(json: string): Promise<CheckFinding[]> {
  const board = parseBoard(json);
  return runErc(board, { pins: await boardPinLookup(board, symbolPinsFromCache) });
}

const notInfo = (fs: CheckFinding[]) =>
  fs
    .filter((f) => f.level !== 'info')
    .map((f) => `${f.level} ${f.rule} ${f.items[0]}`)
    .sort();

describe.skipIf(why !== '')(`KinAura boards at pcb ${REV}${why ? ` (skipped: ${why})` : ''}`, () => {
  it('DriverBank: D1 reversed, BANK_SEL floats with the ribbon out, nothing else', async () => {
    const f = await erc(bank!);
    expect(notInfo(f)).toEqual(['error polarity D1', 'warn floating-input U5.1']);
    expect(f.find((x) => x.rule === 'polarity')!.message).toMatch(/anode pad 1 is on ground \(GND\).*LED_A/);
  });

  it('ScaleController: D3 and D4 reversed, ESP32 3V3 decoupling at 20 mm, USBLC6 VBUS without a capacitor', async () => {
    const f = await erc(sc!);
    expect(notInfo(f)).toEqual(['error polarity D3', 'error polarity D4', 'warn decoupling U1.2', 'warn decoupling U3.5']);
    expect(f.find((x) => x.items[0] === 'U1.2')!.message).toMatch(/C6 is 20\.\d mm/);
  });

  it('confirms the prototype\'s passes as info: ESP32 EN delay 10 ms, IO0 pulled up', async () => {
    const f = await erc(sc!);
    expect(f.some((x) => x.rule === 'esp32' && /EN reset delay .*= 10ms/.test(x.message))).toBe(true);
    expect(f.some((x) => x.rule === 'esp32' && /IO0 on .*download mode/.test(x.message) && x.level === 'info')).toBe(true);
  });
});
