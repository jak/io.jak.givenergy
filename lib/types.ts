'use strict';

// Types from the ESM-only givenergy-modbus package, bridged into this CJS app with resolution-mode.
type Lib = typeof import('givenergy-modbus', { with: { 'resolution-mode': 'import' } });

export type SinglePhaseInverter = InstanceType<Lib['SinglePhaseInverter']>;
export type ThreePhaseInverter = InstanceType<Lib['ThreePhaseInverter']>;
/** What `GivEnergyInverter.connect()` resolves to. */
export type Inverter = SinglePhaseInverter | ThreePhaseInverter;

export type InverterSnapshot = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterSnapshot;
export type InverterIdentity = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterIdentity;
export type TimeSlotInput = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).TimeSlotInput;
export type BatteryPauseInput = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).BatteryPauseInput;

/** What devices and the Web API use of the app (`this.homey.app`); app.ts implements it. */
export interface GivEnergyAppApi {
  getConnection(serialNumber: string, host: string): Promise<Inverter>;
  releaseConnection(serialNumber: string): Promise<void>;
  getInverter(serialNumber: string): Inverter | undefined;
  announceDeprecatedCards(): Promise<void>;
  listSchedules(): unknown;
  saveSchedule(serial: string, body: unknown): Promise<unknown>;
}

// Types `this.homey.app` as the GivEnergy app everywhere (see HomeyTypes in the Homey SDK types)
declare module 'homey' {
  interface HomeyTypes {
    app: GivEnergyAppApi;
  }
}

/** The pairing and repair socket Homey passes to `Driver#onPair` / `Driver#onRepair`. */
export type PairSession = Parameters<import('homey').Driver['onPair']>[0];

/** A device as flow cards receive it, from any of the three drivers. */
export interface FlowDevice {
  getData(): { id: string };
  getCapabilityValue(id: string): unknown;
  /** Solar inverter and battery devices. */
  getInverterSnapshot?(): InverterSnapshot | null;
}

/** The solar inverter's force charge/discharge, for their flow cards. */
export interface ForceControlDevice extends FlowDevice {
  forceCharge(targetSoc: number, chargeRate: number): Promise<void>;
  stopForceCharge(): Promise<void>;
  forceDischarge(dischargeRate: number, batteryReserve: number): Promise<void>;
  stopForceDischarge(): Promise<void>;
}

/**
 * Flow card arguments, as declared in .homeycompose/flow. Each card has its own subset; the named
 * ones are those of the current cards, anything else (thresholds, deprecated cards) is `unknown`.
 */
export interface CardArgs {
  device: FlowDevice;
  slot: { id: number };
  start: string;
  end: string;
  target: number;
  mode: 'off' | 'charge' | 'discharge' | 'both';
  percent: number;
  action: 'enable' | 'disable';
  target_soc: number;
  charge_rate: number;
  discharge_rate: number;
  battery_reserve: number;
  [name: string]: unknown;
}
