# Repair Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to update their inverter's IP address without deleting and re-pairing devices.

**Architecture:** Shared repair logic in `lib/repair.ts` (mirrors `lib/pairing.ts` pattern). Each driver registers `onRepair` calling `setupRepairSession()`. A single `repair.html` view is placed in each driver's `pair/` directory. Repairing one device cascades the new IP to all sibling devices sharing the same serial number.

**Tech Stack:** TypeScript, Homey SDK v3 (`onRepair`), givenergy-modbus (`Inverter.identify()`)

---

### Task 1: Create the repair HTML view

**Files:**
- Create: `drivers/solar-inverter/pair/repair.html`

**Step 1: Create repair.html**

This is a simplified version of `discover.html` — just the IP input form (no auto-discovery phase). Shows current IP as placeholder. Three phases: form, connecting spinner, success message.

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 20px;
      color: #333;
    }

    .phase { display: none; }
    .phase.active { display: block; }

    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid #e0e0e0;
      border-top-color: #2196F3;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 20px auto;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .status {
      text-align: center;
      margin: 16px 0;
      color: #666;
    }

    .manual-form {
      margin-top: 16px;
    }

    .manual-form p {
      margin: 8px 0;
      color: #666;
      font-size: 14px;
    }

    .manual-form input {
      width: 100%;
      padding: 10px;
      border: 1px solid #ccc;
      border-radius: 6px;
      font-size: 16px;
      box-sizing: border-box;
      margin: 8px 0;
    }

    .manual-form button {
      width: 100%;
      padding: 12px;
      background: #2196F3;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      cursor: pointer;
      margin-top: 8px;
    }

    .manual-form button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .error {
      color: #d32f2f;
      margin-top: 8px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <!-- IP input phase -->
  <div id="phase-form" class="phase active">
    <div class="manual-form">
      <p><strong>Enter the new IP address for your inverter.</strong></p>
      <p>You can find the IP address in your router's connected devices list, or in the GivEnergy portal/app.</p>
      <input type="text" id="ip-input" placeholder="" />
      <button id="connect-btn">Update</button>
      <div id="error-msg" class="error"></div>
    </div>
  </div>

  <!-- Connecting phase -->
  <div id="phase-connecting" class="phase">
    <div class="spinner"></div>
    <div class="status">Connecting to inverter...</div>
  </div>

  <script>
    function showPhase(id) {
      document.querySelectorAll('.phase').forEach(function(el) {
        el.classList.remove('active');
      });
      document.getElementById('phase-' + id).classList.add('active');
    }

    Homey.emit('get_current_ip', null, function(err, ip) {
      if (!err && ip) {
        document.getElementById('ip-input').placeholder = ip;
      }
    });

    document.getElementById('connect-btn').addEventListener('click', function() {
      var host = document.getElementById('ip-input').value.trim();
      if (!host) return;

      document.getElementById('error-msg').textContent = '';
      showPhase('connecting');

      Homey.emit('manual_connect', { host: host }, function(err) {
        if (err) {
          showPhase('form');
          document.getElementById('error-msg').textContent = err.message || 'Connection failed';
        } else {
          Homey.done();
        }
      });
    });

    document.getElementById('ip-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        document.getElementById('connect-btn').click();
      }
    });
  </script>
</body>
</html>
```

**Step 2: Copy repair.html to the other two drivers**

Copy `drivers/solar-inverter/pair/repair.html` to:
- `drivers/battery/pair/repair.html`
- `drivers/grid-meter/pair/repair.html`

All three files are identical.

**Step 3: Verify the build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: No errors (HTML isn't compiled, just copied by Homey)

**Step 4: Commit**

```bash
git add drivers/solar-inverter/pair/repair.html drivers/battery/pair/repair.html drivers/grid-meter/pair/repair.html
git commit -m "feat: add repair HTML view for IP address update"
```

---

### Task 2: Add repair view to driver.compose.json files

**Files:**
- Modify: `drivers/solar-inverter/driver.compose.json`
- Modify: `drivers/battery/driver.compose.json`
- Modify: `drivers/grid-meter/driver.compose.json`

**Step 1: Add `repair` section to each driver.compose.json**

Homey SDK requires a `repair` array in the driver manifest to enable the repair button. Add this after the `pair` array in each file:

For `drivers/solar-inverter/driver.compose.json`, add after the `pair` array closing `]` and before `"settings"`:
```json
  "repair": [
    {
      "id": "repair"
    }
  ],
```

For `drivers/battery/driver.compose.json`, add after the `pair` array closing `]` (before the closing `}`):
```json
  "repair": [
    {
      "id": "repair"
    }
  ]
```

For `drivers/grid-meter/driver.compose.json`, add after the `pair` array closing `]` (before the closing `}`):
```json
  "repair": [
    {
      "id": "repair"
    }
  ]
```

**Step 2: Verify the build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: No errors

**Step 3: Commit**

```bash
git add drivers/solar-inverter/driver.compose.json drivers/battery/driver.compose.json drivers/grid-meter/driver.compose.json
git commit -m "feat: register repair view in driver manifests"
```

---

### Task 3: Create shared repair logic in lib/repair.ts

**Files:**
- Create: `lib/repair.ts`

**Step 1: Create lib/repair.ts**

This follows the same pattern as `lib/pairing.ts`: a `setupRepairSession()` function that registers event handlers on the session.

```typescript
'use strict';

const IDENTIFY_TIMEOUT_MS = 10_000;
const IDENTIFY_RETRIES = 1;

export function setupRepairSession(
  session: any,
  driver: {
    log: (...args: any[]) => void;
    error: (...args: any[]) => void;
    homey: any;
  },
) {
  session.setHandler('get_current_ip', async () => {
    const device = session.getDevice();
    return device.getStore().host ?? '';
  });

  session.setHandler('manual_connect', async (data: { host: string }) => {
    const host = data.host?.trim();
    if (!host) throw new Error('Please enter an IP address');

    const device = session.getDevice();
    const expectedSerial = device.getData().id;

    driver.log(`Repair: verifying inverter at ${host} (expecting ${expectedSerial})...`);

    const { GivEnergyInverter: Inverter } = await import('givenergy-modbus');

    let identity;
    try {
      identity = await Inverter.identify({
        host,
        timeout: IDENTIFY_TIMEOUT_MS,
        retries: IDENTIFY_RETRIES,
      });
    } catch (err: any) {
      throw new Error(`Could not connect to inverter at ${host}: ${err?.message ?? err}`);
    }

    if (identity.serialNumber !== expectedSerial) {
      throw new Error(
        `This inverter has a different serial number (${identity.serialNumber}). Expected ${expectedSerial}.`,
      );
    }

    driver.log(`Repair: verified serial ${identity.serialNumber}, updating store...`);

    // Update this device's store
    await device.setStoreValue('host', host);

    // Update label_ip_address setting if the device has it (solar inverter)
    try {
      await device.setSettings({ label_ip_address: host });
    } catch {
      // Not all devices have this setting — ignore
    }

    // Cascade to sibling devices across all drivers
    const driverIds = ['solar-inverter', 'battery', 'grid-meter'];
    for (const driverId of driverIds) {
      let siblingDriver;
      try {
        siblingDriver = driver.homey.drivers.getDriver(driverId);
      } catch {
        continue;
      }
      for (const sibling of siblingDriver.getDevices()) {
        if (sibling === device) continue;
        if (sibling.getData().id !== expectedSerial) continue;

        driver.log(`Repair: cascading IP update to ${driverId} device`);
        await sibling.setStoreValue('host', host);
        try {
          await sibling.setSettings({ label_ip_address: host });
        } catch {
          // Not all devices have this setting — ignore
        }
      }
    }

    driver.log('Repair: complete');
  });
}
```

**Step 2: Verify the build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: No errors

**Step 3: Commit**

```bash
git add lib/repair.ts
git commit -m "feat: add shared repair session logic with cascading IP update"
```

---

### Task 4: Register onRepair in all three drivers

**Files:**
- Modify: `drivers/solar-inverter/driver.ts`
- Modify: `drivers/battery/driver.ts`
- Modify: `drivers/grid-meter/driver.ts`

**Step 1: Update solar-inverter driver.ts**

Add the import at the top (after the existing pairing import):
```typescript
import { setupRepairSession } from '../../lib/repair';
```

Add the `onRepair` method to the class (after `onPair`):
```typescript
  async onRepair(session: any) {
    setupRepairSession(session, this);
  }
```

**Step 2: Update battery driver.ts**

Add the import at the top (after the existing pairing import):
```typescript
import { setupRepairSession } from '../../lib/repair';
```

Add the `onRepair` method to the class (after `onPair`):
```typescript
  async onRepair(session: any) {
    setupRepairSession(session, this);
  }
```

**Step 3: Update grid-meter driver.ts**

Add the import at the top (after the existing pairing import):
```typescript
import { setupRepairSession } from '../../lib/repair';
```

Add the `onRepair` method to the class (after `onPair`):
```typescript
  async onRepair(session: any) {
    setupRepairSession(session, this);
  }
```

**Step 4: Verify the build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: No errors

**Step 5: Commit**

```bash
git add drivers/solar-inverter/driver.ts drivers/battery/driver.ts drivers/grid-meter/driver.ts
git commit -m "feat: register onRepair handler in all drivers"
```

---

### Task 5: Final verification and lint

**Step 1: Run lint**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run lint`
Expected: No errors

**Step 2: Run build**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: No errors

**Step 3: Fix any lint/build issues and commit if needed**
