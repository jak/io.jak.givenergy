'use strict';

/**
 * Buy / Sell / Pause / Use schedules, as the official GivEnergy app models them.
 *
 * Captured from the official app on a Gen3 Hybrid (2026-11-21, see docs/plans):
 * - Buy   = a charge slot, plus AC charge (HR 96) on.
 * - Sell  = a discharge slot, plus DC discharge (HR 59) on. Eco mode stays on, and it exports.
 * - Pause = battery pause mode with a window (HR 318–320).
 * - Use   = no slot: the default for any time not covered.
 * - Deleting a slot sets its times to 00:00; the enable flag goes off only with the last slot.
 *
 * Flow cards, device settings, force charge/discharge and the Schedules page all go through here.
 */

import type { Inverter } from './types';

type Lib = typeof import('givenergy-modbus', { with: { 'resolution-mode': 'import' } });
type Capabilities = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).Capabilities;
type TimeSlotConfig = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).TimeSlotConfig;
type BatteryPause = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).BatteryPause;
type Layout = InstanceType<Lib['SinglePhaseInverter']>['layout'] | InstanceType<Lib['ThreePhaseInverter']>['layout'];

export type PauseMode = 'off' | 'charge' | 'discharge' | 'both';

/** The inverter surface this module uses; `scheduleInverter()` adapts a real one. */
export interface ScheduleInverter {
  layout: Layout;
  capabilities: Capabilities;
  getData(): {
    schedules: { charge: TimeSlotConfig[]; discharge: TimeSlotConfig[]; batteryPause?: BatteryPause };
    settings: {
      acCharge?: boolean; dcDischarge?: boolean; acChargeUpperLimit?: number; batteryReserve?: number; ecoMode?: boolean;
    };
  };
  setChargeSlot(slot: number, config: { start: string; end: string; targetStateOfCharge?: number }): Promise<void>;
  setDischargeSlot(slot: number, config: { start: string; end: string; targetStateOfCharge?: number }): Promise<void>;
  setSetting(key: 'acCharge' | 'dcDischarge' | 'ecoMode', value: boolean): Promise<void>;
  setSetting(key: 'acChargeUpperLimit', value: number): Promise<void>;
  setBatteryPause?(pause: { mode: PauseMode; start?: string; end?: string }): Promise<void>;
}

/**
 * Adapt a connected inverter. The library's `setSetting` is typed per layout; the keys used here
 * exist on both layouts except `ecoMode` and the pause, which are only called on single-phase.
 */
export function scheduleInverter(inverter: Inverter): ScheduleInverter {
  return inverter as unknown as ScheduleInverter;
}

export interface ScheduleSupport {
  buySlots: number;
  sellSlots: number;
  perSlotTargets: boolean;
  /** `window`: start/end + mode; `mode`: mode only (Gen1, AC); `none`: three-phase. */
  pause: 'window' | 'mode' | 'none';
}

export function scheduleSupport(capabilities: Capabilities, layout: Layout): ScheduleSupport {
  const slots = capabilities.tenSlots ? 10 : 2;
  let pause: ScheduleSupport['pause'] = 'none';
  if (layout === 'single_phase' && capabilities.pauseMode) pause = capabilities.pauseWindow ? 'window' : 'mode';
  return {
    buySlots: slots, sellSlots: slots, perSlotTargets: capabilities.perSlotTargets, pause,
  };
}

export interface SlotWindow {
  start: string;
  end: string;
  /** Buy: charge up to %. Sell: stop discharging at %. Only with per-slot targets. */
  target?: number;
}

export interface NumberedSlot extends SlotWindow {
  slot: number;
}

export interface PauseWindow {
  mode: PauseMode;
  start?: string;
  end?: string;
}

const EMPTY = '00:00';
const isEmpty = (s: { start: string; end: string }) => s.start === EMPTY && s.end === EMPTY;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function notSupported(what: string): Error {
  return new Error(`${what} is not supported on this inverter`);
}

function checkWindow(w: { start: string; end: string }) {
  for (const t of [w.start, w.end]) {
    if (!TIME.test(t)) throw new RangeError(`Times must be HH:MM, got "${t}"`);
  }
  if (w.start === w.end) throw new RangeError('A slot\'s start and end must be different');
}

// --- single slots (flow cards, force charge/discharge) ---

async function setFlag(inv: ScheduleInverter, key: 'acCharge' | 'dcDischarge', on: boolean) {
  if (inv.getData().settings[key] !== on) await inv.setSetting(key, on);
}

/** Turn the flag off when no slot of the kind has a window left (like the official app). */
async function clearFlagIfLast(inv: ScheduleInverter, kind: 'charge' | 'discharge') {
  const slots = inv.getData().schedules[kind];
  if (slots.every(isEmpty)) await setFlag(inv, kind === 'charge' ? 'acCharge' : 'dcDischarge', false);
}

/**
 * Write a Buy slot and turn AC charge on. Without per-slot targets, a target goes to the global
 * AC charge upper limit, which applies to every Buy slot.
 */
export async function setBuySlot(inv: ScheduleInverter, slot: number, { start, end, target }: SlotWindow) {
  checkWindow({ start, end });
  const perSlot = inv.capabilities.perSlotTargets;
  await inv.setChargeSlot(slot, perSlot && target !== undefined ? { start, end, targetStateOfCharge: target } : { start, end });
  if (!perSlot && target !== undefined) await inv.setSetting('acChargeUpperLimit', target);
  await setFlag(inv, 'acCharge', true);
}

export async function clearBuySlot(inv: ScheduleInverter, slot: number) {
  await inv.setChargeSlot(slot, { start: EMPTY, end: EMPTY });
  await clearFlagIfLast(inv, 'charge');
}

/** Write a Sell slot and turn DC discharge on. Eco mode is left as it is (the app does the same). */
export async function setSellSlot(inv: ScheduleInverter, slot: number, { start, end, target }: SlotWindow) {
  checkWindow({ start, end });
  if (target !== undefined && !inv.capabilities.perSlotTargets) throw notSupported('A per-slot discharge target');
  await inv.setDischargeSlot(slot, target !== undefined ? { start, end, targetStateOfCharge: target } : { start, end });
  await setFlag(inv, 'dcDischarge', true);
}

export async function clearSellSlot(inv: ScheduleInverter, slot: number) {
  await inv.setDischargeSlot(slot, { start: EMPTY, end: EMPTY });
  await clearFlagIfLast(inv, 'discharge');
}

function pauseApi(inv: ScheduleInverter) {
  if (inv.layout !== 'single_phase' || !inv.capabilities.pauseMode || !inv.setBatteryPause) throw notSupported('Battery pause');
  return inv.setBatteryPause.bind(inv);
}

export async function setPause(inv: ScheduleInverter, pause: PauseWindow) {
  const write = pauseApi(inv);
  if (pause.start !== undefined || pause.end !== undefined) {
    if (!inv.capabilities.pauseWindow) throw notSupported('A battery pause window');
    checkWindow({ start: pause.start ?? '', end: pause.end ?? '' });
  }
  await write(pause);
}

export async function clearPause(inv: ScheduleInverter) {
  const write = pauseApi(inv);
  await write(inv.capabilities.pauseWindow ? { mode: 'off', start: EMPTY, end: EMPTY } : { mode: 'off' });
}

// --- whole schedule (Schedules page) ---

export interface ScheduleView {
  support: ScheduleSupport;
  buy: NumberedSlot[];
  sell: NumberedSlot[];
  pause: PauseWindow | null;
  ecoMode?: boolean;
  /** Global AC charge upper limit; only reported without per-slot targets. */
  chargeTarget?: number;
  batteryReserve?: number;
}

function toRow(s: TimeSlotConfig, perSlot: boolean): NumberedSlot {
  const row: NumberedSlot = { slot: s.slot, start: s.start, end: s.end };
  if (perSlot && s.targetStateOfCharge !== undefined) row.target = s.targetStateOfCharge;
  return row;
}

export function readSchedule(inv: ScheduleInverter): ScheduleView {
  const support = scheduleSupport(inv.capabilities, inv.layout);
  const { schedules, settings } = inv.getData();
  const rows = (list: TimeSlotConfig[]) => list.filter((s) => !isEmpty(s)).map((s) => toRow(s, support.perSlotTargets));
  const p = schedules.batteryPause;
  let pause: PauseWindow | null = null;
  if (support.pause !== 'none' && p && p.mode !== 'off' && p.mode !== 'unknown') {
    pause = { mode: p.mode };
    if (support.pause === 'window' && p.start !== undefined && p.end !== undefined) Object.assign(pause, { start: p.start, end: p.end });
  }
  return {
    support,
    buy: rows(schedules.charge),
    sell: rows(schedules.discharge),
    pause,
    ecoMode: settings.ecoMode,
    chargeTarget: support.perSlotTargets ? undefined : settings.acChargeUpperLimit,
    batteryReserve: settings.batteryReserve,
  };
}

/** Minutes covered by a window, as [from, to) ranges; a window past midnight wraps. */
function ranges(w: { start: string; end: string }): [number, number][] {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const a = m(w.start);
  const b = m(w.end);
  return a < b ? [[a, b]] : [[a, 1440], [0, b]];
}

export interface ScheduleRow {
  type: 'buy' | 'sell' | 'pause';
  start: string;
  end: string;
}

/** Check times and that no two windows overlap (touching is fine: 17:00–17:30 then 17:30–18:00). */
export function validateRows(rows: ScheduleRow[]) {
  rows.forEach(checkWindow);
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const overlap = ranges(rows[i]).some(([a, b]) => ranges(rows[j]).some(([c, d]) => a < d && c < b));
      if (overlap) {
        throw new RangeError(`${rows[i].start}–${rows[i].end} and ${rows[j].start}–${rows[j].end} overlap`);
      }
    }
  }
}

export interface DesiredSchedule {
  /** Rows keep their `slot` when they have one; new rows take the lowest free slots. */
  buy: (SlotWindow & { slot?: number })[];
  sell: (SlotWindow & { slot?: number })[];
  pause: PauseWindow | null;
  ecoMode?: boolean;
  chargeTarget?: number;
}

function assignSlots(rows: DesiredSchedule['buy'], count: number, label: string): Map<number, SlotWindow> {
  if (rows.length > count) throw new RangeError(`This inverter has ${count} ${label} slots, got ${rows.length}`);
  const out = new Map<number, SlotWindow>();
  for (const r of rows) {
    if (r.slot === undefined) continue;
    if (r.slot < 1 || r.slot > count || out.has(r.slot)) throw new RangeError(`Invalid ${label} slot ${r.slot}`);
    out.set(r.slot, r);
  }
  const fresh = rows.filter((r) => r.slot === undefined).sort((a, b) => a.start.localeCompare(b.start));
  let next = 1;
  for (const r of fresh) {
    while (out.has(next)) next++;
    out.set(next, r);
  }
  return out;
}

const sameSlot = (cur: TimeSlotConfig, want: SlotWindow | undefined, perSlot: boolean) => {
  if (!want) return isEmpty(cur);
  if (cur.start !== want.start || cur.end !== want.end) return false;
  return !perSlot || want.target === undefined || cur.targetStateOfCharge === want.target;
};

/**
 * Make the inverter's schedule match `desired`, writing only what changed: eco mode and the global
 * target, then Buy slots, Sell slots, the pause, and the AC charge / DC discharge flags last.
 * Everything is validated before the first write.
 */
export async function applySchedule(inv: ScheduleInverter, desired: DesiredSchedule) {
  const support = scheduleSupport(inv.capabilities, inv.layout);

  // Validate everything first, so a bad entry writes nothing.
  validateRows([
    ...desired.buy.map((r) => ({ ...r, type: 'buy' as const })),
    ...desired.sell.map((r) => ({ ...r, type: 'sell' as const })),
    ...(desired.pause?.start !== undefined && desired.pause.end !== undefined
      ? [{ type: 'pause' as const, start: desired.pause.start, end: desired.pause.end }] : []),
  ]);
  if (!support.perSlotTargets && [...desired.buy, ...desired.sell].some((r) => r.target !== undefined)) {
    throw notSupported('A per-slot target');
  }
  if (desired.chargeTarget !== undefined && support.perSlotTargets) throw notSupported('A global charge target');
  if (desired.pause && support.pause === 'none') throw notSupported('Battery pause');
  if (desired.pause?.start !== undefined && support.pause !== 'window') throw notSupported('A battery pause window');
  if (desired.ecoMode !== undefined && inv.layout !== 'single_phase') throw notSupported('Eco mode');
  const buy = assignSlots(desired.buy, support.buySlots, 'Buy');
  const sell = assignSlots(desired.sell, support.sellSlots, 'Sell');

  const { schedules, settings } = inv.getData();

  if (desired.ecoMode !== undefined && settings.ecoMode !== desired.ecoMode) await inv.setSetting('ecoMode', desired.ecoMode);
  if (desired.chargeTarget !== undefined && settings.acChargeUpperLimit !== desired.chargeTarget) {
    await inv.setSetting('acChargeUpperLimit', desired.chargeTarget);
  }

  const writeKind = async (
    current: TimeSlotConfig[], want: Map<number, SlotWindow>, count: number,
    write: ScheduleInverter['setChargeSlot'],
  ) => {
    for (let n = 1; n <= count; n++) {
      const cur = current.find((s) => s.slot === n);
      const w = want.get(n);
      if (cur && sameSlot(cur, w, support.perSlotTargets)) continue;
      if (!cur && !w) continue;
      if (w) {
        await write(n, w.target !== undefined ? { start: w.start, end: w.end, targetStateOfCharge: w.target } : { start: w.start, end: w.end });
      } else {
        await write(n, { start: EMPTY, end: EMPTY });
      }
    }
  };
  await writeKind(schedules.charge, buy, support.buySlots, inv.setChargeSlot.bind(inv));
  await writeKind(schedules.discharge, sell, support.sellSlots, inv.setDischargeSlot.bind(inv));

  if (support.pause !== 'none') {
    const cur = readSchedule(inv).pause;
    const want = desired.pause;
    const same = JSON.stringify(cur) === JSON.stringify(want && { mode: want.mode, ...(want.start !== undefined ? { start: want.start, end: want.end } : {}) });
    if (!same) {
      if (want && want.mode !== 'off') await setPause(inv, want);
      else if (cur) await clearPause(inv);
    }
  }

  await setFlag(inv, 'acCharge', buy.size > 0);
  await setFlag(inv, 'dcDischarge', sell.size > 0);
}
