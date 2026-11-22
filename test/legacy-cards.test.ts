import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Capabilities } from 'givenergy-modbus' with { 'resolution-mode': 'import' };
import { LEGACY_CARDS, type LegacyInverter } from '../lib/legacy-cards.ts';

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

/** Records every write as [method, ...args]. */
function recorder(caps: Capabilities = GEN3, layout: 'single_phase' | 'three_phase' = 'single_phase') {
  const writes: unknown[][] = [];
  const inv: LegacyInverter = {
    layout,
    capabilities: caps,
    setChargeSlot: async (...a) => { writes.push(['setChargeSlot', ...a]); },
    setDischargeSlot: async (...a) => { writes.push(['setDischargeSlot', ...a]); },
    setSetting: async (...a) => { writes.push(['setSetting', ...a]); },
    setBatteryPause: layout === 'single_phase' ? async (...a) => { writes.push(['setBatteryPause', ...a]); } : undefined,
  };
  return { inv, writes };
}

const run = async (id: string, args: Record<string, unknown>, inv: LegacyInverter) => LEGACY_CARDS[id](inv, args);

test('every deprecated card has a handler', () => {
  assert.deepEqual(Object.keys(LEGACY_CARDS).sort(), [
    'enable_charge_schedule', 'enable_discharge_schedule', 'set_battery_pause_mode', 'set_charge_rate',
    'set_charge_slot', 'set_charge_slot_gen3', 'set_discharge_rate', 'set_discharge_slot',
    'set_discharge_slot_gen3', 'set_export_limit', 'toggle_timed_export',
  ]);
});

test('slot cards write the slot only, as in 1.x', async () => {
  const { inv, writes } = recorder();
  await run('set_charge_slot', { start_time: '00:30', end_time: ' 04:30 ' }, inv);
  await run('set_charge_slot_gen3', { slot: '2', start_time: '01:00', end_time: '02:00', target_soc: 80 }, inv);
  await run('set_discharge_slot', { slot: '2', start_time: '17:00', end_time: '18:00' }, inv);
  await run('set_discharge_slot_gen3', { slot: '1', start_time: '16:00', end_time: '17:00', target_soc: 20 }, inv);
  assert.deepEqual(writes, [
    ['setChargeSlot', 1, { start: '00:30', end: '04:30' }],
    ['setChargeSlot', 2, { start: '01:00', end: '02:00', targetStateOfCharge: 80 }],
    ['setDischargeSlot', 2, { start: '17:00', end: '18:00' }],
    ['setDischargeSlot', 1, { start: '16:00', end: '17:00', targetStateOfCharge: 20 }],
  ]);
});

test('targets are dropped where the slot has none, and raised to the v3 minimum', async () => {
  const gen2 = recorder(GEN2);
  await run('set_charge_slot_gen3', { slot: '1', start_time: '01:00', end_time: '02:00', target_soc: 80 }, gen2.inv);
  assert.deepEqual(gen2.writes, [['setChargeSlot', 1, { start: '01:00', end: '02:00' }]]);

  const threePhase = recorder(GEN3, 'three_phase');
  await run('set_charge_slot_gen3', { slot: '2', start_time: '01:00', end_time: '02:00', target_soc: 80 }, threePhase.inv);
  assert.deepEqual(threePhase.writes, [['setChargeSlot', 2, { start: '01:00', end: '02:00' }]]);

  const gen3 = recorder();
  await run('set_discharge_slot_gen3', { slot: '3', start_time: '16:00', end_time: '17:00', target_soc: 0 }, gen3.inv);
  assert.deepEqual(gen3.writes, [['setDischargeSlot', 3, { start: '16:00', end: '17:00', targetStateOfCharge: 4 }]]);
});

test('schedule toggles write the same flags as 1.x', async () => {
  const { inv, writes } = recorder();
  await run('enable_charge_schedule', { action: 'enable' }, inv);
  await run('toggle_timed_export', { action: 'disable' }, inv);
  await run('enable_discharge_schedule', { action: 'enable' }, inv);
  await run('enable_discharge_schedule', { action: 'disable' }, inv);
  assert.deepEqual(writes, [
    ['setSetting', 'acCharge', true],
    ['setSetting', 'dcDischarge', false],
    ['setBatteryPause', { mode: 'discharge' }],
    ['setBatteryPause', { mode: 'off' }],
  ]);
});

test('pause mode maps the 1.x values', async () => {
  const { inv, writes } = recorder();
  for (const mode of ['disabled', 'pause_charge', 'pause_discharge', 'pause_both']) {
    await run('set_battery_pause_mode', { mode }, inv);
  }
  assert.deepEqual(writes.map((w) => (w[1] as { mode: string }).mode), ['off', 'charge', 'discharge', 'both']);
  await assert.rejects(run('set_battery_pause_mode', { mode: 'bogus' }, inv), /Unknown pause mode/);
  await assert.rejects(run('set_battery_pause_mode', { mode: 'pause_both' }, recorder(GEN3, 'three_phase').inv), /three-phase/);
});

test('watt rates use the 1.x conversion', async () => {
  const single = recorder();
  await run('set_charge_rate', { watts: 2600 }, single.inv);
  await run('set_discharge_rate', { watts: 10000 }, single.inv);
  assert.deepEqual(single.writes, [['setSetting', 'batteryChargeRate', 26], ['setSetting', 'batteryDischargeRate', 50]]);

  const three = recorder(GEN3, 'three_phase');
  await run('set_charge_rate', { watts: 3000 }, three.inv);
  await run('set_discharge_rate', { watts: 0 }, three.inv);
  assert.deepEqual(three.writes, [['setSetting', 'inverterChargePowerPercent', 60], ['setSetting', 'inverterDischargePowerPercent', 1]]);

  await assert.rejects(run('set_charge_rate', { watts: -1 }, single.inv), /0 W or more/);
});

test('export limit explains it can no longer be set', async () => {
  const { inv, writes } = recorder();
  await assert.rejects(run('set_export_limit', { watts: 3600 }, inv), /installer/);
  assert.deepEqual(writes, []);
});
