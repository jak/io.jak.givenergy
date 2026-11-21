'use strict';

/**
 * v2 battery pause-mode ids, still used by the 1.x pause card and device setting → v3 modes.
 * Removed with those in 2.0.0.
 */
export const LEGACY_PAUSE_MODES: Record<string, 'off' | 'charge' | 'discharge' | 'both'> = {
  disabled: 'off', pause_charge: 'charge', pause_discharge: 'discharge', pause_both: 'both',
};

export const PAUSE_MODE_TO_LEGACY: Record<string, string> = {
  off: 'disabled', charge: 'pause_charge', discharge: 'pause_discharge', both: 'pause_both',
};
