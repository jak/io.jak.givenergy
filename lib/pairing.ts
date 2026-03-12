'use strict';

type InverterIdentity = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterIdentity;

const IDENTIFY_TIMEOUT_MS = 10_000;
const IDENTIFY_RETRIES = 1;

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
      const { discover, getLocalSubnet } = await import('givenergy-modbus');

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
        identifyOptions: {
          timeout: IDENTIFY_TIMEOUT_MS,
          retries: IDENTIFY_RETRIES,
        },
        onScanProgress: () => {
          probeCount++;
          safeEmit('discover_progress', { probeCount });
        },
      });

      logger.log(`Discovery complete: probed ${probeCount} hosts, ${discovered.length} inverter(s)`);

      if (discovered.length === 0) {
        safeEmit('discover_complete', { found: false });
        return;
      }

      discoveredDevices = discovered.map((d) => ({
        name: buildDeviceName(d.serialNumber, d.generation),
        data: { id: d.serialNumber },
        store: { host: d.host, generation: d.generation },
      }));

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

    try {
      const identity = await Inverter.identify({
        host,
        timeout: IDENTIFY_TIMEOUT_MS,
        retries: IDENTIFY_RETRIES,
      });
      discoveredDevices = [{
        name: buildDeviceName(identity.serialNumber, identity.generation),
        data: { id: identity.serialNumber },
        store: { host, generation: identity.generation },
      }];
    } catch (err: any) {
      throw new Error(`Could not connect to inverter at ${host}: ${err?.message ?? err}`);
    }

    await safeShowView('list_devices');
  });

  session.setHandler('list_devices', async () => {
    return discoveredDevices;
  });
}
