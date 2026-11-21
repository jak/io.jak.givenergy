'use strict';

/**
 * Maps a givenergy-modbus v3 snapshot to Homey capability values, per driver.
 *
 * v3 omits values a model doesn't report instead of zero-filling them. Those map to `null`,
 * which Homey shows as "no value" rather than a misleading 0.
 */

// Import type with resolution-mode to bridge ESM package from CJS context.
type InverterSnapshot = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterSnapshot;

export type CapabilityValues = Record<string, number | null>;

const orNull = (value: number | undefined): number | null => (value === undefined ? null : value);

/** Grid voltage: the single-phase reading, or the mean of the three phase voltages. */
export function gridVoltage(s: InverterSnapshot): number {
  if (s.layout === 'single_phase') return s.grid.voltage;
  const { phases } = s.grid;
  return Math.round((phases.reduce((sum, p) => sum + p.voltage, 0) / phases.length) * 10) / 10;
}

export function solarInverterValues(s: InverterSnapshot): CapabilityValues {
  return {
    measure_power: s.solar.power,
    meter_power: s.solar.energyTotalKwh,
    grid_power: s.grid.power,
    load_power: s.load.power,
    grid_import_energy: s.grid.energy.importTotalKwh,
    grid_export_energy: s.grid.energy.exportTotalKwh,
    grid_voltage: gridVoltage(s),
    grid_frequency: s.grid.frequency,
    pv_energy_today: s.solar.energyTodayKwh,
    grid_import_energy_today: s.grid.energy.importTodayKwh,
    grid_export_energy_today: s.grid.energy.exportTodayKwh,
    consumption_energy_today: orNull(s.load.energyTodayKwh),
  };
}

/** Library: positive battery power = discharging. Homey battery: positive = charging. */
export function batteryValues(s: InverterSnapshot): CapabilityValues {
  const { battery } = s;
  return {
    measure_power: -battery.power,
    measure_battery: battery.stateOfCharge,
    'meter_power.charged': orNull(battery.energy.chargeTotalKwh),
    'meter_power.discharged': orNull(battery.energy.dischargeTotalKwh),
    measure_temperature: s.layout === 'single_phase' ? s.battery.temperature : null,
    battery_charge_energy_today: battery.energy.chargeTodayKwh,
    battery_discharge_energy_today: battery.energy.dischargeTodayKwh,
  };
}

/** Library: positive grid power = exporting. Homey cumulative meter: positive = importing. */
export function gridMeterValues(s: InverterSnapshot): CapabilityValues {
  return {
    measure_power: -s.grid.power,
    'meter_power.imported': s.grid.energy.importTotalKwh,
    'meter_power.exported': s.grid.energy.exportTotalKwh,
    grid_voltage: gridVoltage(s),
    grid_frequency: s.grid.frequency,
    grid_import_energy_today: s.grid.energy.importTodayKwh,
    grid_export_energy_today: s.grid.energy.exportTodayKwh,
  };
}
