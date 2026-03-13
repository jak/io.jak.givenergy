# Pairing Robustness Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the pairing discovery flow resilient to non-inverter devices on port 8899 and Homey pair session timeouts.

**Architecture:** Add a per-host connect timeout and serial number validation to `connectAndBuildDevices()` in `lib/pairing.ts`. Wrap `session.showView()` calls in try/catch to handle expired pair sessions gracefully. The library-level fix (empty serial rejection in `connect()`) is tracked separately in jak/givenergy-modbus#23 — these app-side fixes are defence-in-depth.

**Tech Stack:** TypeScript, Homey SDK

---

### Task 1: Add connect timeout to `connectAndBuildDevices`

**Problem:** `GivEnergyInverter.connect()` can take ~8 minutes against a non-inverter host. During discovery, this blocks the entire flow and causes the Homey pair session to expire.

**Files:**
- Modify: `lib/pairing.ts:87-116` (`connectAndBuildDevices` function)

**Step 1: Add a timeout helper and apply it to `connect()`**

In `connectAndBuildDevices`, wrap each `Inverter.connect()` call in a timeout race. Use 30 seconds — long enough for a real inverter on a slow network, short enough to not outlast the pair session.

```typescript
const CONNECT_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
```

Then in the `hosts.map` callback, replace:
```typescript
const inverter = await Inverter.connect({ host });
```
with:
```typescript
const inverter = await withTimeout(Inverter.connect({ host }), CONNECT_TIMEOUT_MS, host);
```

**Step 2: Validate serial number after connect**

After `inverter.getData()`, reject devices with empty serial numbers (defence-in-depth until jak/givenergy-modbus#23 is fixed):

```typescript
const snapshot = inverter.getData();
if (!snapshot.serialNumber || snapshot.serialNumber.trim() === '') {
  await inverter.stop();
  logger.log(`Skipping ${host}: no valid serial number (not a GivEnergy inverter?)`);
  return null;
}
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: exit 0, no errors

**Step 4: Commit**

```
fix: add connect timeout and serial validation to pairing discovery
```

---

### Task 2: Handle expired pair sessions gracefully

**Problem:** If `session.showView('list_devices')` is called after the Homey pair session has expired, it throws an unhandled rejection (`PairSession with ID ... not found`).

**Files:**
- Modify: `lib/pairing.ts:19-63` (`start_discover` handler)

**Step 1: Wrap `session.showView` and `session.emit` in the discover handler**

The `start_discover` handler already has a try/catch, but the catch re-emits to the session which may also be expired. Wrap the session calls:

```typescript
// At the top of setupPairSession, add a helper:
let sessionExpired = false;

async function safeShowView(view: string) {
  if (sessionExpired) return;
  try {
    await session.showView(view);
  } catch {
    sessionExpired = true;
  }
}

function safeEmit(event: string, data: any) {
  if (sessionExpired) return;
  session.emit(event, data).catch(() => { sessionExpired = true; });
}
```

Then replace throughout the `start_discover` handler:
- `session.emit('discover_progress', ...)` → `safeEmit('discover_progress', ...)`
- `session.emit('discover_complete', ...)` → `safeEmit('discover_complete', ...)`
- `await session.showView('list_devices')` → `await safeShowView('list_devices')`

Also in the `manual_connect` handler:
- `await session.showView('list_devices')` → `await safeShowView('list_devices')`

**Step 2: Build and verify**

Run: `npm run build`
Expected: exit 0, no errors

**Step 3: Commit**

```
fix: handle expired pair sessions gracefully during discovery
```
