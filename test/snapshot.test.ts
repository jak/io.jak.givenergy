import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InverterSnapshot } from 'givenergy-modbus' with { 'resolution-mode': 'import' };
import {
  solarInverterValues, batteryValues, gridMeterValues, gridVoltage,
} from '../lib/snapshot.ts';

// Only the fields lib/snapshot.ts reads; the rest of a real snapshot is irrelevant here.
function singlePhase(overrides: Record<string, unknown> = {}): InverterSnapshot {
  return {
    layout: 'single_phase',
    model: 'hybrid_gen3',
    solar: {
      power: 1200, energyTodayKwh: 5.5, energyTotalKwh: 1000.1, strings: [],
    },
    battery: {
      power: -800,
      stateOfCharge: 64,
      temperature: 18.5,
      energy: {
        chargeTodayKwh: 3.2, dischargeTodayKwh: 1.1, chargeTotalKwh: 400, dischargeTotalKwh: 380,
      },
    },
    grid: {
      power: 250,
      voltage: 241.3,
      frequency: 50.02,
      energy: {
        importTodayKwh: 2.4, exportTodayKwh: 0.7, importTotalKwh: 3000, exportTotalKwh: 900,
      },
    },
    load: { power: 650, energyTodayKwh: 9.9, energyTotalKwh: 5000 },
    ...overrides,
  } as unknown as InverterSnapshot;
}

function threePhase(): InverterSnapshot {
  return {
    layout: 'three_phase',
    model: 'hybrid_3ph',
    solar: {
      power: 9000, energyTodayKwh: 30, energyTotalKwh: 20000, strings: [],
    },
    battery: {
      power: 2000,
      stateOfCharge: 80,
      energy: { chargeTodayKwh: 1, dischargeTodayKwh: 2 },
    },
    grid: {
      power: -1500,
      frequency: 49.98,
      phases: [
        { voltage: 240, current: 1, power: -500 },
        { voltage: 242, current: 1, power: -500 },
        { voltage: 244, current: 1, power: -500 },
      ],
      energy: {
        importTodayKwh: 4, exportTodayKwh: 5, importTotalKwh: 6, exportTotalKwh: 7,
      },
    },
    load: { power: 3000, energyTodayKwh: 40, energyTotalKwh: 50 },
  } as unknown as InverterSnapshot;
}

test('solar inverter values from a single-phase snapshot', () => {
  assert.deepEqual(solarInverterValues(singlePhase()), {
    measure_power: 1200,
    meter_power: 1000.1,
    grid_power: 250,
    load_power: 650,
    grid_import_energy: 3000,
    grid_export_energy: 900,
    grid_voltage: 241.3,
    grid_frequency: 50.02,
    pv_energy_today: 5.5,
    grid_import_energy_today: 2.4,
    grid_export_energy_today: 0.7,
    consumption_energy_today: 9.9,
  });
});

test('consumption is null on models that omit it (ac)', () => {
  const s = singlePhase({ model: 'ac', load: { power: 400 } });
  assert.equal(solarInverterValues(s).consumption_energy_today, null);
});

test('battery values: power flipped to Homey convention (positive = charging)', () => {
  assert.deepEqual(batteryValues(singlePhase()), {
    measure_power: 800,
    measure_battery: 64,
    'meter_power.charged': 400,
    'meter_power.discharged': 380,
    measure_temperature: 18.5,
    battery_charge_energy_today: 3.2,
    battery_discharge_energy_today: 1.1,
  });
});

test('battery totals and temperature are null when absent (three-phase)', () => {
  const v = batteryValues(threePhase());
  assert.equal(v.measure_power, -2000);
  assert.equal(v['meter_power.charged'], null);
  assert.equal(v['meter_power.discharged'], null);
  assert.equal(v.measure_temperature, null);
});

test('grid meter values: power flipped to Homey convention (positive = importing)', () => {
  assert.deepEqual(gridMeterValues(singlePhase()), {
    measure_power: -250,
    'meter_power.imported': 3000,
    'meter_power.exported': 900,
    grid_voltage: 241.3,
    grid_frequency: 50.02,
    grid_import_energy_today: 2.4,
    grid_export_energy_today: 0.7,
  });
});

test('grid voltage is the phase mean on three-phase', () => {
  assert.equal(gridVoltage(threePhase()), 242);
  assert.equal(gridVoltage(singlePhase()), 241.3);
});
