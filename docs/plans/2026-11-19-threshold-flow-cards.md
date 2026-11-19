# Threshold Flow Cards (issue #29)

## Goal

Add flow cards that fire once when House Load (`load_power`) or Grid Power (`grid_power`)
crosses a user-chosen threshold, plus a matching condition. While doing it, fix the existing grid
voltage/frequency threshold triggers, which don't work correctly.

## Problems with the existing voltage/frequency triggers

1. The card JSON has no `device` arg, so they are app-level cards, but the code fetches them with
   `getDeviceTriggerCard(...).trigger(this, ...)`.
2. No run listener is registered, so the user's threshold is never compared. Every flow fires on
   every rise (or fall), whatever number was entered.

## Semantics

There is one boolean per flow: `above = value > threshold`.

- **rose above**: fires when `above` goes false → true (`previous <= t && current > t`)
- **dropped below**: fires when `above` goes true → false (`previous > t && current <= t`)
- **condition "is above"**: `current > t`; Homey's `!{{is|isn't}}` gives the inverse.

The two triggers alternate strictly and match the condition exactly, so they fire once per
crossing and never fire while the value stays on one side. Nothing fires on the first reading
after start-up, because there is no previous value (the 05:30 condition backstop covers that).
There is no hysteresis, since the issue says load moves cleanly between about 1 kW and 8 kW.

## Design

- `lib/threshold.ts`: pure functions `isAbove`, `roseAbove`, `droppedBelow`, plus a `METRICS`
  table giving `{ id, argName }` for each metric (`grid_voltage`/`voltage`,
  `grid_frequency`/`frequency`, `load_power`/`power`, `grid_power`/`power`).
- **App (`app.ts`)**: loop over `METRICS` and register run listeners for
  `<id>_rose_above`, `<id>_dropped_below` (args vs. state `{previous, current}`) and the
  conditions `<id>_above` (load/grid power only; reads the device's current value).
- **Devices**: keep the last value for each metric. When a new snapshot differs from the last value,
  trigger both cards with state `{previous, current}` and a value token. Homey runs the
  per-flow run listener, which decides whether that flow has crossed its threshold. This replaces
  `fireGridQualityTriggers` in both solar-inverter and grid-meter.
- **Card JSON**:
  - voltage/frequency triggers: add `device` arg `driver_id=solar-inverter|grid-meter`
  - new `load_power_*` and `grid_power_*` triggers and conditions: `device` arg
    `driver_id=solar-inverter`
  - every trigger gets a value token
  - en/nl/af text throughout; the grid power hint explains the sign (positive means exporting).

## Breaking change

Adding the `device` arg changes the voltage/frequency cards, so existing flows that use them
need the card added again. Those flows were already firing regardless of threshold.

## Verification

1. Unit tests for `lib/threshold.ts` (`node --test`, Node 22 type stripping), covering crossings,
   staying on one side, equality at the threshold, and negative thresholds for grid power.
2. `npm run build`, `npm run lint`, `homey app validate --level publish`.
3. Live test on Homey (with the user's OK): `homey app run` and a flow with a threshold near the
   current load, then check the logs and that the flow fires once.

## Commits (branch `feature/29-threshold-flow-cards`)

1. Plan doc
2. Threshold helper and tests
3. Fix voltage/frequency triggers so they use device args and the threshold
4. Add load_power and grid_power triggers and conditions
