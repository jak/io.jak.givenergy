import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Capabilities } from 'givenergy-modbus' with { 'resolution-mode': 'import' };
import {
  scheduleSupport, setBuySlot, clearBuySlot, setSellSlot, clearSellSlot, setPause, clearPause,
  readSchedule, applySchedule, validateRows, type ScheduleInverter,
} from '../lib/schedule.ts';

const BASE: Capabilities = {
  tenSlots: false,
  perSlotTargets: false,
  pauseMode: false,
  pauseWindow: false,
  acSettingsBlock: false,
  highVoltageBattery: false,
  smartLoad: false,
};
const GEN3: Capabilities = {
  ...BASE, tenSlots: true, perSlotTargets: true, pauseMode: true, pauseWindow: true, acSettingsBlock: true,
};
const GEN2: Capabilities = { ...BASE, pauseMode: true, pauseWindow: true };

type Slot = { slot: number; start: string; end: string; targetStateOfCharge?: number };

/** A fake inverter that applies writes to its own snapshot, as the library does. */
function fakeInverter(opts: {
  caps?: Capabilities;
  layout?: 'single_phase' | 'three_phase';
  charge?: Slot[];
  discharge?: Slot[];
  settings?: Record<string, unknown>;
  pause?: { mode: string; start?: string; end?: string };
} = {}) {
  const caps = opts.caps ?? GEN3;
  const count = caps.tenSlots ? 10 : 2;
  const empty = (n: number): Slot => ({
    slot: n, start: '00:00', end: '00:00', ...(caps.perSlotTargets ? { targetStateOfCharge: 100 } : {}),
  });
  const fill = (given: Slot[] = []) => Array.from({ length: count }, (_, i) => ({
    ...empty(i + 1), ...given.find((s) => s.slot === i + 1),
  }));
  const state = {
    charge: fill(opts.charge),
    discharge: fill(opts.discharge),
    settings: {
      acCharge: false, dcDischarge: false, acChargeUpperLimit: 100, batteryReserve: 4, ecoMode: true, ...opts.settings,
    } as Record<string, unknown>,
    pause: opts.pause ?? { mode: 'off', start: '00:00', end: '00:00' },
  };
  const writes: string[] = [];
  const writeSlot = (list: Slot[], kind: string) => (slot: number, cfg: Omit<Slot, 'slot'>) => {
    if (slot < 1 || slot > count) throw new RangeError(`slot must be 1-${count}, got ${slot}`);
    if (cfg.targetStateOfCharge !== undefined && !caps.perSlotTargets) {
      throw Object.assign(new Error('no target'), { name: 'UnsupportedSettingError', model: 'hybrid_gen2' });
    }
    writes.push(`${kind}${slot} ${cfg.start}-${cfg.end}${cfg.targetStateOfCharge !== undefined ? ` @${cfg.targetStateOfCharge}` : ''}`);
    Object.assign(list[slot - 1], cfg);
  };
  const inv = {
    writes,
    layout: opts.layout ?? 'single_phase',
    capabilities: caps,
    getData: () => ({
      schedules: {
        charge: state.charge.map((s) => ({ ...s })),
        discharge: state.discharge.map((s) => ({ ...s })),
        ...(opts.layout === 'three_phase' ? {} : { batteryPause: { ...state.pause } }),
      },
      settings: { ...state.settings },
    }) as unknown as ReturnType<ScheduleInverter['getData']>,
    setChargeSlot: async (slot: number, cfg: Omit<Slot, 'slot'>) => writeSlot(state.charge, 'buy')(slot, cfg),
    setDischargeSlot: async (slot: number, cfg: Omit<Slot, 'slot'>) => writeSlot(state.discharge, 'sell')(slot, cfg),
    setSetting: async (key: string, value: unknown) => {
      writes.push(`${key}=${value}`);
      state.settings[key] = value;
    },
    setBatteryPause: async (p: { mode: string; start?: string; end?: string }) => {
      writes.push(`pause ${p.mode}${p.start !== undefined ? ` ${p.start}-${p.end}` : ''}`);
      state.pause = { ...state.pause, ...p };
    },
  };
  return inv as unknown as ScheduleInverter & { writes: string[] };
}

// --- support ---

test('scheduleSupport follows capabilities and layout', () => {
  assert.deepEqual(scheduleSupport(GEN3, 'single_phase'), {
    buySlots: 10, sellSlots: 10, perSlotTargets: true, pause: 'window',
  });
  assert.deepEqual(scheduleSupport(GEN2, 'single_phase'), {
    buySlots: 2, sellSlots: 2, perSlotTargets: false, pause: 'window',
  });
  assert.equal(scheduleSupport({ ...BASE, pauseMode: true }, 'single_phase').pause, 'mode');
  assert.equal(scheduleSupport(BASE, 'three_phase').pause, 'none');
});

// --- Buy / Sell, matching the official app ---

test('setting a Buy slot writes it, then turns AC charge on', async () => {
  const inv = fakeInverter();
  await setBuySlot(inv, 2, { start: '17:00', end: '17:30', target: 90 });
  assert.deepEqual(inv.writes, ['buy2 17:00-17:30 @90', 'acCharge=true']);
});

test('AC charge is not rewritten when already on', async () => {
  const inv = fakeInverter({ settings: { acCharge: true } });
  await setBuySlot(inv, 2, { start: '17:00', end: '17:30' });
  assert.deepEqual(inv.writes, ['buy2 17:00-17:30']);
});

test('clearing a Buy slot keeps AC charge on while another Buy slot remains', async () => {
  const inv = fakeInverter({
    charge: [{ slot: 1, start: '23:30', end: '05:30' }, { slot: 2, start: '17:00', end: '17:30' }],
    settings: { acCharge: true },
  });
  await clearBuySlot(inv, 2);
  assert.deepEqual(inv.writes, ['buy2 00:00-00:00']);
});

test('clearing the last Sell slot turns DC discharge off', async () => {
  const inv = fakeInverter({ discharge: [{ slot: 1, start: '17:30', end: '18:00' }], settings: { dcDischarge: true } });
  await clearSellSlot(inv, 1);
  assert.deepEqual(inv.writes, ['sell1 00:00-00:00', 'dcDischarge=false']);
});

test('setting a Sell slot turns DC discharge on and leaves eco mode alone', async () => {
  const inv = fakeInverter();
  await setSellSlot(inv, 1, { start: '17:30', end: '18:00' });
  assert.deepEqual(inv.writes, ['sell1 17:30-18:00', 'dcDischarge=true']);
});

test('without per-slot targets, a Buy target goes to the global AC charge upper limit', async () => {
  const inv = fakeInverter({ caps: GEN2 });
  await setBuySlot(inv, 1, { start: '00:30', end: '04:30', target: 80 });
  assert.deepEqual(inv.writes, ['buy1 00:30-04:30', 'acChargeUpperLimit=80', 'acCharge=true']);
});

test('without per-slot targets, a Sell target is rejected before anything is written', async () => {
  const inv = fakeInverter({ caps: GEN2 });
  await assert.rejects(setSellSlot(inv, 1, { start: '17:00', end: '18:00', target: 20 }), /not supported/);
  assert.deepEqual(inv.writes, []);
});

test('a slot whose start equals its end is rejected', async () => {
  const inv = fakeInverter();
  await assert.rejects(setBuySlot(inv, 1, { start: '10:00', end: '10:00' }), /start and end/);
  assert.deepEqual(inv.writes, []);
});

// --- Pause ---

test('pause with a window, and clearing it like the official app', async () => {
  const inv = fakeInverter();
  await setPause(inv, { mode: 'both', start: '18:00', end: '18:30' });
  await clearPause(inv);
  assert.deepEqual(inv.writes, ['pause both 18:00-18:30', 'pause off 00:00-00:00']);
});

test('pause mode only (Gen1/AC): clear without a window', async () => {
  const inv = fakeInverter({ caps: { ...BASE, pauseMode: true } });
  await clearPause(inv);
  assert.deepEqual(inv.writes, ['pause off']);
});

test('three-phase has no pause', async () => {
  const inv = fakeInverter({ caps: BASE, layout: 'three_phase' });
  await assert.rejects(setPause(inv, { mode: 'both' }), /not supported/);
});

// --- reading ---

test('readSchedule lists only non-empty slots, with targets where supported', () => {
  const inv = fakeInverter({
    charge: [{
      slot: 1, start: '23:30', end: '05:30', targetStateOfCharge: 100,
    }],
    discharge: [{
      slot: 3, start: '17:30', end: '18:00', targetStateOfCharge: 4,
    }],
    pause: { mode: 'both', start: '18:00', end: '18:30' },
  });
  const s = readSchedule(inv);
  assert.deepEqual(s.buy, [{
    slot: 1, start: '23:30', end: '05:30', target: 100,
  }]);
  assert.deepEqual(s.sell, [{
    slot: 3, start: '17:30', end: '18:00', target: 4,
  }]);
  assert.deepEqual(s.pause, { mode: 'both', start: '18:00', end: '18:30' });
  assert.equal(s.ecoMode, true);
  assert.equal(s.chargeTarget, undefined, 'global target only without per-slot targets');
});

test('readSchedule: no pause shown when mode is off', () => {
  assert.equal(readSchedule(fakeInverter()).pause, null);
});

test('readSchedule without per-slot targets reports the global charge target and no slot targets', () => {
  const s = readSchedule(fakeInverter({ caps: GEN2, charge: [{ slot: 1, start: '00:30', end: '04:30' }] }));
  assert.deepEqual(s.buy, [{ slot: 1, start: '00:30', end: '04:30' }]);
  assert.equal(s.chargeTarget, 100);
});

// --- validation ---

test('validateRows rejects overlaps, including windows that cross midnight', () => {
  assert.throws(() => validateRows([
    { type: 'buy', start: '23:30', end: '05:30' },
    { type: 'sell', start: '05:00', end: '06:00' },
  ]), /overlap/);
  assert.doesNotThrow(() => validateRows([
    { type: 'buy', start: '17:00', end: '17:30' },
    { type: 'sell', start: '17:30', end: '18:00' },
    { type: 'pause', start: '18:00', end: '18:30' },
  ]));
});

test('validateRows rejects bad times', () => {
  assert.throws(() => validateRows([{ type: 'buy', start: '25:00', end: '01:00' }]), /HH:MM/);
});

// --- applySchedule ---

test('applySchedule keeps existing slot numbers and writes only changes', async () => {
  const inv = fakeInverter({
    charge: [{
      slot: 1, start: '23:30', end: '05:30', targetStateOfCharge: 100,
    }],
    settings: { acCharge: true },
  });
  await applySchedule(inv, {
    buy: [{
      slot: 1, start: '23:30', end: '05:30', target: 100,
    }, { start: '13:00', end: '14:00', target: 80 }],
    sell: [{ start: '17:30', end: '18:00', target: 4 }],
    pause: { mode: 'both', start: '18:00', end: '18:30' },
  });
  assert.deepEqual(inv.writes, [
    'buy2 13:00-14:00 @80',
    'sell1 17:30-18:00 @4',
    'pause both 18:00-18:30',
    'dcDischarge=true',
  ]);
});

test('applySchedule clears removed slots and switches the flag off last', async () => {
  const inv = fakeInverter({
    charge: [{ slot: 1, start: '23:30', end: '05:30' }],
    discharge: [{ slot: 2, start: '16:00', end: '17:00' }],
    settings: { acCharge: true, dcDischarge: true },
  });
  await applySchedule(inv, {
    buy: [{
      slot: 1, start: '23:30', end: '05:30', target: 100,
    }],
    sell: [],
    pause: null,
  });
  assert.deepEqual(inv.writes, ['sell2 00:00-00:00', 'dcDischarge=false']);
});

test('applySchedule rejects more rows than slots before writing anything', async () => {
  const inv = fakeInverter({ caps: GEN2 });
  const buy = [{ start: '01:00', end: '02:00' }, { start: '03:00', end: '04:00' }, { start: '05:00', end: '06:00' }];
  await assert.rejects(applySchedule(inv, { buy, sell: [], pause: null }), /2 Buy slots/);
  assert.deepEqual(inv.writes, []);
});

test('applySchedule writes eco mode and the global charge target when they change', async () => {
  const inv = fakeInverter({ caps: GEN2 });
  await applySchedule(inv, {
    buy: [], sell: [], pause: null, ecoMode: false, chargeTarget: 90,
  });
  assert.deepEqual(inv.writes, ['ecoMode=false', 'acChargeUpperLimit=90']);
});
