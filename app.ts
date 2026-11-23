'use strict';

import Homey from 'homey';
import { withRetry } from './lib/retry';
import {
  METRICS, isAbove, roseAbove, droppedBelow, Crossing,
} from './lib/threshold';
import type {
  Inverter, SinglePhaseInverter, GivEnergyAppApi, CardArgs, ForceControlDevice,
} from './lib/types';
import {
  scheduleInverter, scheduleSupport, slotHasTarget, setGlobalChargeTarget, setBuySlot, clearBuySlot, setSellSlot, clearSellSlot, setPause, clearPause,
  readSchedule, applySchedule, type ScheduleInverter, type ScheduleView,
} from './lib/schedule';
import { parseDesiredSchedule } from './lib/schedule-request';
import { modelName } from './lib/device-settings';
import { userMessage } from './lib/errors';
import { LEGACY_CARDS, type LegacyInverter } from './lib/legacy-cards';

type GivEnergyInverter = Inverter;

/** App setting recording that the 2.0 deprecated-cards notice was handled on this Homey. */
const DEPRECATED_CARDS_NOTICE = 'deprecatedCardsNotice';

/** Narrow to a single-phase inverter for features three-phase models don't have. */
function requireSinglePhase(inverter: Inverter, feature: string): SinglePhaseInverter {
  if (inverter.layout !== 'single_phase') throw new Error(`${feature} is not supported on three-phase inverters`);
  return inverter;
}

module.exports = class GivEnergyApp extends Homey.App implements GivEnergyAppApi {
  private connections = new Map<string, { inverter: GivEnergyInverter; refCount: number }>();
  private pending = new Map<string, Promise<GivEnergyInverter>>();

  async onInit() {
    this.log('GivEnergy app initialized');

    this.registerThresholdCards();

    // Condition cards
    this.homey.flow.getConditionCard('solar_generating')
      .registerRunListener(async (args: CardArgs) => {
        const snapshot = args.device.getInverterSnapshot?.();
        return snapshot ? snapshot.solar.power > 0 : false;
      });

    this.homey.flow.getConditionCard('battery_charging')
      .registerRunListener(async (args: CardArgs) => {
        const snapshot = args.device.getInverterSnapshot?.();
        return snapshot ? snapshot.battery.power < 0 : false;
      });

    this.homey.flow.getConditionCard('battery_discharging')
      .registerRunListener(async (args: CardArgs) => {
        const snapshot = args.device.getInverterSnapshot?.();
        return snapshot ? snapshot.battery.power > 0 : false;
      });

    this.homey.flow.getConditionCard('grid_importing')
      .registerRunListener(async (args: CardArgs) => {
        const snapshot = args.device.getInverterSnapshot?.();
        return snapshot ? snapshot.grid.power < 0 : false;
      });

    this.homey.flow.getConditionCard('grid_exporting')
      .registerRunListener(async (args: CardArgs) => {
        const snapshot = args.device.getInverterSnapshot?.();
        return snapshot ? snapshot.grid.power > 0 : false;
      });

    this.homey.flow.getConditionCard('eco_mode_enabled')
      .registerRunListener(async (args: CardArgs) => {
        const snapshot = args.device.getInverterSnapshot?.();
        return snapshot?.layout === 'single_phase' ? snapshot.settings.ecoMode === true : false;
      });

    this.registerActionCards();

    // Force charge/discharge: the device remembers and restores the slot and settings they replace
    const deviceAction = (id: string, run: (device: ForceControlDevice, args: CardArgs) => Promise<unknown>) => {
      this.homey.flow.getActionCard(id).registerRunListener(async (args: CardArgs) => {
        try {
          await withRetry(() => run(args.device as ForceControlDevice, args), { homey: this.homey, log: this.log.bind(this) });
        } catch (err) {
          throw new Error(userMessage(err));
        }
      });
    };
    deviceAction('force_charge', (d, a) => d.forceCharge(a.target_soc, a.charge_rate));
    deviceAction('stop_force_charge', (d) => d.stopForceCharge());
    deviceAction('force_discharge', (d, a) => d.forceDischarge(a.discharge_rate, a.battery_reserve));
    deviceAction('stop_force_discharge', (d) => d.stopForceDischarge());
  }

  private deprecatedCardsNotice?: Promise<void>;

  /**
   * Tell the user on the timeline, once per Homey, that some flow cards are deprecated. Called by
   * inverter devices paired by 1.x when they start, so updates get it and fresh installs don't.
   * (App#onInit is too early to look at devices: drivers aren't initialised yet.)
   */
  announceDeprecatedCards(): Promise<void> {
    this.deprecatedCardsNotice ??= (async () => {
      if (this.homey.settings.get(DEPRECATED_CARDS_NOTICE)) return;
      await this.homey.notifications.createNotification({ excerpt: this.homey.__('notifications.deprecatedCards') });
      this.homey.settings.set(DEPRECATED_CARDS_NOTICE, true);
      this.log('Deprecated cards notice posted to the timeline');
    })().catch((err) => {
      this.deprecatedCardsNotice = undefined; // try again on the next device start
      this.error('Deprecated cards notice failed:', err);
    });
    return this.deprecatedCardsNotice;
  }

  /**
   * Action cards. Each is filtered to the devices whose model and firmware support it (feature
   * markers, see lib/features.ts); the library still validates every write as a backstop.
   * Writes are retried on inverter timeouts; rejected writes surface as readable flow errors.
   */
  private registerActionCards() {
    const action = (id: string, run: (inverter: Inverter, args: CardArgs) => Promise<unknown>) => {
      this.homey.flow.getActionCard(id).registerRunListener(async (args: CardArgs) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        try {
          await withRetry(() => run(inverter, args), { homey: this.homey, log: this.log.bind(this) });
        } catch (err) {
          throw new Error(userMessage(err));
        }
      });
    };
    const sched = (inverter: Inverter): ScheduleInverter => scheduleInverter(inverter);
    const slotOf = (args: CardArgs): number => Number(args.slot?.id);

    // Slot number autocomplete: exactly the slots this inverter has
    // [card, slot kind, label, only slots with a target register]
    const slotCards: [string, 'buySlots' | 'sellSlots', string, boolean][] = [
      ['set_buy_slot', 'buySlots', 'Buy', false], ['set_buy_slot_target', 'buySlots', 'Buy', true],
      ['clear_buy_slot', 'buySlots', 'Buy', false], ['set_sell_slot', 'sellSlots', 'Sell', false],
      ['set_sell_slot_target', 'sellSlots', 'Sell', true], ['clear_sell_slot', 'sellSlots', 'Sell', false],
    ];
    for (const [id, kind, label, needsTarget] of slotCards) {
      this.homey.flow.getActionCard(id).registerArgumentAutocompleteListener('slot', async (query: string, args: Partial<CardArgs>) => {
        const inverter = args.device ? this.getInverter(args.device.getData().id) : undefined;
        if (!inverter) return [];
        const support = scheduleSupport(inverter.capabilities, inverter.layout);
        let current: { slot: number; start: string; end: string }[] = [];
        try {
          current = inverter.getData().schedules[kind === 'buySlots' ? 'charge' : 'discharge'];
        } catch {
          // No snapshot yet: list the slots without their contents
        }
        return Array.from({ length: support[kind] }, (_, i) => i + 1)
          .filter((n) => !needsTarget || slotHasTarget(support, n))
          .map((n) => {
            const s = current.find((c) => c.slot === n);
            const used = s && !(s.start === '00:00' && s.end === '00:00');
            return { id: n, name: `${label} slot ${n}`, description: used ? `${s.start}–${s.end}` : 'Empty' };
          })
          .filter((r) => r.name.toLowerCase().includes(query.toLowerCase()));
      });
    }

    action('set_buy_slot', (inv, a) => setBuySlot(sched(inv), slotOf(a), { start: a.start, end: a.end }));
    action('set_buy_slot_target', (inv, a) => setBuySlot(sched(inv), slotOf(a), { start: a.start, end: a.end, target: a.target }));
    action('clear_buy_slot', (inv, a) => clearBuySlot(sched(inv), slotOf(a)));
    action('set_charge_target', (inv, a) => setGlobalChargeTarget(sched(inv), a.target));
    action('set_sell_slot', (inv, a) => setSellSlot(sched(inv), slotOf(a), { start: a.start, end: a.end }));
    action('set_sell_slot_target', (inv, a) => setSellSlot(sched(inv), slotOf(a), { start: a.start, end: a.end, target: a.target }));
    action('clear_sell_slot', (inv, a) => clearSellSlot(sched(inv), slotOf(a)));
    action('set_pause_slot', (inv, a) => setPause(sched(inv), { mode: a.mode, start: a.start, end: a.end }));
    action('set_pause_mode', (inv, a) => setPause(sched(inv), { mode: a.mode }));
    action('clear_pause', (inv) => clearPause(sched(inv)));
    action('set_charge_power', (inv, a) => inv.setSetting('inverterChargePowerPercent', a.percent));
    action('set_discharge_power', (inv, a) => inv.setSetting('inverterDischargePowerPercent', a.percent));
    action('set_battery_reserve', (inv, a) => inv.setSetting('batteryReserve', a.percent));
    action('toggle_eco_mode', (inv, a) => requireSinglePhase(inv, 'Eco mode').setSetting('ecoMode', a.action === 'enable'));

    // Deprecated 1.x cards: hidden from new flows, still run in existing ones (lib/legacy-cards.ts)
    for (const [id, run] of Object.entries(LEGACY_CARDS)) {
      action(id, (inv, a) => run(inv as unknown as LegacyInverter, a));
    }
  }

  /**
   * Threshold cards: devices trigger both crossing cards on every change with
   * { previous, current }; each flow runs only if it crossed its own threshold.
   */
  private registerThresholdCards() {
    for (const { id, argName, hasCondition } of METRICS) {
      this.homey.flow.getDeviceTriggerCard(`${id}_rose_above`)
        .registerRunListener(async (args: CardArgs, state: Crossing) => roseAbove(state, Number(args[argName])));

      this.homey.flow.getDeviceTriggerCard(`${id}_dropped_below`)
        .registerRunListener(async (args: CardArgs, state: Crossing) => droppedBelow(state, Number(args[argName])));

      if (hasCondition) {
        this.homey.flow.getConditionCard(`${id}_above`)
          .registerRunListener(async (args: CardArgs) => {
            const value = args.device.getCapabilityValue(id);
            return typeof value === 'number' && isAbove(value, Number(args[argName]));
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

  /** For the Schedules page: every paired inverter, with its schedule when connected. */
  listSchedules(): { serial: string; name: string; model?: string; schedule: ScheduleView | null }[] {
    const devices = this.homey.drivers.getDriver('solar-inverter').getDevices();
    const names = new Map(devices.map((d) => [d.getData().id as string, d.getName()]));
    const serials = new Set([...names.keys(), ...this.connections.keys()]);
    return [...serials].sort().map((serial) => {
      const inverter = this.getInverter(serial);
      let schedule: ScheduleView | null = null;
      try {
        if (inverter) schedule = readSchedule(scheduleInverter(inverter));
      } catch {
        // No snapshot yet (still connecting)
      }
      return {
        serial, name: names.get(serial) ?? serial, model: inverter && modelName(inverter.model), schedule,
      };
    });
  }

  /** For the Schedules page: apply a whole schedule and return what the inverter now has. */
  async saveSchedule(serial: string, body: unknown): Promise<ScheduleView> {
    const inverter = this.getInverter(serial);
    if (!inverter) throw new Error('Inverter not connected');
    const desired = parseDesiredSchedule(body);
    const target = scheduleInverter(inverter);
    try {
      await withRetry(() => applySchedule(target, desired), { homey: this.homey, log: this.log.bind(this) });
    } catch (err) {
      throw new Error(userMessage(err));
    }
    this.log(`[schedule] saved for ${serial}`);
    return readSchedule(target);
  }

  getInverter(serialNumber: string): GivEnergyInverter | undefined {
    return this.connections.get(serialNumber)?.inverter;
  }
};
