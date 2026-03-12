'use strict';

type InverterIdentity = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterIdentity;

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
        safeEmit('discover_complete', { found: false });
        return;
      }

      let probeCount = 0;

      const discovered = await discover({
        subnet,
        onProbe: () => {
          probeCount++;
          safeEmit('discover_progress', { probeCount });
        },
      });

      logger.log(`Discovery complete: probed ${probeCount} hosts, ${discovered.length} inverter(s)`);

      if (discovered.length === 0) {
        safeEmit('discover_complete', { found: false });
        return;
      }

      discoveredDevices = await connectAndBuildDevices(discovered.map(d => d.host), Inverter, logger, buildDeviceName);

      if (discoveredDevices.length > 0) {
        await safeShowView('list_devices');
      } else {
        safeEmit('discover_complete', { found: false });
      }
    } catch (err: any) {
      logger.error('Discovery failed:', err?.message ?? err);
      safeEmit('discover_complete', { found: false });
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

    await safeShowView('list_devices');
  });

  session.setHandler('list_devices', async () => {
    return discoveredDevices;
  });
}

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
