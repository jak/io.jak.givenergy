'use strict';

type GivEnergyInverter = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).GivEnergyInverter;
type InverterSnapshot = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterSnapshot;

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

export interface DiscoveredDeviceEntry {
  name: string;
  data: { id: string };
  store: { host: string; generation: string };
}

export function setupPairSession(
  session: any,
  logger: { log: (...args: any[]) => void; error: (...args: any[]) => void },
  buildDeviceName: (serialNumber: string, generation: string) => string,
) {
  let discoveredDevices: DiscoveredDeviceEntry[] = [];

  session.setHandler('start_discover', async () => {
    logger.log('Starting auto-discovery...');
    try {
      const { discover, getLocalSubnet, GivEnergyInverter: Inverter } = await import('givenergy-modbus');

      let subnet: string;
      try {
        subnet = getLocalSubnet();
        logger.log(`Detected local subnet: ${subnet}`);
      } catch (err: any) {
        logger.error('Could not detect local subnet:', err?.message ?? err);
        session.emit('discover_complete', { found: false });
        return;
      }

      let probeCount = 0;
      let foundCount = 0;

      const discovered = await discover({
        subnet,
        onProbe: (host: string, found: boolean) => {
          probeCount++;
          if (found) foundCount++;
          session.emit('discover_progress', { probeCount, foundCount }).catch(() => {});
        },
      });

      logger.log(`Discovery complete: probed ${probeCount} hosts, ${discovered.length} inverter(s)`);

      if (discovered.length === 0) {
        session.emit('discover_complete', { found: false });
        return;
      }

      discoveredDevices = await connectAndBuildDevices(discovered.map(d => d.host), Inverter, logger, buildDeviceName);

      if (discoveredDevices.length > 0) {
        await session.showView('list_devices');
      } else {
        session.emit('discover_complete', { found: false });
      }
    } catch (err: any) {
      logger.error('Discovery failed:', err?.message ?? err);
      session.emit('discover_complete', { found: false });
    }
  });

  session.setHandler('manual_connect', async (data: { host: string }) => {
    const host = data.host?.trim();
    if (!host) throw new Error('Please enter an IP address');

    logger.log(`Manual connect to ${host}...`);
    const { GivEnergyInverter: Inverter } = await import('givenergy-modbus');

    discoveredDevices = await connectAndBuildDevices([host], Inverter, logger, buildDeviceName);

    if (discoveredDevices.length === 0) {
      throw new Error(`Could not connect to inverter at ${host}`);
    }

    await session.showView('list_devices');
  });

  session.setHandler('list_devices', async () => {
    return discoveredDevices;
  });
}

async function connectAndBuildDevices(
  hosts: string[],
  Inverter: { connect(options: { host: string }): Promise<GivEnergyInverter> },
  logger: { log: (...args: any[]) => void; error: (...args: any[]) => void },
  buildDeviceName: (serialNumber: string, generation: string) => string,
): Promise<DiscoveredDeviceEntry[]> {
  const devices = await Promise.all(
    hosts.map(async (host) => {
      try {
        logger.log(`Connecting to inverter at ${host}...`);
        const inverter = await withTimeout(Inverter.connect({ host }), CONNECT_TIMEOUT_MS, host);
        const snapshot = inverter.getData();
        if (!snapshot.serialNumber || snapshot.serialNumber.trim() === '') {
          await inverter.stop();
          logger.log(`Skipping ${host}: no valid serial number (not a GivEnergy inverter?)`);
          return null;
        }
        const gen = snapshot.generation;
        const device: DiscoveredDeviceEntry = {
          name: buildDeviceName(snapshot.serialNumber, gen),
          data: { id: snapshot.serialNumber },
          store: { host, generation: gen },
        };
        await inverter.stop();
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
