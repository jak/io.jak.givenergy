const RETRY_DELAYS = [5_000, 15_000, 30_000];

export async function withRetry<T>(fn: () => Promise<T>, log?: (...args: any[]) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isTimeout = err?.message?.includes('timeout');
      if (!isTimeout || attempt >= RETRY_DELAYS.length) throw err;
      log?.(`Inverter timeout, retrying in ${RETRY_DELAYS[attempt] / 1000}s (attempt ${attempt + 2}/${RETRY_DELAYS.length + 1})...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
}
