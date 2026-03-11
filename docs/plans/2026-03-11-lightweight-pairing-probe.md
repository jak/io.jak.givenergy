# Lightweight Pairing Probe Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `GivEnergyInverter.identify()` to the library and use it in the Homey app's pairing flow, replacing the heavyweight `connect()` call that times out.

**Architecture:** Add a static `identify()` method to `GivEnergyInverter` that creates a lightweight `Client`, reads HR 0-59 (one Modbus request), extracts serial/generation/model, and closes. The Homey app's `connectAndBuildDevices` calls `identify()` instead of `connect()` during pairing. Follows the same pattern as `verifyInverter()` in discover.ts.

**Tech Stack:** TypeScript, vitest, givenergy-modbus library, Homey SDK

---

### Task 1: Add `identify()` test to givenergy-modbus

**Files:**
- Modify: `/Users/jak/Code/givenergy-modbus/test/inverter.test.ts`

**Step 1: Write failing tests for `identify()`**

Add these tests to the existing `describe('GivEnergyInverter')` block in `test/inverter.test.ts`. They use a mock TCP server that responds to a HR 0-59 read request with register values containing a known serial number and model code.

The mock response needs to be a valid GivEnergy transparent frame. Use the same `PayloadEncoder` and frame-building approach from `test/discover.test.ts`, but with 60 register values instead of 1.

```typescript
import { createServer, type Server, type Socket } from 'net';
import { PayloadEncoder } from '../src/codec.js';

// Helper: build a mock response frame for a read holding registers request
// (slave=0x11, fc=0x03, base=0, count=60) with 60 register values.
function buildIdentifyResponse(registers: number[]): Buffer {
  const serial = '**********';
  const inverterSerial = '**********';
  const slaveAddress = 0x11;
  const fc = 0x03;
  const baseRegister = 0;
  const registerCount = registers.length;

  const crcEnc = new PayloadEncoder();
  crcEnc.addUint8(slaveAddress);
  crcEnc.addUint8(fc);
  crcEnc.addString(inverterSerial, 10);
  crcEnc.addUint16(baseRegister);
  crcEnc.addUint16(registerCount);
  for (const val of registers) crcEnc.addUint16(val);
  const crc = crcEnc.crc;
  const swappedCrc = ((crc & 0xFF) << 8) | ((crc >> 8) & 0xFF);

  const bodyEnc = new PayloadEncoder();
  bodyEnc.addUint8(0x01); // uid
  bodyEnc.addUint8(0x02); // fid: transparent
  bodyEnc.addString(serial, 10);
  // 8-byte padding
  for (let i = 0; i < 7; i++) bodyEnc.addUint8(0x00);
  bodyEnc.addUint8(0x08);
  bodyEnc.addUint8(slaveAddress);
  bodyEnc.addUint8(fc);
  bodyEnc.addString(inverterSerial, 10);
  bodyEnc.addUint16(baseRegister);
  bodyEnc.addUint16(registerCount);
  for (const val of registers) bodyEnc.addUint16(val);
  bodyEnc.addUint16(swappedCrc);

  const body = bodyEnc.payload;
  const frameEnc = new PayloadEncoder();
  frameEnc.addUint16(0x5959); // TID
  frameEnc.addUint16(0x0001); // protocol ID
  frameEnc.addUint16(body.length);
  for (const byte of body) frameEnc.addUint8(byte);
  return frameEnc.payload;
}

// Helper: encode a 10-char string into 5 register values (high byte, low byte)
function stringToRegisters(str: string): number[] {
  const padded = str.padEnd(10, '\x00');
  const regs: number[] = [];
  for (let i = 0; i < 10; i += 2) {
    regs.push((padded.charCodeAt(i) << 8) | padded.charCodeAt(i + 1));
  }
  return regs;
}
```

Test 1 - identify returns serial, generation, and model code for a Gen2 hybrid:

```typescript
it('identify() returns serial number and generation from a single register read', async () => {
  // Build 60 holding registers with known identity values:
  // HR(0) = 0x2001 (device_type_code, hex prefix '2' = hybrid)
  // HR(13-17) = "SD2227G895" (serial number, 5 registers)
  // HR(21) = 899 (arm_firmware_version, 899/100 = 8 → gen2)
  const registers = new Array(60).fill(0);
  registers[0] = 0x2001; // device_type_code
  const serialRegs = stringToRegisters('SD2227G895');
  for (let i = 0; i < 5; i++) registers[13 + i] = serialRegs[i];
  registers[21] = 899; // arm_firmware_version → gen2

  const response = buildIdentifyResponse(registers);
  let server: Server | undefined;
  const sockets: Socket[] = [];
  try {
    server = createServer(socket => {
      sockets.push(socket);
      socket.once('data', () => socket.write(response));
    });
    const port = await new Promise<number>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      });
    });

    const identity = await GivEnergyInverter.identify({ host: '127.0.0.1', port });
    expect(identity.serialNumber).toBe('SD2227G895');
    expect(identity.generation).toBe('gen2');
    expect(identity.modelCode).toBe(0x2001);
  } finally {
    sockets.forEach(s => s.destroy());
    server?.close();
  }
});
```

Test 2 - identify detects Gen3:

```typescript
it('identify() detects gen3 from device type code and firmware version', async () => {
  const registers = new Array(60).fill(0);
  registers[0] = 0x2001;
  const serialRegs = stringToRegisters('EE1234G567');
  for (let i = 0; i < 5; i++) registers[13 + i] = serialRegs[i];
  registers[21] = 301; // arm_firmware_version → 301/100 = 3 → gen3

  const response = buildIdentifyResponse(registers);
  let server: Server | undefined;
  const sockets: Socket[] = [];
  try {
    server = createServer(socket => {
      sockets.push(socket);
      socket.once('data', () => socket.write(response));
    });
    const port = await new Promise<number>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      });
    });

    const identity = await GivEnergyInverter.identify({ host: '127.0.0.1', port });
    expect(identity.serialNumber).toBe('EE1234G567');
    expect(identity.generation).toBe('gen3');
  } finally {
    sockets.forEach(s => s.destroy());
    server?.close();
  }
});
```

Test 3 - identify falls back to serial prefix when model code is 0:

```typescript
it('identify() falls back to serial prefix detection when model code is zero', async () => {
  // When all registers are zero, model code is 0 → falls back to serial prefix.
  // SA prefix → three_phase.
  const registers = new Array(60).fill(0);
  const serialRegs = stringToRegisters('SA9999X123');
  for (let i = 0; i < 5; i++) registers[13 + i] = serialRegs[i];

  const response = buildIdentifyResponse(registers);
  let server: Server | undefined;
  const sockets: Socket[] = [];
  try {
    server = createServer(socket => {
      sockets.push(socket);
      socket.once('data', () => socket.write(response));
    });
    const port = await new Promise<number>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      });
    });

    const identity = await GivEnergyInverter.identify({ host: '127.0.0.1', port });
    expect(identity.serialNumber).toBe('SA9999X123');
    expect(identity.generation).toBe('three_phase');
    expect(identity.modelCode).toBe(0);
  } finally {
    sockets.forEach(s => s.destroy());
    server?.close();
  }
});
```

Test 4 - identify throws for empty serial:

```typescript
it('identify() throws when serial number is empty (not a GivEnergy inverter)', async () => {
  // All-zero registers → NUL-filled serial → should reject
  const registers = new Array(60).fill(0);
  const response = buildIdentifyResponse(registers);
  let server: Server | undefined;
  const sockets: Socket[] = [];
  try {
    server = createServer(socket => {
      sockets.push(socket);
      socket.once('data', () => socket.write(response));
    });
    const port = await new Promise<number>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      });
    });

    await expect(GivEnergyInverter.identify({ host: '127.0.0.1', port }))
      .rejects.toThrow('No valid inverter found');
  } finally {
    sockets.forEach(s => s.destroy());
    server?.close();
  }
});
```

Test 5 - identify cleans up connection (no socket leak):

```typescript
it('identify() closes the connection after reading identity', async () => {
  const registers = new Array(60).fill(0);
  registers[0] = 0x2001;
  const serialRegs = stringToRegisters('SD2227G895');
  for (let i = 0; i < 5; i++) registers[13 + i] = serialRegs[i];
  registers[21] = 899;

  const response = buildIdentifyResponse(registers);
  let server: Server | undefined;
  const sockets: Socket[] = [];
  try {
    server = createServer(socket => {
      sockets.push(socket);
      socket.once('data', () => socket.write(response));
    });
    const port = await new Promise<number>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      });
    });

    await GivEnergyInverter.identify({ host: '127.0.0.1', port });

    // Give a tick for the socket close to propagate
    await new Promise(r => setTimeout(r, 50));

    // Server socket should have been destroyed by client close
    expect(sockets.every(s => s.destroyed)).toBe(true);
  } finally {
    sockets.forEach(s => s.destroy());
    server?.close();
  }
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/jak/Code/givenergy-modbus && npx vitest run test/inverter.test.ts`
Expected: FAIL — `GivEnergyInverter.identify is not a function`

**Step 3: Commit**

```
test: add tests for GivEnergyInverter.identify() static method
```

---

### Task 2: Implement `identify()` in givenergy-modbus

**Files:**
- Modify: `/Users/jak/Code/givenergy-modbus/src/inverter.ts`
- Modify: `/Users/jak/Code/givenergy-modbus/src/index.ts`

**Step 1: Add `InverterIdentity` interface and `identify()` method**

In `src/inverter.ts`, add the interface before the class definition:

```typescript
export interface InverterIdentity {
  serialNumber: string;
  generation: InverterGeneration;
  modelCode: number;
}
```

Add imports at the top of `src/inverter.ts`:

```typescript
import { Client } from './client.js';
import { encodeReadHoldingRegistersRequest } from './pdu/encode.js';
import { registersToString } from './model/converters.js';
import { detectModel } from './model/device-types.js';
import { detectGeneration, type InverterGeneration } from './generation.js';
```

Add the static method inside the `GivEnergyInverter` class, after `connect()`:

```typescript
/**
 * Lightweight identity probe — reads only HR 0-59 (one Modbus request)
 * to extract serial number, model code, and generation without starting
 * a full poll cycle. Use this during pairing/discovery when you only need
 * to identify the inverter, not stream live data.
 */
static async identify(options: { host: string; port?: number }): Promise<InverterIdentity> {
  const client = new Client({
    host: options.host,
    port: options.port ?? 8899,
    timeout: 10_000,
    retries: 1,
  });
  try {
    await client.connect();
    const frame = encodeReadHoldingRegistersRequest({
      dataAdapterSerial: client.dataAdapterSerial,
      slaveAddress: 0x11,
      baseRegister: 0,
      registerCount: 60,
    });
    const values = await client.sendRequest(frame);

    const serialRegs = [13, 14, 15, 16, 17].map(i => values[i] ?? 0);
    const serialNumber = registersToString(serialRegs);

    if (!serialNumber || serialNumber.replace(/[\x00\s]/g, '') === '') {
      throw new Error(`No valid inverter found at ${options.host} (empty serial number)`);
    }

    const modelCode = values[0] ?? 0;
    const armFirmwareVersion = values[21] ?? 0;
    const generation = modelCode !== 0
      ? modelToGeneration(detectModel(modelCode, armFirmwareVersion))
      : detectGeneration(serialNumber);

    return { serialNumber, generation, modelCode };
  } finally {
    await client.close();
  }
}
```

Note: `identify()` needs the `modelToGeneration` helper. Since it's currently a private function in `snapshot-builder.ts`, extract it to a shared location or duplicate the small mapping inline. The cleanest approach: move `modelToGeneration` to `generation.ts` and export it, then import in both `snapshot-builder.ts` and `inverter.ts`.

In `src/generation.ts`, add:

```typescript
import { DeviceType } from './model/device-types.js';

export function modelToGeneration(model: DeviceType): InverterGeneration {
  switch (model) {
    case DeviceType.HYBRID_GEN3:
    case DeviceType.HYBRID_HV_GEN3:
      return 'gen3';
    case DeviceType.HYBRID_3PH:
    case DeviceType.AC_3PH:
      return 'three_phase';
    default:
      return 'gen2';
  }
}
```

Update `src/snapshot-builder.ts` to import from `generation.ts` instead of defining it locally:

```typescript
import { detectGeneration, modelToGeneration, type InverterGeneration } from './generation.js';
```

Remove the local `modelToGeneration` function from `snapshot-builder.ts`.

**Step 2: Export `InverterIdentity` from index**

In `src/index.ts`, update the inverter export line:

```typescript
export type { GivEnergyInverterOptions, InverterMode, TimeSlotInput, InverterIdentity } from './inverter.js';
```

**Step 3: Run tests**

Run: `cd /Users/jak/Code/givenergy-modbus && npx vitest run test/inverter.test.ts`
Expected: All tests PASS

**Step 4: Run full test suite**

Run: `cd /Users/jak/Code/givenergy-modbus && npx vitest run`
Expected: All tests PASS (snapshot-builder tests still work after extracting `modelToGeneration`)

**Step 5: Build**

Run: `cd /Users/jak/Code/givenergy-modbus && npm run build`
Expected: exit 0, no errors

**Step 6: Commit**

```
feat: add GivEnergyInverter.identify() for lightweight identity probing
```

---

### Task 3: Update Homey app to use `identify()` in pairing

**Files:**
- Modify: `/Users/jak/Code/io.jak.givenergy/lib/pairing.ts`
- Modify: `/Users/jak/Code/io.jak.givenergy/package.json` (bump givenergy-modbus)

**Step 1: Link local givenergy-modbus for development**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm link ../givenergy-modbus`

This lets us test against the local library build before publishing.

**Step 2: Update `connectAndBuildDevices` in `lib/pairing.ts`**

Replace the `Inverter` parameter type and usage. The function currently accepts `{ connect(options: { host: string }): Promise<GivEnergyInverter> }` — change it to accept `{ identify(options: { host: string }): Promise<InverterIdentity> }`.

Update the type import at the top:

```typescript
type InverterIdentity = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterIdentity;
```

Update the `connectAndBuildDevices` function signature and body:

```typescript
async function connectAndBuildDevices(
  hosts: string[],
  Inverter: { identify(options: { host: string }): Promise<InverterIdentity> },
  logger: { log: (...args: any[]) => void; error: (...args: any[]) => void },
  buildDeviceName: (serialNumber: string, generation: string) => string,
): Promise<DiscoveredDeviceEntry[]> {
  const devices = await Promise.all(
    hosts.map(async (host) => {
      try {
        logger.log(`Connecting to inverter at ${host}...`);
        const identity = await withTimeout(Inverter.identify({ host }), CONNECT_TIMEOUT_MS, host);
        const device: DiscoveredDeviceEntry = {
          name: buildDeviceName(identity.serialNumber, identity.generation),
          data: { id: identity.serialNumber },
          store: { host, generation: identity.generation },
        };
        logger.log(`Found inverter: ${device.name} at ${host}`);
        return device;
      } catch (err: any) {
        logger.error(`Failed to connect to inverter at ${host}:`, err?.message ?? err);
        return null;
      }
    }),
  );

  return devices.filter((d): d is DiscoveredDeviceEntry => d !== null);
}
```

The caller in `start_discover` already passes `GivEnergyInverter` which now has `identify()`. Update the call:

```typescript
// In start_discover handler — change the destructured import:
const { discover, getLocalSubnet, GivEnergyInverter: Inverter } = await import('givenergy-modbus');
// This line stays the same — Inverter now has .identify() on it
discoveredDevices = await connectAndBuildDevices(discovered.map(d => d.host), Inverter, logger, buildDeviceName);
```

Same for `manual_connect` — the `Inverter` reference already works.

Remove the now-unused `GivEnergyInverter` type import at the top of the file (the one used for `connect()` return type), since we no longer hold an inverter reference.

**Step 3: Build the Homey app**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: exit 0, no errors

**Step 4: Commit**

```
fix: use lightweight identify() probe during pairing discovery
```

---

### Task 4: Publish givenergy-modbus and update Homey app dependency

**Step 1: Publish givenergy-modbus**

Follow the library's release process (release-please or manual version bump + npm publish).

**Step 2: Update Homey app dependency**

```bash
cd /Users/jak/Code/io.jak.givenergy
npm unlink givenergy-modbus
npm install givenergy-modbus@<new-version>
```

**Step 3: Build and verify**

Run: `cd /Users/jak/Code/io.jak.givenergy && npm run build`
Expected: exit 0

**Step 4: Commit**

```
chore: bump givenergy-modbus to <new-version>
```
