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
