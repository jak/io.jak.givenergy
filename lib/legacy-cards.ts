'use strict';

/**
 * Deprecated 1.x flow cards. They are hidden from new flows (`"deprecated": true`) but keep working
 * in existing ones, doing what they did in 1.x: they write the registers v2 of givenergy-modbus
 * wrote, and never switch grid charging or discharging on or off as a side effect.
 * To be removed in version 3 of the app.
 */

import { scheduleSupport, slotHasTarget } from './schedule.ts';

type Lib = typeof import('givenergy-modbus', { with: { 'resolution-mode': 'import' } });
type Capabilities = InstanceType<Lib['SinglePhaseInverter']>['capabilities'];
type Layout = InstanceType<Lib['SinglePhaseInverter']>['layout'] | InstanceType<Lib['ThreePhaseInverter']>['layout'];

type SlotConfig = { start: string; end: string; targetStateOfCharge?: number };

/** The inverter surface the legacy cards use; a connected inverter satisfies it. */
export interface LegacyInverter {
  layout: Layout;
  capabilities: Capabilities;
  setChargeSlot(slot: number, config: SlotConfig): Promise<void>;
  setDischargeSlot(slot: number, config: SlotConfig): Promise<void>;
  setSetting(key: string, value: number | boolean): Promise<void>;
  setBatteryPause?(pause: { mode: 'off' | 'charge' | 'discharge' | 'both' }): Promise<void>;
}

export type LegacyHandler = (inverter: LegacyInverter, args: Record<string, unknown>) => Promise<void>;

const PAUSE_MODES: Record<string, 'off' | 'charge' | 'discharge' | 'both'> = {
  disabled: 'off', pause_charge: 'charge', pause_discharge: 'discharge', pause_both: 'both',
};

/** v2 accepted 0–100; v3 takes 4–100. A target under 4 becomes 4. */
const targetOf = (inverter: LegacyInverter, slot: number, value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!slotHasTarget(scheduleSupport(inverter.capabilities, inverter.layout), slot)) return undefined; // v2 ignored it too
  return Math.max(4, Math.min(100, Math.round(Number(value))));
};

const slotWindow = (inverter: LegacyInverter, slot: number, args: Record<string, unknown>): SlotConfig => {
  const config: SlotConfig = { start: String(args.start_time).trim(), end: String(args.end_time).trim() };
  const target = targetOf(inverter, slot, args.target_soc);
  if (target !== undefined) config.targetStateOfCharge = target;
  return config;
};

const pause = async (inverter: LegacyInverter, mode: 'off' | 'charge' | 'discharge' | 'both') => {
  if (inverter.layout !== 'single_phase' || !inverter.setBatteryPause) {
    throw new Error('Battery pause is not supported on three-phase inverters');
  }
  await inverter.setBatteryPause({ mode });
};

/**
 * v2's watts-to-rate conversion. Single-phase: battery charge rate in C/100 (watts / 100, max 50).
 * Three-phase: power % of the inverter rating (watts / 50, 1–100).
 */
const rate = (inverter: LegacyInverter, direction: 'Charge' | 'Discharge', watts: number) => {
  if (!(watts >= 0)) throw new Error(`${direction} rate must be 0 W or more`);
  if (inverter.layout === 'three_phase') {
    return inverter.setSetting(`inverter${direction}PowerPercent`, Math.max(1, Math.min(100, Math.round(watts / 50))));
  }
  return inverter.setSetting(`battery${direction}Rate`, Math.min(50, Math.round(watts / 100)));
};

const enabled = (args: Record<string, unknown>) => args.action === 'enable';

export const LEGACY_CARDS: Record<string, LegacyHandler> = {
  set_charge_slot: (inv, a) => inv.setChargeSlot(1, slotWindow(inv, 1, { ...a, target_soc: undefined })),
  set_charge_slot_gen3: (inv, a) => inv.setChargeSlot(Number(a.slot), slotWindow(inv, Number(a.slot), a)),
  set_discharge_slot: (inv, a) => inv.setDischargeSlot(Number(a.slot), slotWindow(inv, Number(a.slot), { ...a, target_soc: undefined })),
  set_discharge_slot_gen3: (inv, a) => inv.setDischargeSlot(Number(a.slot), slotWindow(inv, Number(a.slot), a)),
  enable_charge_schedule: (inv, a) => inv.setSetting('acCharge', enabled(a)),
  toggle_timed_export: (inv, a) => inv.setSetting('dcDischarge', enabled(a)),
  // In 1.x this card set the battery pause to "pause discharge" (or off), not the discharge slots
  enable_discharge_schedule: (inv, a) => pause(inv, enabled(a) ? 'discharge' : 'off'),
  set_battery_pause_mode: (inv, a) => {
    const mode = PAUSE_MODES[String(a.mode)];
    if (!mode) throw new Error(`Unknown pause mode: ${a.mode}`);
    return pause(inv, mode);
  },
  set_charge_rate: (inv, a) => rate(inv, 'Charge', Number(a.watts)),
  set_discharge_rate: (inv, a) => rate(inv, 'Discharge', Number(a.watts)),
  set_export_limit: async () => {
    throw new Error('The export limit can no longer be changed from Homey. It is set by your installer.');
  },
};
