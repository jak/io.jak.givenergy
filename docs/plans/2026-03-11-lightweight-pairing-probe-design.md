# Lightweight Pairing Probe

**Goal:** Eliminate the 30-second pairing timeout by replacing `Inverter.connect()` (full poll cycle) with a lightweight identity probe during device discovery.

**Problem:** `GivEnergyInverter.connect()` calls `PollManager.start()` which executes a full initial poll: 7+ register range reads, a 3-second push data soak, 6 battery slave reads, and 16 meter reads. Each non-responding slave incurs up to 40 seconds of retries (10s timeout x 4 attempts). For the user's Gen2 Hybrid at 192.168.50.162, this took ~8 minutes in v1.1.0. The 30-second timeout added in v1.2.0 now causes pairing to fail entirely.

**Trigger:** Bug report from user with serial SD2227G895 (Hybrid Gen2). Discovery finds the inverter but `connect()` times out before completing the initial poll.

## Design

### Library: Add `GivEnergyInverter.identify()` static method

A new static method on `GivEnergyInverter` that returns identity information without starting a poll cycle.

```typescript
export interface InverterIdentity {
  serialNumber: string;
  generation: InverterGeneration;
  modelCode: number;
}

static async identify(options: { host: string; port?: number }): Promise<InverterIdentity>
```

**Implementation** (in `src/inverter.ts`):

1. Create a `Client` with short timeout (10s) and 1 retry
2. Connect to the inverter
3. Read HR 0-59 (single Modbus request) - this gives us:
   - HR(0): device type code
   - HR(13-17): serial number (5 registers, 10 ASCII chars)
   - HR(21): ARM firmware version
4. Extract serial via `registersToString()`
5. Determine generation via `detectModel()` with `detectGeneration()` fallback
6. Close the connection
7. Return `{ serialNumber, generation, modelCode }`

This follows the same pattern as `verifyInverter()` in discover.ts - create a lightweight Client, do one request, close. The difference is reading 60 registers instead of 1, and extracting identity info from the response.

**Why HR 0-59 instead of just the specific registers?** GivEnergy's data adapter firmware requires base registers to be multiples of 60, and max count is 60. So we read the whole first block - it's a single request either way.

**Timeout budget:** TCP connect (~1s) + one register read with retry (~15s max) + close = well under 30 seconds.

### Library: Export new types

Add to `src/index.ts`:
```typescript
export type { InverterIdentity } from './inverter.js';
```

### App: Use `identify()` in pairing

In `lib/pairing.ts`, replace `Inverter.connect()` with `Inverter.identify()` inside `connectAndBuildDevices`:

```typescript
// Before (v1.2.0):
const inverter = await withTimeout(Inverter.connect({ host }), CONNECT_TIMEOUT_MS, host);
const snapshot = inverter.getData();
const gen = snapshot.generation;
const device = {
  name: buildDeviceName(snapshot.serialNumber, gen),
  data: { id: snapshot.serialNumber },
  store: { host, generation: gen },
};
await inverter.stop();

// After:
const identity = await withTimeout(Inverter.identify({ host }), CONNECT_TIMEOUT_MS, host);
const device = {
  name: buildDeviceName(identity.serialNumber, identity.generation),
  data: { id: identity.serialNumber },
  store: { host, generation: identity.generation },
};
```

No `inverter.stop()` needed - the Client is closed inside `identify()`. No resource leak on timeout either, since the Client's socket is destroyed in the finally block.

### Secondary fix: discover() could return identity

A future enhancement could fold `identify()` into the discovery verify phase, so `discover()` returns `{ host, serialNumber, generation }` directly - eliminating the separate connect step entirely. Out of scope for this fix.

## Testing

- Unit test `identify()` against a mock server that responds to HR 0-59
- Verify serial extraction and generation detection match `connect()` behavior
- Verify connection is properly closed (no leaked sockets)
- Verify timeout behavior (Client closed on reject)

## Changes summary

| Repo | File | Change |
|------|------|--------|
| givenergy-modbus | `src/inverter.ts` | Add `identify()` static method, `InverterIdentity` interface |
| givenergy-modbus | `src/index.ts` | Export `InverterIdentity` type |
| io.jak.givenergy | `lib/pairing.ts` | Use `identify()` instead of `connect()` in `connectAndBuildDevices` |
| io.jak.givenergy | `package.json` | Bump givenergy-modbus dependency |
