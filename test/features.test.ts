import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Capabilities } from 'givenergy-modbus' with { 'resolution-mode': 'import' };
import { featureMarkers, FEATURE_MARKERS, markerChanges } from '../lib/features.ts';

const NONE: Capabilities = {
  tenSlots: false,
  perSlotTargets: false,
  pauseMode: false,
  pauseWindow: false,
  acSettingsBlock: false,
  highVoltageBattery: false,
  smartLoad: false,
};

const supportsAll = () => true;
const supportsNone = () => false;

test('ten-slot hybrid (Gen3 on new firmware): targets, pause window, power percent', () => {
  const caps = {
    ...NONE, tenSlots: true, perSlotTargets: true, pauseMode: true, pauseWindow: true, acSettingsBlock: true,
  };
  assert.deepEqual(featureMarkers({ capabilities: caps, supports: supportsAll }), {
    givenergy_slot_targets: true,
    givenergy_global_target: false,
    givenergy_pause_window: true,
    givenergy_pause_mode_only: false,
    givenergy_pause: true,
    givenergy_power_percent: true,
  });
});

test('Gen1/AC: pause mode without a window, global target', () => {
  const caps = { ...NONE, pauseMode: true };
  assert.deepEqual(featureMarkers({ capabilities: caps, supports: supportsNone }), {
    givenergy_slot_targets: false,
    givenergy_global_target: true,
    givenergy_pause_window: false,
    givenergy_pause_mode_only: true,
    givenergy_pause: true,
    givenergy_power_percent: false,
  });
});

test('three-phase: no pause at all', () => {
  const m = featureMarkers({ capabilities: NONE, supports: supportsAll });
  assert.equal(m.givenergy_pause, false);
  assert.equal(m.givenergy_pause_window, false);
  assert.equal(m.givenergy_pause_mode_only, false);
});

test('power percent follows supports("inverterChargePowerPercent")', () => {
  const seen: string[] = [];
  featureMarkers({
    capabilities: NONE,
    supports: (k) => {
      seen.push(k); return false;
    },
  });
  assert.deepEqual(seen, ['inverterChargePowerPercent']);
});

test('every marker is listed in FEATURE_MARKERS', () => {
  const m = featureMarkers({ capabilities: NONE, supports: supportsNone });
  assert.deepEqual(Object.keys(m).sort(), [...FEATURE_MARKERS].sort());
});

test('markerChanges adds missing, removes stale, and always drops inverter_gen3', () => {
  const wanted = featureMarkers({ capabilities: { ...NONE, pauseMode: true }, supports: supportsNone });
  const { add, remove } = markerChanges(wanted, ['measure_power', 'inverter_gen3', 'givenergy_slot_targets', 'givenergy_pause']);
  assert.deepEqual(add.sort(), ['givenergy_global_target', 'givenergy_pause_mode_only']);
  assert.deepEqual(remove.sort(), ['givenergy_slot_targets', 'inverter_gen3']);
});
