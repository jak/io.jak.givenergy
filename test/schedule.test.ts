import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Capabilities } from 'givenergy-modbus' with { 'resolution-mode': 'import' };
import {
  scheduleSupport, setBuySlot, clearBuySlot, setSellSlot, clearSellSlot, setPause, clearPause,
  readSchedule, applySchedule, scheduleRows, validateRows, setGlobalChargeTarget, type ScheduleInverter, type ScheduleRow,
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
  /** Slots the library hasn't read yet: left out of the snapshot. */
  unread?: number[];
} = {}) {
  const caps = opts.caps ?? GEN3;
  const count = caps.tenSlots ? 10 : 2;
  // Three-phase slots 1/2 have no target register (library: slotRegistersFor)
  const hasTarget = (n: number) => caps.perSlotTargets && !(opts.layout === 'three_phase' && n <= 2);
  const empty = (n: number): Slot => ({
    slot: n, start: '00:00', end: '00:00', ...(hasTarget(n) ? { targetStateOfCharge: 100 } : {}),
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
    if (cfg.targetStateOfCharge !== undefined && !hasTarget(slot)) {
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
        charge: state.charge.filter((s) => !opts.unread?.includes(s.slot)).map((s) => ({ ...s })),
        discharge: state.discharge.filter((s) => !opts.unread?.includes(s.slot)).map((s) => ({ ...s })),
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
    buySlots: 10, sellSlots: 10, perSlotTargets: true, noTargetSlots: [], pause: 'window',
  });
  assert.deepEqual(scheduleSupport(GEN2, 'single_phase'), {
    buySlots: 2, sellSlots: 2, perSlotTargets: false, noTargetSlots: [], pause: 'window',
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
  const inv = fakeInverter({
    settings: { acCharge: true },
    charge: [{
      slot: 2, start: '01:00', end: '02:00', targetStateOfCharge: 80,
    }],
  });
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
  // The default target goes in before the window (see writeNewSlot)
  assert.deepEqual(inv.writes, ['sell1 00:00-00:00 @4', 'sell1 17:30-18:00', 'dcDischarge=true']);
});

test('a new Sell slot stops at 4% (the reserve applies), not a leftover target; a used one keeps its own', async () => {
  const sellSlot = (slot: number, start: string, end: string, targetStateOfCharge: number) => ({
    slot, start, end, targetStateOfCharge,
  });
  const discharge = [sellSlot(1, '00:00', '00:00', 50), sellSlot(2, '16:00', '17:00', 30)];
  const inv = fakeInverter({ discharge });
  await setSellSlot(inv, 1, { start: '17:30', end: '18:00' });
  await setSellSlot(inv, 2, { start: '16:00', end: '16:30' });
  assert.deepEqual(inv.writes, ['sell1 00:00-00:00 @4', 'sell1 17:30-18:00', 'dcDischarge=true', 'sell2 16:00-16:30']);

  const gen2 = fakeInverter({ caps: GEN2 });
  await setSellSlot(gen2, 1, { start: '17:30', end: '18:00' });
  assert.deepEqual(gen2.writes, ['sell1 17:30-18:00', 'dcDischarge=true']);

  const sched = fakeInverter({ discharge: discharge.slice(0, 1) });
  await applySchedule(sched, { buy: [], sell: [{ start: '17:30', end: '18:00' }], pause: null });
  assert.deepEqual(sched.writes, ['sell1 00:00-00:00 @4', 'sell1 17:30-18:00', 'dcDischarge=true']);
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

// --- review fixes ---

const THREE_PHASE: Capabilities = { ...BASE, tenSlots: true, perSlotTargets: true };

test('three-phase has ten slots, but slots 1-2 have no target', () => {
  const support = scheduleSupport(THREE_PHASE, 'three_phase');
  assert.equal(support.buySlots, 10);
  assert.deepEqual(support.noTargetSlots, [1, 2]);
  assert.deepEqual(scheduleSupport(GEN3, 'single_phase').noTargetSlots, []);
});

test('a target on a slot without a target register is rejected before writing', async () => {
  const inv = fakeInverter({ caps: THREE_PHASE, layout: 'three_phase' });
  await assert.rejects(setBuySlot(inv, 1, { start: '01:00', end: '02:00', target: 80 }), /Buy slot 1 has no target/);
  assert.deepEqual(inv.writes, []);
});

test('applySchedule puts new rows with a target into slots that have one (three-phase)', async () => {
  const inv = fakeInverter({ caps: THREE_PHASE, layout: 'three_phase' });
  await applySchedule(inv, {
    buy: [{ start: '01:00', end: '02:00', target: 80 }, { start: '03:00', end: '04:00' }], sell: [], pause: null,
  });
  assert.deepEqual(inv.writes, ['buy1 03:00-04:00', 'buy3 01:00-02:00 @80', 'acCharge=true']);
});

test('targets must be whole numbers from 4 to 100, checked before any write', async () => {
  for (const target of [2, 101, 55.5]) {
    const inv = fakeInverter();
    await assert.rejects(setBuySlot(inv, 2, { start: '01:00', end: '02:00', target }), /4 and 100/);
    await assert.rejects(applySchedule(inv, {
      buy: [{ start: '01:00', end: '02:00' }], sell: [{ start: '05:00', end: '06:00', target }], pause: null, ecoMode: false,
    }), /4 and 100/);
    assert.deepEqual(inv.writes, [], `target ${target}`);
  }
  const gen2 = fakeInverter({ caps: GEN2 });
  await assert.rejects(applySchedule(gen2, {
    buy: [], sell: [], pause: null, chargeTarget: 3,
  }), /4 and 100/);
  await assert.rejects(setBuySlot(gen2, 1, { start: '01:00', end: '02:00', target: 0 }), /4 and 100/);
  assert.deepEqual(gen2.writes, []);
});

test('a new Buy slot without a target charges to 100%, not an old leftover target', async () => {
  const inv = fakeInverter({
    charge: [{
      slot: 2, start: '00:00', end: '00:00', targetStateOfCharge: 20,
    }],
  });
  await setBuySlot(inv, 2, { start: '13:00', end: '14:00' });
  await applySchedule(inv, { buy: [{ slot: 2, start: '13:00', end: '14:00' }, { start: '15:00', end: '16:00' }], sell: [], pause: null });
  assert.deepEqual(inv.writes, [
    'buy2 00:00-00:00 @100', 'buy2 13:00-14:00', 'acCharge=true', 'buy1 00:00-00:00 @100', 'buy1 15:00-16:00',
  ]);
});

test('clearing a slot keeps the flag on while other slots are still unread', async () => {
  const inv = fakeInverter({ charge: [{ slot: 1, start: '23:30', end: '05:30' }], settings: { acCharge: true }, unread: [3, 4] });
  await clearBuySlot(inv, 1);
  assert.deepEqual(inv.writes, ['buy1 00:00-00:00']);
});

test('applySchedule waits until every slot has been read', async () => {
  const inv = fakeInverter({ unread: [7] });
  await assert.rejects(applySchedule(inv, { buy: [], sell: [], pause: null }), /still loading/);
  assert.deepEqual(inv.writes, []);
});

test('an active pause whose window is 00:00-00:00 or unread reads as mode only, and is kept on save', async () => {
  for (const pause of [{ mode: 'both', start: '00:00', end: '00:00' }, { mode: 'discharge' }]) {
    const inv = fakeInverter({ pause });
    const read = readSchedule(inv).pause;
    assert.deepEqual(read, { mode: pause.mode });
    await applySchedule(inv, { buy: [], sell: [], pause: read });
    assert.deepEqual(inv.writes, []);
  }
});

test('readSchedule reports an enabled global AC charge limit on per-slot models', () => {
  const capped = fakeInverter({ settings: { acChargeUpperLimitEnabled: true, acChargeUpperLimit: 80 } });
  assert.equal(readSchedule(capped).globalChargeLimit, 80);
  assert.equal(readSchedule(fakeInverter({ settings: { acChargeUpperLimit: 80 } })).globalChargeLimit, undefined);
});

test('a global charge target under 100% turns HR 20 on, 100% turns it off', async () => {
  const inv = fakeInverter({ caps: GEN2, settings: { acChargeUpperLimitEnabled: false } });
  await setGlobalChargeTarget(inv, 60);
  assert.deepEqual(inv.writes, ['acChargeUpperLimit=60', 'acChargeUpperLimitEnabled=true']);
  await setGlobalChargeTarget(inv, 100);
  assert.deepEqual(inv.writes.slice(2), ['acChargeUpperLimit=100', 'acChargeUpperLimitEnabled=false']);

  const viaSlot = fakeInverter({ caps: GEN2, settings: { acChargeUpperLimitEnabled: false } });
  await setBuySlot(viaSlot, 1, { start: '00:30', end: '04:30', target: 80 });
  assert.deepEqual(viaSlot.writes, ['buy1 00:30-04:30', 'acChargeUpperLimit=80', 'acChargeUpperLimitEnabled=true', 'acCharge=true']);

  // Not reported by the model: HR 20 is left alone
  const noSwitch = fakeInverter({ caps: GEN2 });
  await setGlobalChargeTarget(noSwitch, 60);
  assert.deepEqual(noSwitch.writes, ['acChargeUpperLimit=60']);
  await assert.rejects(setGlobalChargeTarget(noSwitch, 2), /between 4 and 100/);
});

test('with HR 20 off the page shows a 100% charge target', () => {
  const off = fakeInverter({ caps: GEN2, settings: { acChargeUpperLimit: 60, acChargeUpperLimitEnabled: false } });
  assert.equal(readSchedule(off).chargeTarget, 100);
  const on = fakeInverter({ caps: GEN2, settings: { acChargeUpperLimit: 60, acChargeUpperLimitEnabled: true } });
  assert.equal(readSchedule(on).chargeTarget, 60);
});

test('an overlap already on the inverter does not block saving, a new one does', async () => {
  // e.g. set by flow cards: Buy 1 23:30-05:30 and Buy 2 01:00-03:00
  const charge = [{ slot: 1, start: '23:30', end: '05:30' }, { slot: 2, start: '01:00', end: '03:00' }];
  const inv = fakeInverter({ charge, settings: { acCharge: true } });
  await applySchedule(inv, {
    buy: [{ slot: 1, start: '23:30', end: '05:30' }, { slot: 2, start: '01:00', end: '03:00' }],
    sell: [{ start: '17:00', end: '18:00' }],
    pause: null,
  });
  assert.ok(inv.writes.includes('sell1 17:00-18:00'));

  const again = fakeInverter({ charge, settings: { acCharge: true } });
  await assert.rejects(applySchedule(again, {
    buy: [{ slot: 1, start: '23:30', end: '05:30' }, { slot: 2, start: '01:00', end: '03:00' }],
    sell: [{ start: '02:00', end: '02:30' }],
    pause: null,
  }), /overlap/);
  assert.deepEqual(again.writes, []);
});

test('a new copy of a window already on the inverter is still checked for overlap', () => {
  const existing: ScheduleRow[] = [{ type: 'buy', start: '01:00', end: '03:00' }];
  assert.throws(() => validateRows([
    { type: 'buy', start: '01:00', end: '03:00' }, { type: 'buy', start: '01:00', end: '03:00' },
  ], existing), /overlap/);
});

test('with HR 20 off, saving the 100% the page shows keeps the stored limit', async () => {
  const inv = fakeInverter({ caps: GEN2, settings: { acChargeUpperLimit: 60, acChargeUpperLimitEnabled: false } });
  const save = (chargeTarget: number) => applySchedule(inv, {
    buy: [], sell: [], pause: null, chargeTarget,
  });
  await save(100);
  assert.deepEqual(inv.writes, []);
  await save(60);
  assert.deepEqual(inv.writes, ['acChargeUpperLimit=60', 'acChargeUpperLimitEnabled=true']);
});

test('a single-slot card waits for an unread slot instead of guessing it is empty', async () => {
  const inv = fakeInverter({ unread: [2] });
  await assert.rejects(setSellSlot(inv, 2, { start: '17:00', end: '18:00' }), /still loading/);
  await assert.rejects(setBuySlot(inv, 2, { start: '01:00', end: '02:00' }), /still loading/);
  assert.deepEqual(inv.writes, []);
});

test('HR 20 is left alone on three-phase', async () => {
  const inv = fakeInverter({
    caps: { ...BASE, tenSlots: true }, layout: 'three_phase', settings: { acChargeUpperLimitEnabled: false },
  });
  await setGlobalChargeTarget(inv, 60);
  assert.deepEqual(inv.writes, ['acChargeUpperLimit=60']);
  assert.equal(readSchedule(inv).chargeTarget, 60);
});

test('a retry after a partial new-slot write still gives the slot its default target', async () => {
  const inv = fakeInverter({
    discharge: [{
      slot: 1, start: '00:00', end: '00:00', targetStateOfCharge: 50,
    }],
  });
  let calls = 0;
  const write = inv.setDischargeSlot.bind(inv);
  // The window write times out once, after the target went in
  inv.setDischargeSlot = async (slot, cfg) => {
    calls++;
    if (calls === 2) throw new Error('timeout');
    return write(slot, cfg);
  };
  await assert.rejects(setSellSlot(inv, 1, { start: '17:30', end: '18:00' }), /timeout/);
  await setSellSlot(inv, 1, { start: '17:30', end: '18:00' });
  assert.deepEqual(inv.getData().schedules.discharge[0], {
    slot: 1, start: '17:30', end: '18:00', targetStateOfCharge: 4,
  });
});

test('a retry after HR 116 was written but HR 20 was not turns HR 20 on', async () => {
  const inv = fakeInverter({ caps: GEN2, settings: { acChargeUpperLimit: 60, acChargeUpperLimitEnabled: false } });
  await applySchedule(inv, {
    buy: [], sell: [], pause: null, chargeTarget: 60,
  });
  assert.deepEqual(inv.writes, ['acChargeUpperLimit=60', 'acChargeUpperLimitEnabled=true']);
});

test('saving a 100% target leaves HR 20 on at 100% alone (it charges the same as off)', async () => {
  const inv = fakeInverter({ caps: GEN2, settings: { acChargeUpperLimit: 100, acChargeUpperLimitEnabled: true } });
  await applySchedule(inv, {
    buy: [], sell: [], pause: null, chargeTarget: 100,
  });
  assert.deepEqual(inv.writes, []);
});

test('an explicit charge target is written even when the last read matches', async () => {
  const inv = fakeInverter({ caps: GEN2, settings: { acChargeUpperLimit: 60, acChargeUpperLimitEnabled: true } });
  await setGlobalChargeTarget(inv, 60);
  assert.deepEqual(inv.writes, ['acChargeUpperLimit=60', 'acChargeUpperLimitEnabled=true']);
});

test('a new row in the slot of a removed one gets the default target, not the old one', async () => {
  const inv = fakeInverter({
    discharge: [{
      slot: 1, start: '17:00', end: '18:00', targetStateOfCharge: 50,
    }],
    settings: { dcDischarge: true },
  });
  await applySchedule(inv, { buy: [], sell: [{ start: '17:00', end: '18:00' }], pause: null });
  // One write: clearing an occupied slot first could leave 00:00 to the old end if a write fails
  assert.deepEqual(inv.writes, ['sell1 17:00-18:00 @4']);
});

test('on three-phase, clearing the last Buy slot leaves force charge (HR 1123) alone', async () => {
  // Only the deprecated charge schedule card switches it, as in 1.x
  const inv = fakeInverter({
    caps: { ...BASE, tenSlots: true }, layout: 'three_phase', charge: [{ slot: 1, start: '01:00', end: '02:00' }], settings: { acCharge: true, forceCharge: true },
  });
  await clearBuySlot(inv, 1);
  assert.deepEqual(inv.writes, ['buy1 00:00-00:00', 'acCharge=false']);
});

test('an overlap with a disabled schedule is checked, since saving turns it on', async () => {
  const inv = fakeInverter({
    charge: [{ slot: 1, start: '17:00', end: '19:00' }],
    discharge: [{ slot: 1, start: '18:00', end: '18:30' }],
    settings: { acCharge: true, dcDischarge: false },
  });
  const desired = { buy: [{ slot: 1, start: '17:00', end: '19:00' }], sell: [{ slot: 1, start: '18:00', end: '18:30' }], pause: null };
  await assert.rejects(applySchedule(inv, desired), /overlap/);
  await inv.setSetting('dcDischarge', true);
  await applySchedule(inv, desired); // already active: allowed, so other changes can be saved
});

test('a retried save is checked against the schedule from before the first attempt', async () => {
  // Sell 1 and 2 overlap (set by flows); the save replaces Sell 2 with a new row at the same times
  const discharge = [{ slot: 1, start: '17:00', end: '19:00' }, { slot: 2, start: '18:00', end: '18:30' }];
  const inv = fakeInverter({ discharge, settings: { dcDischarge: true } });
  const before = scheduleRows(readSchedule(inv));
  const desired = { buy: [], sell: [{ slot: 1, start: '17:00', end: '19:00' }, { start: '18:00', end: '18:30' }], pause: null };
  // The first attempt clears Sell 2, then times out: the inverter now has no overlap
  await inv.setDischargeSlot(2, { start: '00:00', end: '00:00' });
  await assert.rejects(applySchedule(inv, desired), /overlap/);
  await applySchedule(inv, desired, before);
  assert.equal(inv.getData().schedules.discharge[1].start, '18:00');
});
