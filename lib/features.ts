'use strict';

/**
 * Hidden "feature marker" capabilities on the solar inverter device.
 *
 * Homey can't change a flow card's arguments per device, but it can filter cards by capability.
 * Each marker says whether this inverter's model and firmware support a feature, so a card
 * filtered on it only shows for inverters it works on.
 */

type Capabilities = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).Capabilities;

export const FEATURE_MARKERS = [
  'givenergy_slot_targets',
  'givenergy_global_target',
  'givenergy_pause_window',
  'givenergy_pause_mode_only',
  'givenergy_pause',
  'givenergy_power_percent',
  'givenergy_eco_mode',
] as const;

export type FeatureMarker = typeof FEATURE_MARKERS[number];

/** Capabilities that markers replace; removed from devices on sight. */
const RETIRED = ['inverter_gen3'];

export interface FeatureSource {
  capabilities: Capabilities;
  supports(key: 'inverterChargePowerPercent' | 'ecoMode'): boolean;
}

export function featureMarkers({ capabilities: c, supports }: FeatureSource): Record<FeatureMarker, boolean> {
  return {
    givenergy_slot_targets: c.perSlotTargets,
    givenergy_global_target: !c.perSlotTargets,
    givenergy_pause_window: c.pauseWindow,
    givenergy_pause_mode_only: c.pauseMode && !c.pauseWindow,
    givenergy_pause: c.pauseMode,
    givenergy_power_percent: supports('inverterChargePowerPercent'),
    givenergy_eco_mode: supports('ecoMode'),
  };
}

/** Which capabilities to add and remove so the device has exactly the wanted markers. */
export function markerChanges(
  wanted: Record<FeatureMarker, boolean>,
  current: readonly string[],
): { add: string[]; remove: string[] } {
  const has = new Set(current);
  const add = FEATURE_MARKERS.filter((m) => wanted[m] && !has.has(m));
  const remove = [
    ...FEATURE_MARKERS.filter((m) => !wanted[m] && has.has(m)),
    ...RETIRED.filter((m) => has.has(m)),
  ];
  return { add, remove };
}
