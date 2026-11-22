import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectErrorMessage, userMessage } from '../lib/errors.ts';

function libError(name: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name }, extra);
}

test('a Gateway or EMS is explained, not reported as a connection failure', () => {
  const err = libError('UnsupportedDeviceError', 'x', { model: 'gateway', deviceTypeCode: 0x7001 });
  assert.equal(
    connectErrorMessage('10.0.0.9', err),
    'The device at 10.0.0.9 is a GivEnergy Gateway, not an inverter. Add the inverters it controls instead.',
  );
  const ems = libError('UnsupportedDeviceError', 'x', { model: 'ems', deviceTypeCode: 0x5001 });
  assert.match(connectErrorMessage('h', ems), /is a GivEnergy EMS, not an inverter/);
});

test('an unknown device type code', () => {
  const err = libError('UnsupportedDeviceError', 'x', { model: 'unknown', deviceTypeCode: 0 });
  assert.equal(
    connectErrorMessage('10.0.0.9', err),
    "The device at 10.0.0.9 isn't a GivEnergy inverter this app supports (device type code 0x0000).",
  );
});

test('other errors keep the connection-failure wording', () => {
  assert.equal(connectErrorMessage('h', new Error('timeout')), 'Could not connect to inverter at h: timeout');
});

test('userMessage explains unsupported settings', () => {
  const err = libError('UnsupportedSettingError', 'x', { key: 'ecoMode', model: 'hybrid_3ph', firmware: 1 });
  assert.equal(userMessage(err), 'Not supported on this inverter (hybrid_3ph)');
  assert.equal(userMessage(new RangeError('slot must be 1-2, got 3')), 'slot must be 1-2, got 3');
});
