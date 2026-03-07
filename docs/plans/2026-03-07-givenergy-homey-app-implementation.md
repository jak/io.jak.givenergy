# GivEnergy Homey App Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Homey app that connects to GivEnergy inverters over LAN, exposing solar and battery data as native Homey devices with energy dashboard integration and Flow card controls.

**Architecture:** Two Homey drivers (solar-inverter, battery) share a connection pool managed in app.ts. The givenergy-modbus library handles Modbus TCP communication with ~15s polling. Pairing uses LAN discovery with manual IP fallback.

**Tech Stack:** TypeScript, Homey SDK v3, givenergy-modbus, Homey Compose

---

### Task 1: App Connection Manager

**Files:**
- Modify: `app.ts`

**Step 1: Implement the connection manager**

Replace the skeleton `app.ts` with a connection manager that maintains a `Map<string, GivEnergyInverter>` keyed by serial number.

```typescript
'use strict';

import Homey from 'homey';
import { GivEnergyInverter } from 'givenergy-modbus';

module.exports = class GivEnergyApp extends Homey.App {
  private connections = new Map<string, { inverter: GivEnergyInverter; refCount: number }>();

  async onInit() {
    this.log('GivEnergy app initialized');
  }

  async getConnection(serialNumber: string, host: string): Promise<GivEnergyInverter> {
    const existing = this.connections.get(serialNumber);
    if (existing) {
      existing.refCount++;
      return existing.inverter;
    }

    const inverter = await GivEnergyInverter.connect({ host });
    this.connections.set(serialNumber, { inverter, refCount: 1 });
    return inverter;
  }

  async releaseConnection(serialNumber: string): Promise<void> {
    const entry = this.connections.get(serialNumber);
    if (!entry) return;

    entry.refCount--;
    if (entry.refCount <= 0) {
      await entry.inverter.stop();
      this.connections.delete(serialNumber);
    }
  }

  getInverter(serialNumber: string): GivEnergyInverter | undefined {
    return this.connections.get(serialNumber)?.inverter;
  }
};
```

**Step 2: Verify TypeScript compiles**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add app.ts
git commit -m "feat: add connection manager to app.ts"
```

---

### Task 2: Solar Inverter Driver Compose Config

**Files:**
- Create: `drivers/solar-inverter/driver.compose.json`
- Create: `.homeycompose/capabilities/measure_power.grid.json`
- Create: `.homeycompose/capabilities/measure_power.load.json`
- Create: `.homeycompose/capabilities/meter_power.grid_import.json`
- Create: `.homeycompose/capabilities/meter_power.grid_export.json`

**Step 1: Create custom capability definitions**

`.homeycompose/capabilities/measure_power.grid.json`:
```json
{
  "type": "number",
  "title": { "en": "Grid Power" },
  "units": { "en": "W" },
  "insights": true,
  "desc": { "en": "Grid power in watts. Positive = exporting, negative = importing." },
  "chartType": "spline",
  "decimals": 0,
  "getable": true,
  "setable": false,
  "icon": "/assets/capabilities/grid.svg"
}
```

`.homeycompose/capabilities/measure_power.load.json`:
```json
{
  "type": "number",
  "title": { "en": "House Load" },
  "units": { "en": "W" },
  "insights": true,
  "desc": { "en": "House power consumption in watts." },
  "chartType": "spline",
  "decimals": 0,
  "getable": true,
  "setable": false,
  "icon": "/assets/capabilities/house.svg"
}
```

`.homeycompose/capabilities/meter_power.grid_import.json`:
```json
{
  "type": "number",
  "title": { "en": "Grid Import Energy" },
  "units": { "en": "kWh" },
  "insights": true,
  "desc": { "en": "Cumulative grid import energy." },
  "chartType": "spline",
  "decimals": 2,
  "getable": true,
  "setable": false
}
```

`.homeycompose/capabilities/meter_power.grid_export.json`:
```json
{
  "type": "number",
  "title": { "en": "Grid Export Energy" },
  "units": { "en": "kWh" },
  "insights": true,
  "desc": { "en": "Cumulative grid export energy." },
  "chartType": "spline",
  "decimals": 2,
  "getable": true,
  "setable": false
}
```

**Step 2: Create the solar inverter driver compose**

`drivers/solar-inverter/driver.compose.json`:
```json
{
  "name": { "en": "Solar Inverter" },
  "class": "solarpanel",
  "capabilities": [
    "measure_power",
    "meter_power",
    "measure_power.grid",
    "measure_power.load",
    "meter_power.grid_import",
    "meter_power.grid_export"
  ],
  "capabilitiesOptions": {
    "measure_power": {
      "title": { "en": "Solar Power" }
    },
    "meter_power": {
      "title": { "en": "Solar Energy" }
    }
  },
  "energy": {
    "meterPowerExportedCapability": "meter_power"
  },
  "platforms": ["local"],
  "connectivity": ["lan"],
  "images": {
    "small": "/drivers/solar-inverter/assets/images/small.png",
    "large": "/drivers/solar-inverter/assets/images/large.png",
    "xlarge": "/drivers/solar-inverter/assets/images/xlarge.png"
  },
  "pair": [
    {
      "id": "list_devices",
      "template": "list_devices",
      "navigation": { "next": "add_devices" },
      "options": { "singular": false }
    },
    {
      "id": "add_devices",
      "template": "add_devices"
    }
  ],
  "settings": [
    {
      "type": "group",
      "label": { "en": "Inverter Mode" },
      "children": [
        {
          "id": "inverter_mode",
          "type": "dropdown",
          "label": { "en": "Mode" },
          "value": "eco",
          "values": [
            { "id": "eco", "label": { "en": "Eco" } },
            { "id": "timed_demand", "label": { "en": "Timed Demand" } },
            { "id": "timed_export", "label": { "en": "Timed Export" } }
          ]
        }
      ]
    },
    {
      "type": "group",
      "label": { "en": "Charge Schedule" },
      "children": [
        {
          "id": "charge_schedule_enabled",
          "type": "checkbox",
          "label": { "en": "Enable Charge Schedule" },
          "value": false
        },
        {
          "id": "charge_slot1_start",
          "type": "text",
          "label": { "en": "Charge Slot 1 Start (HH:MM)" },
          "value": "00:30"
        },
        {
          "id": "charge_slot1_end",
          "type": "text",
          "label": { "en": "Charge Slot 1 End (HH:MM)" },
          "value": "04:30"
        },
        {
          "id": "charge_slot1_target_soc",
          "type": "number",
          "label": { "en": "Charge Slot 1 Target SOC (%)" },
          "value": 100,
          "min": 0,
          "max": 100
        },
        {
          "id": "charge_rate",
          "type": "number",
          "label": { "en": "Charge Rate (W)" },
          "value": 2600,
          "min": 0,
          "max": 10000
        }
      ]
    },
    {
      "type": "group",
      "label": { "en": "Discharge Schedule" },
      "children": [
        {
          "id": "discharge_schedule_enabled",
          "type": "checkbox",
          "label": { "en": "Enable Discharge Schedule" },
          "value": false
        },
        {
          "id": "discharge_slot1_start",
          "type": "text",
          "label": { "en": "Discharge Slot 1 Start (HH:MM)" },
          "value": "00:00"
        },
        {
          "id": "discharge_slot1_end",
          "type": "text",
          "label": { "en": "Discharge Slot 1 End (HH:MM)" },
          "value": "00:00"
        },
        {
          "id": "discharge_slot1_target_soc",
          "type": "number",
          "label": { "en": "Discharge Slot 1 Target SOC (%)" },
          "value": 0,
          "min": 0,
          "max": 100
        },
        {
          "id": "discharge_rate",
          "type": "number",
          "label": { "en": "Discharge Rate (W)" },
          "value": 2600,
          "min": 0,
          "max": 10000
        }
      ]
    }
  ]
}
```

**Step 3: Create placeholder SVG icons for capabilities**

Create simple SVG icons at:
- `assets/capabilities/grid.svg`
- `assets/capabilities/house.svg`

Use simple monochrome SVGs (Homey convention).

**Step 4: Create placeholder device images**

Create directories and placeholder images:
- `drivers/solar-inverter/assets/images/small.png` (75x75)
- `drivers/solar-inverter/assets/images/large.png` (500x500)
- `drivers/solar-inverter/assets/images/xlarge.png` (1000x1000)

Note: For initial development, these can be simple placeholder PNGs. Replace with proper GivEnergy-branded images later.

**Step 5: Verify build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: Compiles (compose files are JSON, no TS to compile here)

**Step 6: Commit**

```bash
git add drivers/solar-inverter/driver.compose.json .homeycompose/capabilities/ assets/capabilities/ drivers/solar-inverter/assets/
git commit -m "feat: add solar inverter driver compose and custom capabilities"
```

---

### Task 3: Solar Inverter Device Implementation

**Files:**
- Create: `drivers/solar-inverter/device.ts`

**Step 1: Implement the solar inverter device**

```typescript
'use strict';

import Homey from 'homey';
import type { GivEnergyInverter, InverterSnapshot, InverterMode, TimeSlotInput } from 'givenergy-modbus';

module.exports = class SolarInverterDevice extends Homey.Device {
  private inverter?: GivEnergyInverter;
  private dataHandler?: (snapshot: InverterSnapshot) => void;

  async onInit() {
    const { host } = this.getStore();
    const { id: serialNumber } = this.getData();

    try {
      this.inverter = await (this.homey.app as any).getConnection(serialNumber, host);
    } catch (err) {
      this.setUnavailable(`Cannot connect to inverter at ${host}`).catch(this.error);
      return;
    }

    this.setAvailable().catch(this.error);

    this.dataHandler = (snapshot: InverterSnapshot) => {
      this.updateCapabilities(snapshot);
    };

    this.inverter.on('data', this.dataHandler);

    this.inverter.on('lost', () => {
      this.setUnavailable('Connection to inverter lost').catch(this.error);
    });

    // Set initial values from current data
    try {
      const snapshot = this.inverter.getData();
      this.updateCapabilities(snapshot);
    } catch {
      // No data yet, will update on first 'data' event
    }
  }

  private updateCapabilities(snapshot: InverterSnapshot) {
    this.setAvailable().catch(this.error);

    // Solar power — negative for Homey solarpanel convention
    this.setCapabilityValue('measure_power', -snapshot.solarPower).catch(this.error);
    this.setCapabilityValue('meter_power', snapshot.pvEnergyTotalKwh).catch(this.error);

    // Grid power
    this.setCapabilityValue('measure_power.grid', snapshot.gridPower).catch(this.error);

    // Load power
    this.setCapabilityValue('measure_power.load', snapshot.loadPower).catch(this.error);

    // Grid energy
    this.setCapabilityValue('meter_power.grid_import', snapshot.gridImportEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('meter_power.grid_export', snapshot.gridExportEnergyTotalKwh).catch(this.error);
  }

  async onSettings({ newSettings, changedKeys }: { newSettings: Record<string, any>; changedKeys: string[] }) {
    if (!this.inverter) throw new Error('Not connected to inverter');

    for (const key of changedKeys) {
      switch (key) {
        case 'inverter_mode':
          await this.inverter.setMode(newSettings.inverter_mode as InverterMode);
          break;
        case 'charge_schedule_enabled':
          await this.inverter.setChargeScheduleEnabled(newSettings.charge_schedule_enabled);
          break;
        case 'discharge_schedule_enabled':
          await this.inverter.setDischargeScheduleEnabled(newSettings.discharge_schedule_enabled);
          break;
        case 'charge_rate':
          await this.inverter.setChargeRate(newSettings.charge_rate);
          break;
        case 'discharge_rate':
          await this.inverter.setDischargeRate(newSettings.discharge_rate);
          break;
        case 'charge_slot1_start':
        case 'charge_slot1_end':
        case 'charge_slot1_target_soc': {
          const config: TimeSlotInput = {
            start: newSettings.charge_slot1_start,
            end: newSettings.charge_slot1_end,
            targetStateOfCharge: newSettings.charge_slot1_target_soc,
          };
          await this.inverter.setChargeSlot(0, config);
          break;
        }
        case 'discharge_slot1_start':
        case 'discharge_slot1_end':
        case 'discharge_slot1_target_soc': {
          const config: TimeSlotInput = {
            start: newSettings.discharge_slot1_start,
            end: newSettings.discharge_slot1_end,
            targetStateOfCharge: newSettings.discharge_slot1_target_soc,
          };
          await this.inverter.setDischargeSlot(0, config);
          break;
        }
      }
    }
  }

  async onUninit() {
    if (this.inverter && this.dataHandler) {
      this.inverter.removeListener('data', this.dataHandler);
    }
    const { id: serialNumber } = this.getData();
    await (this.homey.app as any).releaseConnection(serialNumber);
  }
};
```

**Step 2: Verify build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add drivers/solar-inverter/device.ts
git commit -m "feat: implement solar inverter device with capability updates and settings"
```

---

### Task 4: Solar Inverter Driver — Pairing (Discovery + Manual)

**Files:**
- Create: `drivers/solar-inverter/driver.ts`

**Step 1: Implement the driver with discovery and manual IP pairing**

```typescript
'use strict';

import Homey from 'homey';
import { discover, GivEnergyInverter } from 'givenergy-modbus';

module.exports = class SolarInverterDriver extends Homey.Driver {

  async onInit() {
    this.log('SolarInverterDriver initialized');
  }

  async onPairListDevices() {
    const discovered = await discover();

    const devices = await Promise.all(
      discovered.map(async (d) => {
        try {
          const inverter = await GivEnergyInverter.connect({ host: d.host });
          const snapshot = inverter.getData();
          const name = `GivEnergy ${snapshot.serialNumber}`;
          const device = {
            name,
            data: { id: snapshot.serialNumber },
            store: { host: d.host },
          };
          await inverter.stop();
          return device;
        } catch {
          return null;
        }
      })
    );

    return devices.filter((d): d is NonNullable<typeof d> => d !== null);
  }

  async onPair(session: any) {
    // Handle manual IP entry
    session.setHandler('manual_entry', async (data: { host: string }) => {
      const { host } = data;
      const inverter = await GivEnergyInverter.connect({ host });
      const snapshot = inverter.getData();
      const device = {
        name: `GivEnergy ${snapshot.serialNumber}`,
        data: { id: snapshot.serialNumber },
        store: { host },
      };
      await inverter.stop();
      return device;
    });
  }
};
```

**Step 2: Verify build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add drivers/solar-inverter/driver.ts
git commit -m "feat: implement solar inverter driver with discovery and manual pairing"
```

---

### Task 5: Battery Driver Compose Config

**Files:**
- Create: `drivers/battery/driver.compose.json`

**Step 1: Create the battery driver compose**

`drivers/battery/driver.compose.json`:
```json
{
  "name": { "en": "Battery" },
  "class": "battery",
  "capabilities": [
    "measure_power",
    "measure_battery",
    "meter_power.charged",
    "meter_power.discharged",
    "measure_temperature"
  ],
  "capabilitiesOptions": {
    "measure_power": {
      "title": { "en": "Battery Power" }
    },
    "meter_power.charged": {
      "title": { "en": "Charged Energy" }
    },
    "meter_power.discharged": {
      "title": { "en": "Discharged Energy" }
    }
  },
  "energy": {
    "homeBattery": true,
    "meterPowerImportedCapability": "meter_power.charged",
    "meterPowerExportedCapability": "meter_power.discharged"
  },
  "platforms": ["local"],
  "connectivity": ["lan"],
  "images": {
    "small": "/drivers/battery/assets/images/small.png",
    "large": "/drivers/battery/assets/images/large.png",
    "xlarge": "/drivers/battery/assets/images/xlarge.png"
  },
  "pair": [
    {
      "id": "list_devices",
      "template": "list_devices",
      "navigation": { "next": "add_devices" },
      "options": { "singular": false }
    },
    {
      "id": "add_devices",
      "template": "add_devices"
    }
  ]
}
```

**Step 2: Create placeholder device images**

Create directories and placeholder images:
- `drivers/battery/assets/images/small.png` (75x75)
- `drivers/battery/assets/images/large.png` (500x500)
- `drivers/battery/assets/images/xlarge.png` (1000x1000)

**Step 3: Commit**

```bash
git add drivers/battery/
git commit -m "feat: add battery driver compose config"
```

---

### Task 6: Battery Device and Driver Implementation

**Files:**
- Create: `drivers/battery/device.ts`
- Create: `drivers/battery/driver.ts`

**Step 1: Implement the battery device**

`drivers/battery/device.ts`:
```typescript
'use strict';

import Homey from 'homey';
import type { GivEnergyInverter, InverterSnapshot } from 'givenergy-modbus';

module.exports = class BatteryDevice extends Homey.Device {
  private inverter?: GivEnergyInverter;
  private dataHandler?: (snapshot: InverterSnapshot) => void;

  async onInit() {
    const { host } = this.getStore();
    const { id: serialNumber } = this.getData();

    try {
      this.inverter = await (this.homey.app as any).getConnection(serialNumber, host);
    } catch (err) {
      this.setUnavailable(`Cannot connect to inverter at ${host}`).catch(this.error);
      return;
    }

    this.setAvailable().catch(this.error);

    this.dataHandler = (snapshot: InverterSnapshot) => {
      this.updateCapabilities(snapshot);
    };

    this.inverter.on('data', this.dataHandler);

    this.inverter.on('lost', () => {
      this.setUnavailable('Connection to inverter lost').catch(this.error);
    });

    try {
      const snapshot = this.inverter.getData();
      this.updateCapabilities(snapshot);
    } catch {
      // No data yet
    }
  }

  private updateCapabilities(snapshot: InverterSnapshot) {
    this.setAvailable().catch(this.error);

    this.setCapabilityValue('measure_power', snapshot.batteryPower).catch(this.error);
    this.setCapabilityValue('measure_battery', snapshot.stateOfCharge).catch(this.error);
    this.setCapabilityValue('meter_power.charged', snapshot.batteryChargeEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('meter_power.discharged', snapshot.batteryDischargeEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('measure_temperature', snapshot.batteryTemperature).catch(this.error);
  }

  async onUninit() {
    if (this.inverter && this.dataHandler) {
      this.inverter.removeListener('data', this.dataHandler);
    }
    const { id: serialNumber } = this.getData();
    await (this.homey.app as any).releaseConnection(serialNumber);
  }
};
```

**Step 2: Implement the battery driver**

`drivers/battery/driver.ts`:
```typescript
'use strict';

import Homey from 'homey';

module.exports = class BatteryDriver extends Homey.Driver {

  async onInit() {
    this.log('BatteryDriver initialized');
  }

  async onPairListDevices() {
    // List inverters that already have a solar-inverter device paired
    const solarDriver = this.homey.drivers.getDriver('solar-inverter');
    const solarDevices = solarDriver.getDevices();

    return solarDevices.map((device) => {
      const { id: serialNumber } = device.getData();
      const { host } = device.getStore();
      return {
        name: `GivEnergy Battery (${serialNumber})`,
        data: { id: serialNumber },
        store: { host },
      };
    });
  }
};
```

**Step 3: Verify build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: Compiles without errors

**Step 4: Commit**

```bash
git add drivers/battery/device.ts drivers/battery/driver.ts
git commit -m "feat: implement battery device and driver"
```

---

### Task 7: Flow Cards — Conditions

**Files:**
- Create: `.homeycompose/flow/conditions/solar_generating.json`
- Create: `.homeycompose/flow/conditions/battery_charging.json`
- Create: `.homeycompose/flow/conditions/battery_discharging.json`
- Create: `.homeycompose/flow/conditions/grid_importing.json`
- Create: `.homeycompose/flow/conditions/grid_exporting.json`
- Modify: `drivers/solar-inverter/device.ts` (register condition listeners)

**Step 1: Create condition card definitions**

`.homeycompose/flow/conditions/solar_generating.json`:
```json
{
  "title": { "en": "Solar is generating" },
  "hint": { "en": "True when solar panels are producing power." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter"
    }
  ]
}
```

`.homeycompose/flow/conditions/battery_charging.json`:
```json
{
  "title": { "en": "Battery is charging" },
  "hint": { "en": "True when the battery is being charged." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=battery"
    }
  ]
}
```

`.homeycompose/flow/conditions/battery_discharging.json`:
```json
{
  "title": { "en": "Battery is discharging" },
  "hint": { "en": "True when the battery is being discharged." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=battery"
    }
  ]
}
```

`.homeycompose/flow/conditions/grid_importing.json`:
```json
{
  "title": { "en": "Grid is importing" },
  "hint": { "en": "True when importing power from the grid." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter"
    }
  ]
}
```

`.homeycompose/flow/conditions/grid_exporting.json`:
```json
{
  "title": { "en": "Grid is exporting" },
  "hint": { "en": "True when exporting power to the grid." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter"
    }
  ]
}
```

**Step 2: Register condition listeners in app.ts**

Add to the `onInit()` method of `app.ts`:

```typescript
async onInit() {
  this.log('GivEnergy app initialized');

  // Condition cards
  this.homey.flow.getConditionCard('solar_generating')
    .registerRunListener(async (args) => {
      const snapshot = args.device.getInverterSnapshot();
      return snapshot ? snapshot.solarPower > 0 : false;
    });

  this.homey.flow.getConditionCard('battery_charging')
    .registerRunListener(async (args) => {
      const snapshot = args.device.getInverterSnapshot();
      return snapshot ? snapshot.batteryPower < 0 : false;
    });

  this.homey.flow.getConditionCard('battery_discharging')
    .registerRunListener(async (args) => {
      const snapshot = args.device.getInverterSnapshot();
      return snapshot ? snapshot.batteryPower > 0 : false;
    });

  this.homey.flow.getConditionCard('grid_importing')
    .registerRunListener(async (args) => {
      const snapshot = args.device.getInverterSnapshot();
      return snapshot ? snapshot.gridPower < 0 : false;
    });

  this.homey.flow.getConditionCard('grid_exporting')
    .registerRunListener(async (args) => {
      const snapshot = args.device.getInverterSnapshot();
      return snapshot ? snapshot.gridPower > 0 : false;
    });
}
```

**Step 3: Add `getInverterSnapshot()` helper to both device classes**

Add this method to both `SolarInverterDevice` and `BatteryDevice`:

```typescript
getInverterSnapshot(): InverterSnapshot | null {
  try {
    return this.inverter?.getData() ?? null;
  } catch {
    return null;
  }
}
```

**Step 4: Verify build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: Compiles without errors

**Step 5: Commit**

```bash
git add .homeycompose/flow/conditions/ app.ts drivers/solar-inverter/device.ts drivers/battery/device.ts
git commit -m "feat: add flow condition cards for solar, battery, and grid"
```

---

### Task 8: Flow Cards — Actions

**Files:**
- Create: `.homeycompose/flow/actions/set_inverter_mode.json`
- Create: `.homeycompose/flow/actions/enable_charge_schedule.json`
- Create: `.homeycompose/flow/actions/enable_discharge_schedule.json`
- Create: `.homeycompose/flow/actions/set_charge_rate.json`
- Create: `.homeycompose/flow/actions/set_discharge_rate.json`
- Modify: `app.ts` (register action listeners)

**Step 1: Create action card definitions**

`.homeycompose/flow/actions/set_inverter_mode.json`:
```json
{
  "title": { "en": "Set inverter mode" },
  "titleFormatted": { "en": "Set inverter mode to [[mode]]" },
  "hint": { "en": "Changes the inverter operating mode." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter"
    },
    {
      "type": "dropdown",
      "name": "mode",
      "title": { "en": "Mode" },
      "values": [
        { "id": "eco", "title": { "en": "Eco" } },
        { "id": "timed_demand", "title": { "en": "Timed Demand" } },
        { "id": "timed_export", "title": { "en": "Timed Export" } }
      ]
    }
  ]
}
```

`.homeycompose/flow/actions/enable_charge_schedule.json`:
```json
{
  "title": { "en": "Enable or disable charge schedule" },
  "titleFormatted": { "en": "[[action]] charge schedule" },
  "hint": { "en": "Enables or disables the battery charge schedule." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter"
    },
    {
      "type": "dropdown",
      "name": "action",
      "title": { "en": "Action" },
      "values": [
        { "id": "enable", "title": { "en": "Enable" } },
        { "id": "disable", "title": { "en": "Disable" } }
      ]
    }
  ]
}
```

`.homeycompose/flow/actions/enable_discharge_schedule.json`:
```json
{
  "title": { "en": "Enable or disable discharge schedule" },
  "titleFormatted": { "en": "[[action]] discharge schedule" },
  "hint": { "en": "Enables or disables the battery discharge schedule." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter"
    },
    {
      "type": "dropdown",
      "name": "action",
      "title": { "en": "Action" },
      "values": [
        { "id": "enable", "title": { "en": "Enable" } },
        { "id": "disable", "title": { "en": "Disable" } }
      ]
    }
  ]
}
```

`.homeycompose/flow/actions/set_charge_rate.json`:
```json
{
  "title": { "en": "Set charge rate" },
  "titleFormatted": { "en": "Set charge rate to [[watts]] W" },
  "hint": { "en": "Sets the battery charge rate in watts." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter"
    },
    {
      "type": "number",
      "name": "watts",
      "title": { "en": "Watts" },
      "min": 0,
      "max": 10000,
      "step": 100
    }
  ]
}
```

`.homeycompose/flow/actions/set_discharge_rate.json`:
```json
{
  "title": { "en": "Set discharge rate" },
  "titleFormatted": { "en": "Set discharge rate to [[watts]] W" },
  "hint": { "en": "Sets the battery discharge rate in watts." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter"
    },
    {
      "type": "number",
      "name": "watts",
      "title": { "en": "Watts" },
      "min": 0,
      "max": 10000,
      "step": 100
    }
  ]
}
```

**Step 2: Register action listeners in app.ts**

Add to the `onInit()` method of `app.ts`, after the condition card registrations:

```typescript
// Action cards
this.homey.flow.getActionCard('set_inverter_mode')
  .registerRunListener(async (args) => {
    const inverter = this.getInverter(args.device.getData().id);
    if (!inverter) throw new Error('Inverter not connected');
    await inverter.setMode(args.mode);
  });

this.homey.flow.getActionCard('enable_charge_schedule')
  .registerRunListener(async (args) => {
    const inverter = this.getInverter(args.device.getData().id);
    if (!inverter) throw new Error('Inverter not connected');
    await inverter.setChargeScheduleEnabled(args.action === 'enable');
  });

this.homey.flow.getActionCard('enable_discharge_schedule')
  .registerRunListener(async (args) => {
    const inverter = this.getInverter(args.device.getData().id);
    if (!inverter) throw new Error('Inverter not connected');
    await inverter.setDischargeScheduleEnabled(args.action === 'enable');
  });

this.homey.flow.getActionCard('set_charge_rate')
  .registerRunListener(async (args) => {
    const inverter = this.getInverter(args.device.getData().id);
    if (!inverter) throw new Error('Inverter not connected');
    await inverter.setChargeRate(args.watts);
  });

this.homey.flow.getActionCard('set_discharge_rate')
  .registerRunListener(async (args) => {
    const inverter = this.getInverter(args.device.getData().id);
    if (!inverter) throw new Error('Inverter not connected');
    await inverter.setDischargeRate(args.watts);
  });
```

**Step 3: Verify build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: Compiles without errors

**Step 4: Commit**

```bash
git add .homeycompose/flow/actions/ app.ts
git commit -m "feat: add flow action cards for inverter mode, schedules, and rates"
```

---

### Task 9: App Images and Final Polish

**Files:**
- Create: `assets/images/small.png` (75x75)
- Create: `assets/images/large.png` (500x500)
- Create: `assets/images/xlarge.png` (1000x1000)
- Modify: `.homeycompose/app.json` (add brandColor)

**Step 1: Add brand color to app manifest**

Add `"brandColor": "#003DA5"` (GivEnergy blue) to `.homeycompose/app.json`.

**Step 2: Generate app images**

Create simple branded images at the required sizes. These can be generated from the existing `assets/icon.svg`.

**Step 3: Final build and verify**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: Full build succeeds, `.homeybuild/` directory contains all compiled output

**Step 4: Commit**

```bash
git add assets/images/ .homeycompose/app.json
git commit -m "feat: add app images and brand color"
```

---

### Task 10: Validate with Homey CLI

**Step 1: Install Homey CLI if needed**

Run: `npm install -g homey`

**Step 2: Validate the app**

Run: `cd /Users/jak/Code/io.jak.givenergy && homey app validate`
Expected: Validation passes with no errors

**Step 3: Fix any validation issues**

Address any issues reported by the validator.

**Step 4: Final commit**

```bash
git add -A
git commit -m "fix: resolve homey app validation issues"
```
