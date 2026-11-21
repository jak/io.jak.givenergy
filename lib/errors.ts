'use strict';

/**
 * User-facing wording for givenergy-modbus errors. Matched on `name`, as the error classes live
 * in the ESM-only library and `instanceof` would need a dynamic import at every call site.
 */

interface LibError extends Error {
  model?: string;
  deviceTypeCode?: number;
}

const CONTROLLER_NAMES: Record<string, string> = { ems: 'EMS', gateway: 'Gateway' };

/** For pairing and repair: why the device at `host` can't be added. */
export function connectErrorMessage(host: string, err: unknown): string {
  const e = err as LibError;
  if (e?.name === 'UnsupportedDeviceError') {
    const controller = CONTROLLER_NAMES[e.model ?? ''];
    if (controller) {
      return `The device at ${host} is a GivEnergy ${controller}, not an inverter. Add the inverters it controls instead.`;
    }
    const code = `0x${(e.deviceTypeCode ?? 0).toString(16).padStart(4, '0')}`;
    return `The device at ${host} isn't a GivEnergy inverter this app supports (device type code ${code}).`;
  }
  return `Could not connect to inverter at ${host}: ${e?.message ?? err}`;
}

/** For flow cards and settings: a readable message for a rejected write. */
export function userMessage(err: unknown): string {
  const e = err as LibError;
  if (e?.name === 'UnsupportedSettingError') return `Not supported on this inverter (${e.model})`;
  return e?.message ?? String(err);
}
