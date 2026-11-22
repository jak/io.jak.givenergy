const RETRY_DELAYS = [5_000, 15_000, 30_000];

export interface RetryContext {
  /** Homey's timers, which are cleared when the app or device is destroyed. */
  homey: { setTimeout(callback: () => void, ms: number): unknown };
  log?: (message: string) => void;
}

/** Run `fn`, retrying after an inverter timeout (5 s, 15 s, 30 s); other errors are thrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, { homey, log }: RetryContext): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes('timeout');
      if (!isTimeout || attempt >= RETRY_DELAYS.length) throw err;
      log?.(`Inverter timeout, retrying in ${RETRY_DELAYS[attempt] / 1000}s (attempt ${attempt + 2}/${RETRY_DELAYS.length + 1})...`);
      await new Promise<void>((resolve) => {
        homey.setTimeout(resolve, RETRY_DELAYS[attempt]);
      });
    }
  }
}
