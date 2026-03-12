# Repair Flow for IP Address Changes

## Problem

When an inverter's IP changes (DHCP lease, network reconfiguration), all three devices (solar inverter, battery, grid meter) become unavailable. The only fix is to delete and re-pair, losing device settings and flow card references.

## Design

### Approach

Shared repair logic in `lib/repair.ts` following the existing `lib/pairing.ts` pattern. Each driver calls `setupRepairSession(session, this)` from its `onRepair` handler.

### `lib/repair.ts` — `setupRepairSession(session, driver)`

- Registers a `manual_connect` handler on the repair session
- On submit: validates IP via `Inverter.identify()`, confirms the serial number matches the device being repaired (prevents pointing device A at inverter B)
- Updates the `host` in the device's store
- Finds all devices across all drivers sharing the same serial number and updates their stores and `label_ip_address` settings
- Emits `done` to close the repair session

### `repair.html` — shared repair view

- IP input form (reuses styling from `discover.html`)
- Shows current IP as placeholder
- Connecting spinner phase
- Error display on failure
- Copied to each driver's `pair/` directory

### Driver changes

Each driver's `driver.ts` adds:

```typescript
async onRepair(session: any) {
  setupRepairSession(session, this);
}
```

### Serial number validation

If the entered IP resolves to a different inverter serial number, show an error: "This inverter has a different serial number (X). Expected Y." This prevents misconfiguration.

### Cascading update

When repairing any one device, all sibling devices (same serial number across all drivers) get their store updated. This avoids requiring the user to repair each device separately.

### Reconnection

After the store is updated, close the repair session. Homey will reinitialise the device with the new IP from the store on next restart, or the user can restart the app.
