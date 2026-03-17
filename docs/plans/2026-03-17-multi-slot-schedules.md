# Multi-Slot Charge/Discharge Schedules Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support configuring charge/discharge schedule slots 1-3 via device settings and flow action cards, with generation-appropriate UI filtering.

**Architecture:** Add slot 2-3 settings to the existing driver compose, add a virtual `inverter_gen3` capability for flow card filtering, create separate Gen2/Gen3 flow action cards for slot configuration, and update the device sync/settings handlers.

**Tech Stack:** Homey Apps SDK, TypeScript, givenergy-modbus library

---

### Task 1: Add `inverter_gen3` virtual capability

**Files:**
- Create: `.homeycompose/capabilities/inverter_gen3.json`
- Modify: `drivers/solar-inverter/device.ts:44-48`

**Step 1: Create the capability definition**

Create `.homeycompose/capabilities/inverter_gen3.json`:
```json
{
  "type": "boolean",
  "title": { "en": "Gen3 Inverter" },
  "getable": true,
  "setable": false,
  "uiComponent": null,
  "insights": false
}
```

`uiComponent: null` hides it from the device UI. It exists solely for flow card filtering.

**Step 2: Add capability to Gen3 devices in onInit**

In `drivers/solar-inverter/device.ts`, after the existing capability migration loop (line 42), add:

```typescript
// Add Gen3 capability for flow card filtering (must happen before first data event)
const generation = this.getStore().generation;
if (generation === 'gen3') {
  if (!this.hasCapability('inverter_gen3')) {
    await this.addCapability('inverter_gen3').catch(this.error);
  }
} else {
  // Remove if device was previously Gen3 (shouldn't happen, but be safe)
  if (this.hasCapability('inverter_gen3')) {
    await this.removeCapability('inverter_gen3').catch(this.error);
  }
}
```

**Step 3: Compile and verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add .homeycompose/capabilities/inverter_gen3.json drivers/solar-inverter/device.ts
git commit -m "feat: add inverter_gen3 virtual capability for flow card filtering"
```

---

### Task 2: Add slot 2-3 device settings

**Files:**
- Modify: `drivers/solar-inverter/driver.compose.json:88-167`

**Step 1: Add charge slots 2-3 settings**

In `driver.compose.json`, add after the `charge_rate` setting (line 125) within the Charge Schedule group children array:

```json
{
  "id": "charge_slot2_start",
  "type": "text",
  "label": { "en": "Charge Slot 2 Start (HH:MM)" },
  "value": "00:00"
},
{
  "id": "charge_slot2_end",
  "type": "text",
  "label": { "en": "Charge Slot 2 End (HH:MM)" },
  "value": "00:00"
},
{
  "id": "charge_slot2_target_soc",
  "type": "number",
  "label": { "en": "Charge Slot 2 Target SOC (%)" },
  "value": 100,
  "min": 0,
  "max": 100
},
{
  "id": "charge_slot3_start",
  "type": "text",
  "label": { "en": "Charge Slot 3 Start (HH:MM)" },
  "value": "00:00"
},
{
  "id": "charge_slot3_end",
  "type": "text",
  "label": { "en": "Charge Slot 3 End (HH:MM)" },
  "value": "00:00"
},
{
  "id": "charge_slot3_target_soc",
  "type": "number",
  "label": { "en": "Charge Slot 3 Target SOC (%)" },
  "value": 100,
  "min": 0,
  "max": 100
}
```

**Step 2: Add discharge slots 2-3 settings**

In `driver.compose.json`, add after the `discharge_rate` setting (line 165) within the Discharge Schedule group children array:

```json
{
  "id": "discharge_slot2_start",
  "type": "text",
  "label": { "en": "Discharge Slot 2 Start (HH:MM)" },
  "value": "00:00"
},
{
  "id": "discharge_slot2_end",
  "type": "text",
  "label": { "en": "Discharge Slot 2 End (HH:MM)" },
  "value": "00:00"
},
{
  "id": "discharge_slot2_target_soc",
  "type": "number",
  "label": { "en": "Discharge Slot 2 Target SOC (%)" },
  "value": 0,
  "min": 0,
  "max": 100
},
{
  "id": "discharge_slot3_start",
  "type": "text",
  "label": { "en": "Discharge Slot 3 Start (HH:MM)" },
  "value": "00:00"
},
{
  "id": "discharge_slot3_end",
  "type": "text",
  "label": { "en": "Discharge Slot 3 End (HH:MM)" },
  "value": "00:00"
},
{
  "id": "discharge_slot3_target_soc",
  "type": "number",
  "label": { "en": "Discharge Slot 3 Target SOC (%)" },
  "value": 0,
  "min": 0,
  "max": 100
}
```

**Step 3: Commit**

```bash
git add drivers/solar-inverter/driver.compose.json
git commit -m "feat: add charge/discharge slot 2-3 device settings"
```

---

### Task 3: Update syncSettings for multi-slot support

**Files:**
- Modify: `drivers/solar-inverter/device.ts:112-142`

**Step 1: Update syncSettings to read slots 0-2 and handle Gen2 "Unsupported"**

Replace the `syncSettings` method body with:

```typescript
private syncSettings(snapshot: InverterSnapshot) {
  const now = Date.now();
  if (now - this.lastSettingsSyncMs < 60_000) return;
  this.lastSettingsSyncMs = now;

  const cs = snapshot.chargeSlots;
  const ds = snapshot.dischargeSlots;
  const isGen3 = snapshot.generation === 'gen3';

  const settings: Record<string, any> = {
    eco_mode: snapshot.ecoMode,
    timed_export: snapshot.timedExport,
    charge_schedule_enabled: snapshot.timedCharge,

    // Charge slot 1 — all generations
    charge_slot1_start: cs[0]?.start ?? '00:00',
    charge_slot1_end: cs[0]?.end ?? '00:00',

    // Charge slots 2-3 — Gen3 only, "Unsupported" on Gen2
    charge_slot2_start: isGen3 ? (cs[1]?.start ?? '00:00') : 'Unsupported',
    charge_slot2_end: isGen3 ? (cs[1]?.end ?? '00:00') : 'Unsupported',
    charge_slot3_start: isGen3 ? (cs[2]?.start ?? '00:00') : 'Unsupported',
    charge_slot3_end: isGen3 ? (cs[2]?.end ?? '00:00') : 'Unsupported',

    // Discharge slot 1 — all generations
    discharge_slot1_start: ds[0]?.start ?? '00:00',
    discharge_slot1_end: ds[0]?.end ?? '00:00',

    // Discharge slot 2 — Gen2 supports 2 discharge slots
    discharge_slot2_start: ds[1]?.start ?? '00:00',
    discharge_slot2_end: ds[1]?.end ?? '00:00',

    // Discharge slot 3 — Gen3 only
    discharge_slot3_start: isGen3 ? (ds[2]?.start ?? '00:00') : 'Unsupported',
    discharge_slot3_end: isGen3 ? (ds[2]?.end ?? '00:00') : 'Unsupported',

    charge_rate: snapshot.chargeRatePercent,
    discharge_rate: snapshot.dischargeRatePercent,
  };

  if (isGen3) {
    settings.charge_slot1_target_soc = (cs[0] as any)?.targetStateOfCharge ?? 100;
    settings.charge_slot2_target_soc = (cs[1] as any)?.targetStateOfCharge ?? 100;
    settings.charge_slot3_target_soc = (cs[2] as any)?.targetStateOfCharge ?? 100;
    settings.discharge_slot1_target_soc = (ds[0] as any)?.targetStateOfCharge ?? 0;
    settings.discharge_slot2_target_soc = (ds[1] as any)?.targetStateOfCharge ?? 0;
    settings.discharge_slot3_target_soc = (ds[2] as any)?.targetStateOfCharge ?? 0;
    settings.battery_pause_mode = snapshot.batteryPauseMode;
  } else {
    settings.charge_slot1_target_soc = snapshot.chargeTargetStateOfCharge;
  }

  this.setSettings(settings).catch(this.error);
}
```

**Step 2: Compile and verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add drivers/solar-inverter/device.ts
git commit -m "feat: sync charge/discharge slots 1-3 from inverter snapshot"
```

---

### Task 4: Update onSettings handler for multi-slot writes

**Files:**
- Modify: `drivers/solar-inverter/device.ts:232-302`

**Step 1: Refactor onSettings to handle slots 1-3**

Replace the `onSettings` method with a version that handles all three slots. The key changes:
- Add helper to build slot config and call the appropriate API method
- Add Gen2 validation for unsupported slots
- Use a loop pattern for the three charge and three discharge slots

```typescript
async onSettings({ newSettings, changedKeys }: { newSettings: Record<string, any>; changedKeys: string[] }) {
  if (!this.inverter) throw new Error('Not connected to inverter');

  const handled = new Set<string>();

  const handleChargeSlot = async (slot: number) => {
    const prefix = `charge_slot${slot}`;
    const keys = [`${prefix}_start`, `${prefix}_end`, `${prefix}_target_soc`];
    keys.forEach((k) => handled.add(k));

    // Gen2: only slot 1 supported
    if (slot > 1) {
      const snapshot = this.inverter!.getData();
      if (snapshot.generation !== 'gen3') {
        throw new Error(`Charge slot ${slot} is not supported on Gen2 inverters`);
      }
    }

    const config: TimeSlotInput = {
      start: newSettings[`${prefix}_start`],
      end: newSettings[`${prefix}_end`],
      targetStateOfCharge: newSettings[`${prefix}_target_soc`],
    };
    await this.inverter!.setChargeSlot(slot, config);
  };

  const handleDischargeSlot = async (slot: number) => {
    const prefix = `discharge_slot${slot}`;
    const keys = [`${prefix}_start`, `${prefix}_end`, `${prefix}_target_soc`];
    keys.forEach((k) => handled.add(k));

    // Gen2: only slots 1-2 supported
    if (slot > 2) {
      const snapshot = this.inverter!.getData();
      if (snapshot.generation !== 'gen3') {
        throw new Error(`Discharge slot ${slot} is not supported on Gen2 inverters`);
      }
    }

    const config: TimeSlotInput = {
      start: newSettings[`${prefix}_start`],
      end: newSettings[`${prefix}_end`],
      targetStateOfCharge: newSettings[`${prefix}_target_soc`],
    };
    await this.inverter!.setDischargeSlot(slot, config);
  };

  for (const key of changedKeys) {
    if (handled.has(key)) continue;

    switch (key) {
      case 'eco_mode':
        await this.inverter.setEcoMode(newSettings.eco_mode);
        break;
      case 'timed_export':
        await this.inverter.setTimedExport(newSettings.timed_export);
        break;
      case 'charge_schedule_enabled':
        await this.inverter.setTimedCharge(newSettings.charge_schedule_enabled);
        break;
      case 'discharge_schedule_enabled': {
        const { Gen3Inverter } = await import('givenergy-modbus');
        if (!(this.inverter instanceof Gen3Inverter)) throw new Error('Discharge schedule is only supported on Gen3 inverters');
        await this.inverter.setTimedDischarge(newSettings.discharge_schedule_enabled);
        break;
      }
      case 'charge_rate':
        await this.inverter.setChargeRatePercent(newSettings.charge_rate);
        break;
      case 'discharge_rate':
        await this.inverter.setDischargeRatePercent(newSettings.discharge_rate);
        break;

      // Charge slots 1-3
      case 'charge_slot1_start':
      case 'charge_slot1_end':
      case 'charge_slot1_target_soc':
        await handleChargeSlot(1);
        break;
      case 'charge_slot2_start':
      case 'charge_slot2_end':
      case 'charge_slot2_target_soc':
        await handleChargeSlot(2);
        break;
      case 'charge_slot3_start':
      case 'charge_slot3_end':
      case 'charge_slot3_target_soc':
        await handleChargeSlot(3);
        break;

      // Discharge slots 1-3
      case 'discharge_slot1_start':
      case 'discharge_slot1_end':
      case 'discharge_slot1_target_soc':
        await handleDischargeSlot(1);
        break;
      case 'discharge_slot2_start':
      case 'discharge_slot2_end':
      case 'discharge_slot2_target_soc':
        await handleDischargeSlot(2);
        break;
      case 'discharge_slot3_start':
      case 'discharge_slot3_end':
      case 'discharge_slot3_target_soc':
        await handleDischargeSlot(3);
        break;

      case 'export_limit': {
        const { Gen3Inverter } = await import('givenergy-modbus');
        if (!(this.inverter instanceof Gen3Inverter)) throw new Error('Export limit is only supported on Gen3 inverters');
        await this.inverter.setExportLimit(newSettings.export_limit);
        break;
      }
      case 'battery_pause_mode': {
        const { Gen3Inverter } = await import('givenergy-modbus');
        if (!(this.inverter instanceof Gen3Inverter)) throw new Error('Battery pause mode is only supported on Gen3 inverters');
        await this.inverter.setBatteryPauseMode(newSettings.battery_pause_mode);
        break;
      }
    }
  }
}
```

**Step 2: Compile and verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add drivers/solar-inverter/device.ts
git commit -m "feat: handle charge/discharge slots 1-3 in onSettings"
```

---

### Task 5: Create Gen2 flow action cards (set_charge_slot, set_discharge_slot)

**Files:**
- Create: `.homeycompose/flow/actions/set_charge_slot.json`
- Create: `.homeycompose/flow/actions/set_discharge_slot.json`

**Step 1: Create set_charge_slot.json (Gen2 — slot 1 only, no SOC)**

```json
{
  "title": { "en": "Set charge slot" },
  "titleFormatted": { "en": "Set charge slot 1 to [[start_time]] - [[end_time]]" },
  "hint": { "en": "Configures the charge schedule time window. Gen1/Gen2 inverters support 1 charge slot." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter"
    },
    {
      "type": "text",
      "name": "start_time",
      "title": { "en": "Start Time (HH:MM)" },
      "placeholder": { "en": "00:30" }
    },
    {
      "type": "text",
      "name": "end_time",
      "title": { "en": "End Time (HH:MM)" },
      "placeholder": { "en": "04:30" }
    }
  ]
}
```

**Step 2: Create set_discharge_slot.json (Gen2 — slots 1-2, no SOC)**

```json
{
  "title": { "en": "Set discharge slot" },
  "titleFormatted": { "en": "Set discharge slot [[slot]] to [[start_time]] - [[end_time]]" },
  "hint": { "en": "Configures a discharge schedule time window. Gen1/Gen2 inverters support slots 1-2." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter"
    },
    {
      "type": "dropdown",
      "name": "slot",
      "title": { "en": "Slot" },
      "values": [
        { "id": "1", "label": { "en": "Slot 1" } },
        { "id": "2", "label": { "en": "Slot 2" } }
      ]
    },
    {
      "type": "text",
      "name": "start_time",
      "title": { "en": "Start Time (HH:MM)" },
      "placeholder": { "en": "16:00" }
    },
    {
      "type": "text",
      "name": "end_time",
      "title": { "en": "End Time (HH:MM)" },
      "placeholder": { "en": "19:00" }
    }
  ]
}
```

**Step 3: Commit**

```bash
git add .homeycompose/flow/actions/set_charge_slot.json .homeycompose/flow/actions/set_discharge_slot.json
git commit -m "feat: add Gen2 flow action cards for charge/discharge slot configuration"
```

---

### Task 6: Create Gen3 flow action cards (set_charge_slot_gen3, set_discharge_slot_gen3)

**Files:**
- Create: `.homeycompose/flow/actions/set_charge_slot_gen3.json`
- Create: `.homeycompose/flow/actions/set_discharge_slot_gen3.json`

**Step 1: Create set_charge_slot_gen3.json (slots 1-3, with SOC)**

```json
{
  "title": { "en": "Set charge slot" },
  "titleFormatted": { "en": "Set charge slot [[slot]] to [[start_time]] - [[end_time]] at [[target_soc]]%" },
  "hint": { "en": "Configures a charge schedule slot with target SOC. Gen3 inverters support slots 1-3." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter&capabilities=inverter_gen3"
    },
    {
      "type": "dropdown",
      "name": "slot",
      "title": { "en": "Slot" },
      "values": [
        { "id": "1", "label": { "en": "Slot 1" } },
        { "id": "2", "label": { "en": "Slot 2" } },
        { "id": "3", "label": { "en": "Slot 3" } }
      ]
    },
    {
      "type": "text",
      "name": "start_time",
      "title": { "en": "Start Time (HH:MM)" },
      "placeholder": { "en": "00:30" }
    },
    {
      "type": "text",
      "name": "end_time",
      "title": { "en": "End Time (HH:MM)" },
      "placeholder": { "en": "04:30" }
    },
    {
      "type": "number",
      "name": "target_soc",
      "title": { "en": "Target SOC (%)" },
      "min": 0,
      "max": 100,
      "step": 1,
      "value": 100
    }
  ]
}
```

**Step 2: Create set_discharge_slot_gen3.json (slots 1-3, with SOC)**

```json
{
  "title": { "en": "Set discharge slot" },
  "titleFormatted": { "en": "Set discharge slot [[slot]] to [[start_time]] - [[end_time]] at [[target_soc]]%" },
  "hint": { "en": "Configures a discharge schedule slot with target SOC. Gen3 inverters support slots 1-3." },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "driver_id=solar-inverter&capabilities=inverter_gen3"
    },
    {
      "type": "dropdown",
      "name": "slot",
      "title": { "en": "Slot" },
      "values": [
        { "id": "1", "label": { "en": "Slot 1" } },
        { "id": "2", "label": { "en": "Slot 2" } },
        { "id": "3", "label": { "en": "Slot 3" } }
      ]
    },
    {
      "type": "text",
      "name": "start_time",
      "title": { "en": "Start Time (HH:MM)" },
      "placeholder": { "en": "16:00" }
    },
    {
      "type": "text",
      "name": "end_time",
      "title": { "en": "End Time (HH:MM)" },
      "placeholder": { "en": "19:00" }
    },
    {
      "type": "number",
      "name": "target_soc",
      "title": { "en": "Target SOC (%)" },
      "min": 0,
      "max": 100,
      "step": 1,
      "value": 0
    }
  ]
}
```

**Step 3: Commit**

```bash
git add .homeycompose/flow/actions/set_charge_slot_gen3.json .homeycompose/flow/actions/set_discharge_slot_gen3.json
git commit -m "feat: add Gen3 flow action cards for charge/discharge slot configuration with SOC"
```

---

### Task 7: Register flow action card run listeners

**Files:**
- Modify: `app.ts:86-96`

**Step 1: Add run listeners for the four new action cards**

In `app.ts`, after the existing action card registrations (after line 114, before the force charge section), add:

```typescript
// Slot configuration action cards (Gen2 — no target SOC)
this.homey.flow.getActionCard('set_charge_slot')
  .registerRunListener(async (args: any) => {
    const inverter = this.getInverter(args.device.getData().id);
    if (!inverter) throw new Error('Inverter not connected');
    await inverter.setChargeSlot(1, { start: args.start_time, end: args.end_time });
  });

this.homey.flow.getActionCard('set_discharge_slot')
  .registerRunListener(async (args: any) => {
    const inverter = this.getInverter(args.device.getData().id);
    if (!inverter) throw new Error('Inverter not connected');
    const slot = parseInt(args.slot, 10);
    await inverter.setDischargeSlot(slot, { start: args.start_time, end: args.end_time });
  });

// Slot configuration action cards (Gen3 — with target SOC)
this.homey.flow.getActionCard('set_charge_slot_gen3')
  .registerRunListener(async (args: any) => {
    const inverter = this.getInverter(args.device.getData().id);
    if (!inverter) throw new Error('Inverter not connected');
    const slot = parseInt(args.slot, 10);
    await inverter.setChargeSlot(slot, {
      start: args.start_time,
      end: args.end_time,
      targetStateOfCharge: args.target_soc,
    });
  });

this.homey.flow.getActionCard('set_discharge_slot_gen3')
  .registerRunListener(async (args: any) => {
    const inverter = this.getInverter(args.device.getData().id);
    if (!inverter) throw new Error('Inverter not connected');
    const slot = parseInt(args.slot, 10);
    await inverter.setDischargeSlot(slot, {
      start: args.start_time,
      end: args.end_time,
      targetStateOfCharge: args.target_soc,
    });
  });
```

**Step 2: Compile and verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add app.ts
git commit -m "feat: register run listeners for slot configuration flow cards"
```

---

### Task 8: Build, verify, and create PR

**Step 1: Full build**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Run homey app validate (if available)**

Run: `npx homey app validate`
Expected: No errors

**Step 3: Create feature branch and PR**

```bash
git checkout -b feat/multi-slot-schedules
git cherry-pick <commits from main>
```

Or if working on a branch already, push and create PR:

```bash
git push -u origin feat/multi-slot-schedules
gh pr create --title "Support multiple charge/discharge schedule slots" --body "Closes #12"
```
