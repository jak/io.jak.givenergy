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
      acCharge?: boolean; dcDischarge?: boolean; acChargeUpperLimit?: number; acChargeUpperLimitEnabled?: boolean;
      batteryReserve?: number; ecoMode?: boolean;
    };
  };
  setChargeSlot(slot: number, config: { start: string; end: string; targetStateOfCharge?: number }): Promise<void>;
  setDischargeSlot(slot: number, config: { start: string; end: string; targetStateOfCharge?: number }): Promise<void>;
  setSetting(key: 'acCharge' | 'dcDischarge' | 'ecoMode' | 'acChargeUpperLimitEnabled', value: boolean): Promise<void>;
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
  /** Slots with no target register even with per-slot targets: three-phase slots 1/2. */
  noTargetSlots: number[];
  /** `window`: start/end + mode; `mode`: mode only (Gen1, AC); `none`: three-phase. */
  pause: 'window' | 'mode' | 'none';
}

export function scheduleSupport(capabilities: Capabilities, layout: Layout): ScheduleSupport {
  const slots = capabilities.tenSlots ? 10 : 2;
  let pause: ScheduleSupport['pause'] = 'none';
  if (layout === 'single_phase' && capabilities.pauseMode) pause = capabilities.pauseWindow ? 'window' : 'mode';
  return {
    buySlots: slots,
    sellSlots: slots,
    perSlotTargets: capabilities.perSlotTargets,
    noTargetSlots: layout === 'three_phase' && capabilities.perSlotTargets ? [1, 2] : [],
    pause,
  };
}

export function slotHasTarget(support: ScheduleSupport, slot: number): boolean {
  return support.perSlotTargets && !support.noTargetSlots.includes(slot);
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

function checkTarget(target: number | undefined) {
  if (target !== undefined && !(Number.isInteger(target) && target >= 4 && target <= 100)) {
    throw new RangeError(`Targets must be whole numbers between 4 and 100, got ${target}`);
  }
}

/** A Buy slot that was empty gets a 100% target, not whatever an old slot left in its register. */
const NEW_BUY_TARGET = 100;
/** A Sell slot that was empty gets the lowest stop-at %, so the battery reserve is what stops it. */
export const NEW_SELL_TARGET = 4;

/**
 * HR 20 "Enable AC Charge Upper % Limit", on single-phase only: it gates HR 116 there, but it's not
 * known whether it gates three-phase's HR 1111, so three-phase is treated as not reporting it.
 */
export function chargeLimitEnabled(inv: Pick<ScheduleInverter, 'layout' | 'getData'>): boolean | undefined {
  return inv.layout === 'single_phase' ? inv.getData().settings.acChargeUpperLimitEnabled : undefined;
}

/**
 * The global AC charge target (two-slot firmware): HR 116 only applies while HR 20 "Enable AC
 * Charge Upper % Limit" is on, so a target under 100% turns it on and 100% turns it off.
 * HR 20 is left alone on models that don't report it, and on three-phase (see chargeLimitEnabled).
 */
export async function setGlobalChargeTarget(inv: ScheduleInverter, target: number) {
  checkTarget(target);
  // Written even when the last read matches: another controller may have changed it since
  await inv.setSetting('acChargeUpperLimit', target);
  if (chargeLimitEnabled(inv) !== undefined) await inv.setSetting('acChargeUpperLimitEnabled', target < 100);
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

/**
 * Turn the flag off when no slot of the kind has a window left (like the official app). Only when
 * every slot has been read: right after connecting, unread slots are missing from the snapshot.
 */
async function clearFlagIfLast(inv: ScheduleInverter, kind: 'charge' | 'discharge') {
  const support = scheduleSupport(inv.capabilities, inv.layout);
  const slots = inv.getData().schedules[kind];
  const count = kind === 'charge' ? support.buySlots : support.sellSlots;
  if (slots.length === count && slots.every(isEmpty)) await setFlag(inv, kind === 'charge' ? 'acCharge' : 'dcDischarge', false);
}

/** A slot as last read; one not read yet (just after connecting) might hold a window, so wait for it. */
function readSlot(inv: ScheduleInverter, kind: 'charge' | 'discharge', slot: number): TimeSlotConfig {
  const current = inv.getData().schedules[kind].find((s) => s.slot === slot);
  if (!current) throw new Error('Inverter data is still loading; try again in a minute');
  return current;
}

/**
 * Give an empty slot a window and the default target for a new slot. The target goes first, on its
 * own: if the window write then fails, a retry still finds the slot empty and writes the default
 * again, where a slot with a window would keep whatever target it has.
 */
async function writeNewSlot(write: ScheduleInverter['setChargeSlot'], slot: number, w: { start: string; end: string }, target: number) {
  await write(slot, { start: EMPTY, end: EMPTY, targetStateOfCharge: target });
  await write(slot, { start: w.start, end: w.end });
}

/** Check a single-slot target before writing anything. */
function slotTarget(inv: ScheduleInverter, kind: 'Buy' | 'Sell', slot: number, target: number | undefined) {
  checkTarget(target);
  const support = scheduleSupport(inv.capabilities, inv.layout);
  if (target !== undefined && support.perSlotTargets && !slotHasTarget(support, slot)) {
    throw notSupported(`${kind} slot ${slot} has no target on this inverter; a per-slot target`);
  }
  return support;
}

/**
 * Write a Buy slot and turn AC charge on. Without per-slot targets, a target goes to the global
 * AC charge upper limit, which applies to every Buy slot.
 */
export async function setBuySlot(inv: ScheduleInverter, slot: number, { start, end, target }: SlotWindow) {
  checkWindow({ start, end });
  const support = slotTarget(inv, 'Buy', slot, target);
  const write = inv.setChargeSlot.bind(inv);
  if (target !== undefined && slotHasTarget(support, slot)) {
    await write(slot, { start, end, targetStateOfCharge: target });
  } else if (target === undefined && slotHasTarget(support, slot) && isEmpty(readSlot(inv, 'charge', slot))) {
    await writeNewSlot(write, slot, { start, end }, NEW_BUY_TARGET);
  } else {
    await write(slot, { start, end });
  }
  if (!support.perSlotTargets && target !== undefined) await setGlobalChargeTarget(inv, target);
  await setFlag(inv, 'acCharge', true);
}

export async function clearBuySlot(inv: ScheduleInverter, slot: number) {
  await inv.setChargeSlot(slot, { start: EMPTY, end: EMPTY });
  await clearFlagIfLast(inv, 'charge');
}

/** Write a Sell slot and turn DC discharge on. Eco mode is left as it is (the app does the same). */
export async function setSellSlot(inv: ScheduleInverter, slot: number, { start, end, target }: SlotWindow) {
  checkWindow({ start, end });
  const support = slotTarget(inv, 'Sell', slot, target);
  if (target !== undefined && !support.perSlotTargets) throw notSupported('A per-slot discharge target');
  const write = inv.setDischargeSlot.bind(inv);
  if (target !== undefined) {
    await write(slot, { start, end, targetStateOfCharge: target });
  } else if (slotHasTarget(support, slot) && isEmpty(readSlot(inv, 'discharge', slot))) {
    await writeNewSlot(write, slot, { start, end }, NEW_SELL_TARGET);
  } else {
    await write(slot, { start, end });
  }
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
  /**
   * With per-slot targets: the global AC charge limit when it is enabled, as charging also stops
   * there (on ten-slot firmware, at the lower of it and the slot 1 target).
   */
  globalChargeLimit?: number;
  batteryReserve?: number;
}

function toRow(s: TimeSlotConfig, support: ScheduleSupport): NumberedSlot {
  const row: NumberedSlot = { slot: s.slot, start: s.start, end: s.end };
  if (slotHasTarget(support, s.slot) && s.targetStateOfCharge !== undefined) row.target = s.targetStateOfCharge;
  return row;
}

/** The effective global charge target: with HR 20 off the inverter charges to 100%, whatever HR 116 holds. */
function globalTarget(inv: ScheduleInverter) {
  return chargeLimitEnabled(inv) === false ? 100 : inv.getData().settings.acChargeUpperLimit;
}

export function readSchedule(inv: ScheduleInverter): ScheduleView {
  const support = scheduleSupport(inv.capabilities, inv.layout);
  const { schedules, settings } = inv.getData();
  const rows = (list: TimeSlotConfig[]) => list.filter((s) => !isEmpty(s)).map((s) => toRow(s, support));
  const p = schedules.batteryPause;
  let pause: PauseWindow | null = null;
  if (support.pause !== 'none' && p && p.mode !== 'off' && p.mode !== 'unknown') {
    pause = { mode: p.mode };
    // A window that is unread, or 00:00-00:00, is reported as mode only, so a save keeps it as it is
    if (support.pause === 'window' && p.start !== undefined && p.end !== undefined && p.start !== p.end) {
      Object.assign(pause, { start: p.start, end: p.end });
    }
  }
  return {
    support,
    buy: rows(schedules.charge),
    sell: rows(schedules.discharge),
    pause,
    ecoMode: settings.ecoMode,
    chargeTarget: support.perSlotTargets ? undefined : globalTarget(inv),
    globalChargeLimit: support.perSlotTargets && chargeLimitEnabled(inv) === true
      ? settings.acChargeUpperLimit : undefined,
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

/**
 * Check times and that no two windows overlap (touching is fine: 17:00–17:30 then 17:30–18:00).
 * Two rows that are both already on the inverter (`existing`, e.g. an overlap set by a flow card)
 * may overlap, so they don't block saving other changes.
 */
export function validateRows(rows: ScheduleRow[], existing: ScheduleRow[] = []) {
  rows.forEach(checkWindow);
  const key = (r: ScheduleRow) => `${r.type} ${r.start}-${r.end}`;
  // Match rows to existing windows one to one, so a new copy of an existing window is still checked
  const unmatched = new Map<string, number>();
  for (const r of existing) unmatched.set(key(r), (unmatched.get(key(r)) ?? 0) + 1);
  const isExisting = rows.map((r) => {
    const n = unmatched.get(key(r)) ?? 0;
    if (n > 0) unmatched.set(key(r), n - 1);
    return n > 0;
  });
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (isExisting[i] && isExisting[j]) continue;
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

/**
 * Rows keep their slot numbers; new rows take the lowest free slots, and new rows with a target
 * take slots that have a target register (three-phase slots 1/2 don't).
 */
function assignSlots(rows: DesiredSchedule['buy'], support: ScheduleSupport, count: number, label: string) {
  if (rows.length > count) throw new RangeError(`This inverter has ${count} ${label} slots, got ${rows.length}`);
  const out = new Map<number, SlotWindow & { slot?: number }>();
  for (const r of rows) {
    if (r.slot === undefined) continue;
    if (!Number.isInteger(r.slot) || r.slot < 1 || r.slot > count || out.has(r.slot)) {
      throw new RangeError(`Invalid ${label} slot ${r.slot}`);
    }
    if (r.target !== undefined && !slotHasTarget(support, r.slot)) {
      throw notSupported(`${label} slot ${r.slot} has no target on this inverter; a per-slot target`);
    }
    out.set(r.slot, r);
  }
  const byStart = (a: SlotWindow, b: SlotWindow) => a.start.localeCompare(b.start);
  const fresh = rows.filter((r) => r.slot === undefined);
  const place = (list: SlotWindow[], ok: (n: number) => boolean) => {
    for (const r of [...list].sort(byStart)) {
      let n = 1;
      while (n <= count && (out.has(n) || !ok(n))) n++;
      if (n > count) throw new RangeError(`No free ${label} slot with a target for ${r.start}–${r.end}`);
      out.set(n, r);
    }
  };
  place(fresh.filter((r) => r.target !== undefined), (n) => slotHasTarget(support, n));
  place(fresh.filter((r) => r.target === undefined), () => true);
  return out;
}

const sameSlot = (cur: TimeSlotConfig, want: SlotWindow | undefined, perSlot: boolean) => {
  if (!want) return isEmpty(cur);
  if (cur.start !== want.start || cur.end !== want.end) return false;
  return !perSlot || want.target === undefined || cur.targetStateOfCharge === want.target;
};

/** A schedule's windows as rows, for validateRows. */
export function scheduleRows(s: { buy: SlotWindow[]; sell: SlotWindow[]; pause: PauseWindow | null }): ScheduleRow[] {
  return [
    ...s.buy.map((r) => ({ type: 'buy' as const, start: r.start, end: r.end })),
    ...s.sell.map((r) => ({ type: 'sell' as const, start: r.start, end: r.end })),
    ...(s.pause?.start !== undefined && s.pause.end !== undefined
      ? [{ type: 'pause' as const, start: s.pause.start, end: s.pause.end }] : []),
  ];
}

/**
 * The inverter's windows that are in effect, for validateRows: Buy/Sell windows only while AC
 * charge / DC discharge is on, so a save that turns a disabled schedule on can't let its overlaps
 * through.
 */
export function activeRows(inv: ScheduleInverter): ScheduleRow[] {
  const { settings } = inv.getData();
  const s = readSchedule(inv);
  return scheduleRows({
    buy: settings.acCharge === false ? [] : s.buy,
    sell: settings.dcDischarge === false ? [] : s.sell,
    pause: s.pause,
  });
}

/**
 * Make the inverter's schedule match `desired`, writing only what changed: eco mode and the global
 * target, then Buy slots, Sell slots, the pause, and the AC charge / DC discharge flags last.
 * Everything is validated before the first write. `before` is the inverter's windows before the
 * save; a retry passes the first attempt's, so a partial write doesn't change what's allowed.
 */
export async function applySchedule(
  inv: ScheduleInverter, desired: DesiredSchedule, before: ScheduleRow[] = activeRows(inv),
) {
  const support = scheduleSupport(inv.capabilities, inv.layout);

  // Validate everything first, so a bad entry writes nothing.
  validateRows(scheduleRows(desired), before);
  [...desired.buy, ...desired.sell].forEach((r) => checkTarget(r.target));
  checkTarget(desired.chargeTarget);
  if (!support.perSlotTargets && [...desired.buy, ...desired.sell].some((r) => r.target !== undefined)) {
    throw notSupported('A per-slot target');
  }
  if (desired.chargeTarget !== undefined && support.perSlotTargets) throw notSupported('A global charge target');
  if (desired.pause && support.pause === 'none') throw notSupported('Battery pause');
  if (desired.pause?.start !== undefined && support.pause !== 'window') throw notSupported('A battery pause window');
  if (desired.ecoMode !== undefined && inv.layout !== 'single_phase') throw notSupported('Eco mode');
  const buy = assignSlots(desired.buy, support, support.buySlots, 'Buy');
  const sell = assignSlots(desired.sell, support, support.sellSlots, 'Sell');

  const { schedules, settings } = inv.getData();
  // Unread slots are missing from the snapshot; diffing against them could leave a window behind
  if (schedules.charge.length < support.buySlots || schedules.discharge.length < support.sellSlots) {
    throw new Error('Inverter data is still loading; try again in a minute');
  }

  if (desired.ecoMode !== undefined && settings.ecoMode !== desired.ecoMode) await inv.setSetting('ecoMode', desired.ecoMode);
  // Only a changed target is written: with HR 20 off the page shows 100%, and saving that back
  // would overwrite the limit HR 116 keeps for when HR 20 is turned on again. That also covers a
  // retry after HR 116 was written but HR 20 wasn't: under 100% it still reads as 100% (so is
  // written again), and HR 20 left on at 100% charges the same as off.
  if (desired.chargeTarget !== undefined && desired.chargeTarget !== globalTarget(inv)) {
    await setGlobalChargeTarget(inv, desired.chargeTarget);
  }

  const writeKind = async (
    current: TimeSlotConfig[], want: Map<number, SlotWindow & { slot?: number }>, count: number,
    write: ScheduleInverter['setChargeSlot'], newTarget?: number,
  ) => {
    for (let n = 1; n <= count; n++) {
      const cur = current.find((s) => s.slot === n);
      const given = want.get(n);
      // The default target goes to a window in an empty slot, and to a new row (no slot number)
      // also when it takes the slot of a removed row
      const isNew = given !== undefined && given.target === undefined && newTarget !== undefined
        && slotHasTarget(support, n) && (given.slot === undefined || !cur || isEmpty(cur));
      const w = isNew ? { ...given, target: newTarget } : given;
      if (cur && sameSlot(cur, w, support.perSlotTargets)) continue;
      if (!cur && !w) continue;
      if (isNew && (!cur || isEmpty(cur))) {
        await writeNewSlot(write, n, w!, newTarget!);
      } else if (w?.target !== undefined) {
        await write(n, { start: w.start, end: w.end, targetStateOfCharge: w.target });
      } else if (w) {
        await write(n, { start: w.start, end: w.end });
      } else {
        await write(n, { start: EMPTY, end: EMPTY });
      }
    }
  };
  await writeKind(schedules.charge, buy, support.buySlots, inv.setChargeSlot.bind(inv), NEW_BUY_TARGET);
  await writeKind(schedules.discharge, sell, support.sellSlots, inv.setDischargeSlot.bind(inv), NEW_SELL_TARGET);

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
