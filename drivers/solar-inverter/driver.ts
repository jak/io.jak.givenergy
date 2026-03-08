'use strict';

import Homey from 'homey';

module.exports = class SolarInverterDriver extends Homey.Driver {

  async onInit() {
    this.log('SolarInverterDriver initialized');
  }

  async onPair(session: any) {
    let userHost: string | null = null;
    let userSubnet: string | null = null;

    session.setHandler('login', async (data: { username: string; password: string }) => {
      // username = IP address, password = subnet (repurposed fields)
      userHost = data.username?.trim() || null;
      userSubnet = data.password?.trim() || null;
      this.log(`Login handler: host=${userHost}, subnet=${userSubnet}`);

      if (!userHost && !userSubnet) {
        throw new Error('Please enter an IP address or a subnet to scan.');
      }

      return true;
    });

    session.setHandler('list_devices', async () => {
      if (userHost) {
        // Direct connection to a specific IP
        this.log(`Connecting to inverter at ${userHost}:8899...`);
        try {
          const { GivEnergyInverter } = await import('givenergy-modbus');
          const inverter = await GivEnergyInverter.connect({ host: userHost });
          inverter.on('debug', (msg: string) => this.log(`[modbus] ${msg}`));
          const snapshot = inverter.getData();
          const gen = snapshot.generation;
          const device = {
            name: `GivEnergy ${snapshot.serialNumber} (${gen})`,
            data: { id: snapshot.serialNumber },
            store: { host: userHost, generation: gen },
          };
          await inverter.stop();
          this.log(`Found inverter: ${device.name} at ${userHost}`);
          return [device];
        } catch (err: any) {
          this.error(`Failed to connect to ${userHost}:`, err?.message ?? err);
          throw new Error(`Could not connect to inverter at ${userHost}: ${err?.message ?? 'unknown error'}`);
        }
      }

      if (userSubnet) {
        // Subnet discovery
        this.log(`Starting discovery on ${userSubnet}...`);
        try {
          const { discover, GivEnergyInverter } = await import('givenergy-modbus');
          let probeCount = 0;
          let openCount = 0;
          const discovered = await discover({
            subnet: userSubnet,
            onProbe: (host: string, open: boolean) => {
              probeCount++;
              if (open) {
                openCount++;
                this.log(`Probe ${host}: OPEN (port 8899 reachable)`);
              }
            },
          });
          this.log(`Discovery complete: probed ${probeCount} hosts, ${openCount} open, ${discovered.length} inverter(s)`);

          const devices = await Promise.all(
            discovered.map(async (d) => {
              try {
                this.log(`Connecting to inverter at ${d.host}...`);
                const inverter = await GivEnergyInverter.connect({ host: d.host });
                const snapshot = inverter.getData();
                const gen = snapshot.generation;
                const name = `GivEnergy ${snapshot.serialNumber} (${gen})`;
                const device = {
                  name,
                  data: { id: snapshot.serialNumber },
                  store: { host: d.host, generation: gen },
                };
                await inverter.stop();
                this.log(`Found inverter: ${name} at ${d.host}`);
                return device;
              } catch (err) {
                this.error(`Failed to connect to inverter at ${d.host}:`, err);
                return null;
              }
            })
          );

          return devices.filter((d): d is NonNullable<typeof d> => d !== null);
        } catch (err) {
          this.error('Discovery failed:', err);
          throw new Error(`Discovery failed on ${userSubnet}`);
        }
      }

      return [];
    });
  }
};
