# Multi-Slot Charge/Discharge Schedules

Issue: #12

## Summary

Expand device settings and flow action cards to support configuring multiple charge/discharge schedule slots. Currently only slot 1 is configurable. Gen3 inverters support up to 10 slots, Gen2 supports 1 charge slot and 2 discharge slots.

We support slots 1-3 to cover most use cases without overwhelming the UI.

## Device Settings

All generations share one driver. Settings define charge slots 1-3 and discharge slots 1-3, each with start time, end time, and target SOC fields.

### Gen3 Behaviour

All 3 charge and 3 discharge slots are fully functional. Values sync from the inverter snapshot every 60 seconds and are editable by the user.

### Gen2 Behaviour (includes Gen1)

- **Charge slot 1**: fully functional
- **Charge slots 2-3**: time fields set to "Unsupported", SOC at default. `onSettings` throws a descriptive error if the user tries to change them.
- **Discharge slots 1-2**: fully functional
- **Discharge slot 3**: time fields set to "Unsupported", SOC at default. `onSettings` throws a descriptive error if the user tries to change it.

## Flow Action Cards

A virtual `inverter_gen3` capability (no UI widget) is added to Gen3 devices during `onInit()` based on the snapshot generation field. This enables capability-based card filtering.

### Gen2 Cards (available to all devices)

- **`set_charge_slot`** — args: device, start time, end time. Always operates on slot 1.
- **`set_discharge_slot`** — args: device, slot (dropdown: 1-2), start time, end time.

### Gen3 Cards (filtered: `capabilities=inverter_gen3`)

- **`set_charge_slot_gen3`** — args: device, slot (dropdown: 1-3), start time, end time, target SOC (0-100%).
- **`set_discharge_slot_gen3`** — args: device, slot (dropdown: 1-3), start time, end time, target SOC (0-100%).

Gen3 devices see both Gen2 and Gen3 cards. The Gen3-specific cards are preferred since they include target SOC.

## Settings Sync

`syncSettings` reads `chargeSlots[0..2]` and `dischargeSlots[0..2]` from the snapshot.

- Gen3: all values synced directly.
- Gen2: supported slots synced; unsupported slot time fields set to "Unsupported".

## onSettings Handler

Handles slot 2 and 3 key groups the same as slot 1. Validates generation support and throws a clear error for unsupported combinations (e.g., "Charge slot 2 is not supported on Gen2 inverters").

## Future Considerations

Long-term, Gen2 and Gen3 should be separate drivers since their state and functionality differ significantly. This design works within the single-driver constraint and can be refactored when that split happens.
