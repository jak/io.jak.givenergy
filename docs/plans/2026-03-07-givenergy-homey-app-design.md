# GivEnergy Homey App Design

## Overview

Homey app for GivEnergy solar inverters and batteries using the `givenergy-modbus` npm package for direct LAN communication via Modbus TCP (port 8899). No cloud account required.

## Decisions

- **Two device types per inverter**: Solar Inverter (`solarpanel`) + Battery (`battery`)
- **Multiple inverter support**: each discovered inverter gets its own device pair
- **Pairing**: auto-discover with manual IP fallback
- **Single combined battery device** per inverter (not per-module)
- **Controls**: mode, charge/discharge schedules, charge/discharge rates (no reboot, no battery reserve)

## Device: Solar Inverter

**Driver ID**: `solar-inverter`
**Device class**: `solarpanel`
**Owns** the `GivEnergyInverter` connection instance.

### Capabilities

| Capability | Source | Notes |
|---|---|---|
| `measure_power` | `snapshot.solarPower` | Negative value per Homey convention |
| `meter_power` | `snapshot.pvEnergyTotalKwh` | Cumulative solar generation |
| `measure_power.grid` | `snapshot.gridPower` | Custom; positive=export, negative=import |
| `measure_power.load` | `snapshot.loadPower` | Custom; house consumption |
| `meter_power.grid_import` | `snapshot.gridImportEnergyTotalKwh` | Custom |
| `meter_power.grid_export` | `snapshot.gridExportEnergyTotalKwh` | Custom |

### Settings / Controls

| Setting | Method | Type |
|---|---|---|
| Inverter mode | `setMode()` | dropdown: eco, timed_demand, timed_export |
| Charge schedule enabled | `setChargeScheduleEnabled()` | boolean |
| Discharge schedule enabled | `setDischargeScheduleEnabled()` | boolean |
| Charge slot 1 start/end/target | `setChargeSlot()` | time strings + number |
| Discharge slot 1 start/end/target | `setDischargeSlot()` | time strings + number |
| Charge rate | `setChargeRate()` | number (watts) |
| Discharge rate | `setDischargeRate()` | number (watts) |

### Energy config

```json
{
  "meterPowerExportedCapability": "meter_power"
}
```

## Device: Battery

**Driver ID**: `battery`
**Device class**: `battery`
**References** the solar inverter's connection via serial number.

### Capabilities

| Capability | Source | Notes |
|---|---|---|
| `measure_power` | `snapshot.batteryPower` | Positive=discharge, negative=charge (Homey inverts) |
| `measure_battery` | `snapshot.stateOfCharge` | 0-100% |
| `meter_power.charged` | `snapshot.batteryChargeEnergyTotalKwh` | Custom title |
| `meter_power.discharged` | `snapshot.batteryDischargeEnergyTotalKwh` | Custom title |
| `measure_temperature` | `snapshot.batteryTemperature` | Degrees C |

### Energy config

```json
{
  "homeBattery": true,
  "meterPowerImportedCapability": "meter_power.charged",
  "meterPowerExportedCapability": "meter_power.discharged"
}
```

## Connection Management

- `app.ts` maintains `Map<serialNumber, GivEnergyInverter>` of active connections
- Solar inverter device creates connection on `onInit()`, registers with app
- Battery device looks up connection from app by serial number in `data`
- Library handles polling (~15s snapshots); devices update on `data` event
- Connection torn down on device `onUninit()` (if no other devices reference it)

## Pairing Flow

1. **list_devices** (template) — auto-discover via `discover()`, show inverters by serial + IP
2. **manual_entry** — custom view with IP input field, probe connection, show result
3. **add_devices** (template) — confirm selection
4. On add: store `{ id: serialNumber }` in data, `{ host: ip }` in store
5. Battery pairing lists inverters that already have a solar inverter device added

## Flow Cards

### Conditions

| ID | Title |
|---|---|
| `solar_generating` | Solar is generating |
| `battery_charging` | Battery is charging |
| `battery_discharging` | Battery is discharging |
| `grid_importing` | Grid is importing |
| `grid_exporting` | Grid is exporting |

### Actions

| ID | Title | Args |
|---|---|---|
| `set_inverter_mode` | Set inverter mode | mode (dropdown) |
| `enable_charge_schedule` | Enable charge schedule | enabled (boolean) |
| `enable_discharge_schedule` | Enable discharge schedule | enabled (boolean) |
| `set_charge_rate` | Set charge rate | watts (number) |
| `set_discharge_rate` | Set discharge rate | watts (number) |

## Project Structure

```
.homeycompose/
  app.json                          # app manifest (exists)
  flow/
    conditions/                     # condition flow cards
    actions/                        # action flow cards
drivers/
  solar-inverter/
    driver.compose.json             # driver manifest
    driver.ts                       # pairing logic
    device.ts                       # connection + capability updates
    assets/images/                  # device images
    pair/
      manual_entry.html             # manual IP entry view
  battery/
    driver.compose.json             # driver manifest
    driver.ts                       # pairing logic (find existing inverters)
    device.ts                       # capability updates from shared connection
    assets/images/                  # device images
app.ts                              # connection manager
```

## Technical Notes

- Library requires Node.js 18+ (Homey Pro 2023 runs Node 18)
- Only one client should connect to a GivEnergy inverter at a time (no concurrent GivTCP)
- Snapshots arrive ~every 15 seconds automatically
- Platform: `local` only (Modbus TCP requires LAN access)
