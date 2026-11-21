import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InverterSnapshot, Capabilities } from 'givenergy-modbus' with { 'resolution-mode': 'import' };
import { modelName, settingsFromSnapshot, settingWrites } from '../lib/device-settings.ts';

const GEN3: Capabilities = {
  tenSlots: true,
  perSlotTargets: true,
  pauseMode: true,
  pauseWindow: true,
  acSettingsBlock: true,
  highVoltageBattery: false,
  smartLoad: false,
};

function snapshot(overrides: Record<string, unknown> = {}): InverterSnapshot {
  return {
    layout: 'single_phase',
    model: 'hybrid_gen3',
    capabilities: GEN3,
    identity: { firmware: { arm: 318, dsp: 451 } },
    settings: {
      ecoMode: true, batteryReserve: 4, inverterChargePowerPercent: 100, inverterDischargePowerPercent: 80,
    },
    ...overrides,
  } as unknown as InverterSnapshot;
}

test('model names read like the GivEnergy app', () => {
  assert.equal(modelName('hybrid_gen3'), 'Hybrid Gen3');
  assert.equal(modelName('hybrid_gen3_plus'), 'Hybrid Gen3+');
  assert.equal(modelName('hybrid_3ph'), 'Hybrid 3-phase');
  assert.equal(modelName('all_in_one'), 'All in One');
  assert.equal(modelName('ac'), 'AC Coupled');
});

test('settings from a ten-slot Gen3', () => {
  assert.deepEqual(settingsFromSnapshot(snapshot()), {
    label_model: 'Hybrid Gen3',
    label_firmware: 'ARM 318 / DSP 451',
    label_schedule_support: '10 Buy · 10 Sell · pause window',
    eco_mode: true,
    battery_reserve: 4,
    charge_power: 100,
    discharge_power: 80,
  });
});

test('settings leave out what the model does not report', () => {
  const s = settingsFromSnapshot(snapshot({
    layout: 'three_phase',
    model: 'hybrid_3ph',
    capabilities: {
      ...GEN3, tenSlots: false, perSlotTargets: false, pauseMode: false, pauseWindow: false,
    },
    settings: { batteryReserve: 10 },
  }));
  assert.equal(s.label_schedule_support, '2 Buy · 2 Sell');
  assert.equal(s.battery_reserve, 10);
  assert.equal('eco_mode' in s, false);
  assert.equal('charge_power' in s, false);
});

test('pause mode without a window is described', () => {
  const s = settingsFromSnapshot(snapshot({ capabilities: { ...GEN3, tenSlots: false, pauseWindow: false } }));
  assert.equal(s.label_schedule_support, '2 Buy · 2 Sell · pause mode');
});

test('settingWrites maps changed settings to library settings', () => {
  assert.deepEqual(
    settingWrites(['eco_mode', 'battery_reserve', 'charge_power', 'discharge_power'], {
      eco_mode: false, battery_reserve: 20, charge_power: 50, discharge_power: 60,
    }, () => true),
    [['ecoMode', false], ['batteryReserve', 20], ['inverterChargePowerPercent', 50], ['inverterDischargePowerPercent', 60]],
  );
});

test('settingWrites rejects unsupported settings before anything is written', () => {
  assert.throws(
    () => settingWrites(['battery_reserve', 'charge_power'], { battery_reserve: 20, charge_power: 50 }, (k) => k !== 'inverterChargePowerPercent'),
    /Charge power is not supported on this inverter/,
  );
});

test('settingWrites ignores labels and unknown keys', () => {
  assert.deepEqual(settingWrites(['label_model', 'something'], {}, () => true), []);
});
