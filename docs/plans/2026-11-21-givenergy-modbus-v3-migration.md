# givenergy-modbus v3 migration + Buy/Sell/Pause schedules

**Goal:** Move the app to `givenergy-modbus@3.0.0` and replace the generation-based schedule cards and settings with
**Buy / Sell / Pause / Use** slots that behave like the official GivEnergy app. Ships as **2.0.0**.

**Branch:** `chore/givenergy-modbus-v3`

## Evidence: what the official app writes (captured 2026-11-21, hybrid_gen3, tenSlots)

| App slot | Writes | Library call |
|---|---|---|
| Buy | charge slot times (+ target) and HR 96 = 1 | `setChargeSlot(n, {start, end, targetStateOfCharge})` + `setSetting('acCharge', true)` |
| Sell | discharge slot times and HR 59 = 1; eco mode stays **on**, and it exports (confirmed) | `setDischargeSlot(n, {start, end})` + `setSetting('dcDischarge', true)` |
| Pause | HR 318 = 3, HR 319/320 = window | `setBatteryPause({ mode: 'both', start, end })` |
| Use | nothing (default for uncovered time) | none |
| Delete | slot times → 00:00; enable flag cleared only when no slot of that type remains | as above |

The inverter maintains its own EMS mirror in HR 483–488. A library-only write of HR 56/57/59 updated it
(verified by a write test), so the app never writes HR 48x.

Slot support comes from `inverter.capabilities`: `tenSlots` → 10 Buy + 10 Sell, otherwise 2 + 2 (three-phase:
2 + 2, no targets). Per-slot targets come from `perSlotTargets`, and the pause window from `pauseWindow`.

## Decisions (from user)

1. Watt-based `set_charge_rate` / `set_discharge_rate` are removed and replaced by new cards with new IDs.
2. Export limit: no write and no setting at all (removed from device settings).
3. Schedules are redesigned around Buy / Sell / Pause / Use; the enable flags are managed automatically only
   (no on/off toggle cards).
4. Slot editing moves to a custom **app settings page** that shows only the slots each inverter supports.
   (Homey allows custom HTML settings only at app level; the app is `platforms: ["local"]`, so it is allowed.)
5. Device settings are redesigned from scratch (below).
6. Version 2.0.0.

## Shared schedule logic: `lib/schedule.ts`

Pure functions over a small inverter interface, used by flow cards, the settings page API and force charge/discharge:

- `scheduleSupport(capabilities, layout)` → `{ buySlots, sellSlots, perSlotTargets, pause: 'window' | 'mode' | 'none' }`
- `setBuySlot(inv, slot, {start, end, target?})`: writes the slot, then `acCharge` on. Without `perSlotTargets`, the target
  goes to `acChargeUpperLimit` (global, as v2 did on Gen2).
- `clearBuySlot(inv, slot)`: times → 00:00; `acCharge` off if no Buy slot has a window left.
- `setSellSlot` / `clearSellSlot`: the same with `dcDischarge`; stop-at % only with `perSlotTargets`.
- `setPause(inv, {start, end, mode})` / `clearPause(inv)`.
- `applySchedule(inv, desired)`: diffs the desired Buy/Sell/Pause lists against `getData().schedules` and writes only the
  changes, then the enable flags last (used by the settings page Save).

## Flow cards

Cards are gated so each device only offers what its model and firmware support. Homey can't change a card's arguments
per device, but it can filter cards by capability. So the solar inverter gets hidden **feature-marker capabilities**
(boolean, `uiComponent: null`, no insights; the same pattern as the old `inverter_gen3`). They are added and removed on
init and on the first snapshot after a (re)connect, from the live `capabilities`:

| Marker | Present when |
|---|---|
| `givenergy_slot_targets` | `perSlotTargets` |
| `givenergy_global_target` | not `perSlotTargets` |
| `givenergy_pause_window` | `pauseWindow` |
| `givenergy_pause_mode_only` | `pauseMode` and not `pauseWindow` (Gen1, AC) |
| `givenergy_pause` | `pauseMode` |
| `givenergy_power_percent` | `supports('inverterChargePowerPercent')` |

**New action cards** (the slot arg is an autocomplete listing 1..N from the device's live capabilities). Every card
still validates at runtime as a backstop:

| ID | Args | Filter |
|---|---|---|
| `set_buy_slot` | slot, start, end | all |
| `set_buy_slot_target` | slot, start, end, target % | `givenergy_slot_targets` |
| `set_charge_target` | percent (`acChargeUpperLimit`, global) | `givenergy_global_target` |
| `clear_buy_slot` | slot | all |
| `set_sell_slot` | slot, start, end | all |
| `set_sell_slot_target` | slot, start, end, stop at % | `givenergy_slot_targets` |
| `clear_sell_slot` | slot | all |
| `set_pause_slot` | start, end, mode (both/charge/discharge, default both) | `givenergy_pause_window` |
| `set_pause_mode` | mode (off/charge/discharge/both) | `givenergy_pause_mode_only` |
| `clear_pause` | none | `givenergy_pause` |
| `set_charge_power` | percent 1–100 (`inverterChargePowerPercent`) | `givenergy_power_percent` |
| `set_discharge_power` | percent 1–100 (`inverterDischargePowerPercent`) | `givenergy_power_percent` |
| `set_battery_reserve` | percent 4–100 (`batteryReserve`) | all |

`set_buy_slot` without a target leaves the slot's existing target as it is. `force_charge` keeps its target arg and
writes it per-slot or globally depending on the model.

**Kept:** `toggle_eco_mode`, `force_charge` / `stop_force_charge`, `force_discharge` / `stop_force_discharge`
(ported: force = Buy/Sell slot 1 00:00–23:59 via `lib/schedule.ts`, restored on stop), all conditions and threshold triggers.

**Deprecated (see below; originally planned as removed):** `set_charge_rate`, `set_discharge_rate`, `set_export_limit`, `set_battery_pause_mode`,
`enable_discharge_schedule`, `enable_charge_schedule`, `toggle_timed_export`, `set_charge_slot`, `set_charge_slot_gen3`,
`set_discharge_slot`, `set_discharge_slot_gen3`. The `inverter_gen3` marker is removed from devices on init.

## App settings page: "Schedules" (`settings/index.html` + `api.ts`)

- `GET /inverters` → per paired inverter: serial, model, `scheduleSupport`, current Buy/Sell/Pause slots from the snapshot,
  and connected state.
- `PUT /inverters/:serial/schedule` → `applySchedule`; returns the updated schedule or a readable error
  (`RangeError`, `UnsupportedSettingError`, not connected).
- UI: an inverter picker (hidden when there is only one), then:
  - **Eco mode** toggle at the top: what "Use" time does. It is the same `ecoMode` setting as the device settings, with both
    read from the snapshot so they always agree.
  - A list ordered by start time like the official app: each row has a type badge (Buy/Sell/Pause) and start–end, with
    add/edit/delete; gaps read as "Use".
  - The page adapts entirely to `scheduleSupport`:
    - It offers only as many Buy/Sell rows as the model has.
    - The **target % column appears only with `perSlotTargets`**. Without it, there is one global "Charge target %"
      (`acChargeUpperLimit`) above the list, and Sell rows note that discharge stops at the battery reserve (shown read-only).
    - A Pause row type appears only with `pauseWindow`. With `pauseMode` alone, there is a single pause-mode selector and no
      window. Three-phase has no pause at all.
  - Client-side validation (HH:MM, no overlaps between Buy/Sell/Pause, end ≠ start), then a Save button and a reload from the
    inverter after saving. Homey CSS classes, translated en/nl/af.

## Device settings (solar inverter), redesigned

**Inverter (read-only labels)**

- Model (e.g. "Hybrid Gen3"), serial number, IP address
- Firmware (ARM / DSP)
- Schedule support (e.g. "10 Buy · 10 Sell · pause window"), plus a hint pointing to the app's Schedules page

**Battery (editable)**

- Battery reserve % (`batteryReserve`, 4–100): the level that normal use won't discharge below
- Charge power % (`inverterChargePowerPercent`, 1–100). Where `inverter.supports()` is false, edits are rejected with
  "Not supported on this inverter" (Homey can't hide a setting per device).
- Discharge power % (`inverterDischargePowerPercent`, 1–100), same treatment

**Mode (editable)**

- Eco mode (`ecoMode`): what "Use" time does (battery covers house load)

All other fields are removed: slots, schedule toggles, timed export, pause mode, export limit and model code.
Battery and grid-meter drivers have no settings and are unchanged.
`onSettings` validates with `inverter.supports(key)` and the setting ranges, then writes in the background with retry
(as today); `syncSettings` refreshes from the snapshot every 60 s.

## v3 port (mechanical)

- `package.json`: `givenergy-modbus@^3.0.0`.
- Types: `GivEnergyInverter` → `SinglePhaseInverter | ThreePhaseInverter`; snapshot renames per the migration guide.
- No `instanceof Gen3Inverter`; gate on `layout` / `capabilities` / `inverter.supports(key)`.
- Pairing/repair store `{ host, model, layout }`; existing devices refresh their store from the live inverter on init;
  the device name uses the model; `UnsupportedDeviceError` → "EMS/Gateway devices aren't supported".
- `lib/snapshot.ts`: pure snapshot → capability values per driver; `undefined` → `null` (e.g. consumption on `ac`,
  battery temperature on three-phase).
- `withRetry` doesn't retry `UnsupportedSettingError` / `RangeError`.

## Tasks (TDD, with a commit after each)

1. Bump the dependency; straight compile port (old cards still wired, minimal changes). Build, lint, tests green. Commit.
2. `lib/snapshot.ts` + tests; use it in all 3 devices and the conditions. Commit.
3. Pairing/repair/store migration, `inverter_gen3` → feature markers (`lib/features.ts` + tests: capabilities → marker
   set), `UnsupportedDeviceError`. Commit.
4. `lib/schedule.ts` + tests (fake inverter): set/clear flag rules, global-target path, pause variants, `applySchedule` diffing. Commit.
5. `withRetry` non-retryable errors + test. Commit.
6. New flow cards (JSON en/nl/af, registration, autocomplete), old cards removed, force charge/discharge ported. Commit.
7. Device settings redesign + `onSettings` / `syncSettings`. Commit.
8. `api.ts` + `settings/index.html` Schedules page. Commit.
9. 2.0.0 + changelog (removed cards → replacements; Schedules page) + README. Commit.

## Verification

- `npm run build`, `npm run lint`, `npm test` all green; `homey app validate --level publish`.
- `homey app run` against the real inverter (allow extra startup time): all 3 devices get data, device settings show
  model/firmware/support, the Schedules page lists the overnight Buy 23:30–05:30 correctly, and the slot dropdown shows 1–10.
  On your inverter the card picker shows the target variants and `set_pause_slot`, but not `set_charge_target` or
  `set_pause_mode`. The Gen2 and three-phase variants are covered by unit tests on `lib/features.ts` and `scheduleSupport`,
  since there's no hardware to test them on.
- Live write test, **only with user approval**, using windows already passed today and cleared afterwards, with register dumps
  as proof: Buy slot 2, Sell slot 1, and Pause through both a card and the Schedules page. Never touch Buy slot 1.
- Code review (superpowers:requesting-code-review) before the PR.

## Implementation notes (2026-11-21)

- Tasks 1–2 were done together: the compile fixes were mostly snapshot fields, so `lib/snapshot.ts` came first.
- Task 5 was dropped: `withRetry` already retries only timeouts, so `RangeError`/`UnsupportedSettingError` fail fast.
- An extra marker, `givenergy_eco_mode`, gates the eco mode card and condition (three-phase has no eco mode); force
  charge/discharge are gated on `givenergy_power_percent`, as they write the charge/discharge power %.
- `inverter_gen3.json` stays defined so 1.x devices load before their first init removes the capability.
- Version: left to the usual post-merge bump (the "Update Homey App Version" workflow); the PR carries the changelog.
- Right after connecting, the library can leave a slot's target out until its register block is read; a row without a
  target keeps the inverter's value, so the Schedules page and `applySchedule` handle it.
- Correction (code review): three-phase hybrids are ten-slot models in givenergy-modbus 3.0.0 (10 Buy + 10 Sell), and
  only slots 1/2 lack a target register. `scheduleSupport().noTargetSlots` carries that.
- Force charge/discharge are offered on every inverter (gating them on power % would have removed them from Gen1/2/4,
  HV, PV and Polar); the rate is written only where `supports()` allows it. Their restore state lives in the device store.
- Lint: `main` is not lint-clean (the Athom JS config can't resolve `.ts` imports); this branch adds no new rule
  violations beyond that import-resolution noise. Fixing the ESLint setup is left for its own PR.

## Deprecated 1.x cards (added 2026-11-22)

Instead of removing the 11 old cards, 2.0 keeps them with `"deprecated": true`, as Athom's breaking-changes guide
recommends: hidden from the card picker, still running in existing flows. `lib/legacy-cards.ts` runs each one as 1.x did
(the registers v2 wrote, no automatic flag changes):

- Slot cards write the slot only; a target is passed where the slot has one (v2 ignored it elsewhere), raised to v3's 4%.
- `enable_charge_schedule` → `acCharge`; `toggle_timed_export` → `dcDischarge`; `enable_discharge_schedule` → pause
  "discharge"/off (what 1.x's Gen3 code did); `set_battery_pause_mode` → pause mode only.
- Watt rates use v2's conversion: single-phase `batteryChargeRate` = W/100 (max 50), three-phase power % = W/50.
- `set_export_limit` fails with an explanation: v3 makes the export limit read-only.
- Device filters drop `capabilities=inverter_gen3`, which 2.0 removes from devices.
- Titles end "(deprecated)"; hints say the card will be removed in version 3 of the app and name the replacement.
- A one-time timeline notification (app setting `deprecatedCardsNotice`) tells users who update from 1.x. It is
  triggered by a solar inverter device whose store still has the 1.x `generation` key (checked before `syncStore()`
  removes it), so fresh installs and devices paired by 2.0 don't trigger it. It can't run from `App#onInit`: drivers
  aren't initialised yet there (`Driver Not Initialized`), which is why the first attempt posted nothing.

Verified live on 2026-11-22: the cards don't appear in the picker; an existing flow using `set_charge_slot_gen3` is not
broken and wrote HR 243–245 only (HR 96 untouched); restoring it with the same card returned every register to the
pre-test dump.
