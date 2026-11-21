'use strict';

// Web API for the app's Schedules settings page (settings/index.html).

interface Request {
  homey: any;
  params: Record<string, string>;
  body: unknown;
}

module.exports = {
  async getInverters({ homey }: Request) {
    return homey.app.listSchedules();
  },

  async putSchedule({ homey, params, body }: Request) {
    return homey.app.saveSchedule(params.serial, body);
  },
};
