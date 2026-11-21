'use strict';

import Homey from 'homey';
import { withRetry } from './lib/retry';
import {
  METRICS, isAbove, roseAbove, droppedBelow, Crossing,
} from './lib/threshold';
import type { Inverter, SinglePhaseInverter } from './lib/types';
import { LEGACY_PAUSE_MODES } from './lib/legacy';

type GivEnergyInverter = Inverter;

/** Narrow to a single-phase inverter for features three-phase models don't have. */
function requireSinglePhase(inverter: Inverter, feature: string): SinglePhaseInverter {
  if (inverter.layout !== 'single_phase') throw new Error(`${feature} is not supported on three-phase inverters`);
  return inverter;
}

module.exports = class GivEnergyApp extends Homey.App {
  private connections = new Map<string, { inverter: GivEnergyInverter; refCount: number }>();
  private pending = new Map<string, Promise<GivEnergyInverter>>();

  async onInit() {
    this.log('GivEnergy app initialized');

    this.registerThresholdCards();

    // Condition cards
    this.homey.flow.getConditionCard('solar_generating')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.solar.power > 0 : false;
      });

    this.homey.flow.getConditionCard('battery_charging')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.battery.power < 0 : false;
      });

    this.homey.flow.getConditionCard('battery_discharging')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.battery.power > 0 : false;
      });

    this.homey.flow.getConditionCard('grid_importing')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.grid.power < 0 : false;
      });

    this.homey.flow.getConditionCard('grid_exporting')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.grid.power > 0 : false;
      });

    this.homey.flow.getConditionCard('eco_mode_enabled')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot?.layout === 'single_phase' ? snapshot.settings.ecoMode === true : false;
      });

    // Action cards — all write operations use withRetry for inverter timeout resilience
    this.homey.flow.getActionCard('toggle_eco_mode')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await withRetry(() => requireSinglePhase(inverter, 'Eco mode').setSetting('ecoMode', args.action === 'enable'), this.log);
      });

    this.homey.flow.getActionCard('toggle_timed_export')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await withRetry(() => inverter.setSetting('dcDischarge', args.action === 'enable'), this.log);
      });

    this.homey.flow.getActionCard('enable_charge_schedule')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await withRetry(() => inverter.setSetting('acCharge', args.action === 'enable'), this.log);
      });

    this.homey.flow.getActionCard('set_charge_rate')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        // givenergy-modbus v3 removed watt-based rates; this card is replaced in 2.0.0.
        throw new Error('Setting the charge rate in watts is no longer supported');
      });

    this.homey.flow.getActionCard('set_discharge_rate')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        // givenergy-modbus v3 removed watt-based rates; this card is replaced in 2.0.0.
        throw new Error('Setting the discharge rate in watts is no longer supported');
      });

    // Gen3-specific action cards
    this.homey.flow.getActionCard('enable_discharge_schedule')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        const sp = requireSinglePhase(inverter, 'Discharge schedule');
        await withRetry(() => sp.setBatteryPause({ mode: args.action === 'enable' ? 'discharge' : 'off' }), this.log);
      });

    this.homey.flow.getActionCard('set_export_limit')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        // givenergy-modbus v3 made the export limit read-only; this card is removed in 2.0.0.
        throw new Error('Setting the export limit is no longer supported');
      });

    this.homey.flow.getActionCard('set_battery_pause_mode')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        const sp = requireSinglePhase(inverter, 'Battery pause mode');
        await withRetry(() => sp.setBatteryPause({ mode: LEGACY_PAUSE_MODES[args.mode] }), this.log);
      });

    // Slot configuration action cards (Gen2 — no target SOC)
    this.homey.flow.getActionCard('set_charge_slot')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await withRetry(() => inverter.setChargeSlot(1, { start: args.start_time, end: args.end_time }), this.log);
      });

    this.homey.flow.getActionCard('set_discharge_slot')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        const slot = parseInt(args.slot, 10);
        await withRetry(() => inverter.setDischargeSlot(slot, { start: args.start_time, end: args.end_time }), this.log);
      });

    // Slot configuration action cards (Gen3 — with target SOC)
    this.homey.flow.getActionCard('set_charge_slot_gen3')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        const slot = parseInt(args.slot, 10);
        await withRetry(() => inverter.setChargeSlot(slot, {
          start: args.start_time,
          end: args.end_time,
          targetStateOfCharge: args.target_soc,
        }), this.log);
      });

    this.homey.flow.getActionCard('set_discharge_slot_gen3')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        const slot = parseInt(args.slot, 10);
        await withRetry(() => inverter.setDischargeSlot(slot, {
          start: args.start_time,
          end: args.end_time,
          targetStateOfCharge: args.target_soc,
        }), this.log);
      });

    // Force charge/discharge action cards
    this.homey.flow.getActionCard('force_charge')
      .registerRunListener(async (args: any) => {
        await withRetry(() => args.device.forceCharge(args.target_soc, args.charge_rate), this.log);
      });

    this.homey.flow.getActionCard('stop_force_charge')
      .registerRunListener(async (args: any) => {
        await withRetry(() => args.device.stopForceCharge(), this.log);
      });

    this.homey.flow.getActionCard('force_discharge')
      .registerRunListener(async (args: any) => {
        await withRetry(() => args.device.forceDischarge(args.discharge_rate, args.battery_reserve), this.log);
      });

    this.homey.flow.getActionCard('stop_force_discharge')
      .registerRunListener(async (args: any) => {
        await withRetry(() => args.device.stopForceDischarge(), this.log);
      });
  }

  /**
   * Threshold cards: devices trigger both crossing cards on every change with
   * { previous, current }; each flow runs only if it crossed its own threshold.
   */
  private registerThresholdCards() {
    for (const { id, argName, hasCondition } of METRICS) {
      this.homey.flow.getDeviceTriggerCard(`${id}_rose_above`)
        .registerRunListener(async (args: any, state: Crossing) => roseAbove(state, args[argName]));

      this.homey.flow.getDeviceTriggerCard(`${id}_dropped_below`)
        .registerRunListener(async (args: any, state: Crossing) => droppedBelow(state, args[argName]));

      if (hasCondition) {
        this.homey.flow.getConditionCard(`${id}_above`)
          .registerRunListener(async (args: any) => {
            const value = args.device.getCapabilityValue(id);
            return typeof value === 'number' && isAbove(value, args[argName]);
          });
      }
    }
  }

  async getConnection(serialNumber: string, host: string): Promise<GivEnergyInverter> {
    const existing = this.connections.get(serialNumber);
    if (existing) {
      existing.refCount++;
      return existing.inverter;
    }

    // Deduplicate concurrent connect calls for the same serial
    const inflight = this.pending.get(serialNumber);
    if (inflight) {
      const inverter = await inflight;
      const entry = this.connections.get(serialNumber);
      if (entry) entry.refCount++;
      return inverter;
    }

    const connectPromise = (async () => {
      const { GivEnergyInverter: Inverter } = await import('givenergy-modbus');
      return Inverter.connect({ host });
    })();

    this.pending.set(serialNumber, connectPromise);
    try {
      const inverter = await connectPromise;
      inverter.on('lost', () => this.handleConnectionLost(serialNumber, host));
      // The library's PollManager auto-reconnects on the same inverter object. Log the
      // recovery lifecycle for diagnosability; no re-registration is needed.
      inverter.on('reconnecting', (attempt: number, backoffMs: number) => {
        this.log(`[reconnecting] inverter=${serialNumber} host=${host} attempt=${attempt} backoff=${backoffMs}ms`);
      });
      inverter.on('reconnected', () => {
        this.log(`[reconnected] inverter=${serialNumber} host=${host}`);
      });
      this.connections.set(serialNumber, { inverter, refCount: 1 });
      return inverter;
    } finally {
      this.pending.delete(serialNumber);
    }
  }

  async releaseConnection(serialNumber: string): Promise<void> {
    const entry = this.connections.get(serialNumber);
    if (!entry) return;

    entry.refCount--;
    if (entry.refCount <= 0) {
      await entry.inverter.stop();
      this.connections.delete(serialNumber);
    }
  }

  private handleConnectionLost(serialNumber: string, host: string) {
    this.error(`[connection-lost] inverter=${serialNumber} host=${host} timestamp=${new Date().toISOString()}`);
    // Do NOT drop the connection entry: the library's PollManager keeps the same inverter
    // object and auto-reconnects (emitting 'reconnecting'/'reconnected'). Keeping the entry
    // means getInverter() — and therefore the flow action cards — keep working through the
    // outage and recover automatically. It also ensures releaseConnection() can still call
    // inverter.stop() on uninit, so the PollManager isn't leaked.
  }

  getInverter(serialNumber: string): GivEnergyInverter | undefined {
    return this.connections.get(serialNumber)?.inverter;
  }
};
