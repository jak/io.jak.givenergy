'use strict';

/**
 * Parses the Schedules page's save request into a `DesiredSchedule`. Shapes and types are checked
 * here; times, overlaps and model limits are checked by `applySchedule` before it writes.
 */

import type { DesiredSchedule, PauseMode, SlotWindow } from './schedule.ts';

const PAUSE_MODES: readonly PauseMode[] = ['off', 'charge', 'discharge', 'both'];
const MAX_ROWS = 20;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(what: string): never {
  throw new TypeError(`Invalid schedule: ${what}`);
}

function str(o: Obj, key: string, where: string): string {
  if (typeof o[key] !== 'string') fail(`${where}.${key} must be a string`);
  return o[key] as string;
}

function slotRows(value: unknown, where: string): (SlotWindow & { slot?: number })[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS) fail(`${where} must be a list of up to ${MAX_ROWS} slots`);
  return value.map((row, i) => {
    const at = `${where}[${i}]`;
    if (!isObj(row)) fail(`${at} must be an object`);
    const out: SlotWindow & { slot?: number } = { start: str(row, 'start', at), end: str(row, 'end', at) };
    if (row.slot !== undefined) {
      if (!Number.isInteger(row.slot)) fail(`${at}.slot must be a whole number`);
      out.slot = row.slot as number;
    }
    if (row.target !== undefined) {
      if (typeof row.target !== 'number' || !Number.isFinite(row.target)) fail(`${at}.target must be a number`);
      out.target = row.target;
    }
    // Keep `slot` first, as the rest of the app writes it
    return out.slot !== undefined ? { slot: out.slot, ...out } : out;
  });
}

export function parseDesiredSchedule(body: unknown): DesiredSchedule {
  if (!isObj(body)) fail('expected a schedule object');
  const desired: DesiredSchedule = { buy: slotRows(body.buy, 'buy'), sell: slotRows(body.sell, 'sell'), pause: null };

  if (body.pause !== undefined && body.pause !== null) {
    const p = body.pause;
    if (!isObj(p) || !PAUSE_MODES.includes(p.mode as PauseMode)) fail(`pause.mode must be one of ${PAUSE_MODES.join(', ')}`);
    desired.pause = { mode: p.mode as PauseMode };
    if (p.start !== undefined || p.end !== undefined) {
      desired.pause.start = str(p, 'start', 'pause');
      desired.pause.end = str(p, 'end', 'pause');
    }
  }
  if (body.ecoMode !== undefined) {
    if (typeof body.ecoMode !== 'boolean') fail('ecoMode must be true or false');
    desired.ecoMode = body.ecoMode;
  }
  if (body.chargeTarget !== undefined) {
    if (typeof body.chargeTarget !== 'number' || !Number.isFinite(body.chargeTarget)) fail('chargeTarget must be a number');
    desired.chargeTarget = body.chargeTarget;
  }
  return desired;
}
