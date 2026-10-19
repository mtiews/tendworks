import type { RetryOptions } from "./event-bus.js";

/**
 * Drives one subscription: runs `step` until it reports there is nothing left, one run at
 * a time. A `wake` during a run causes another run. When `step` throws, the pump waits
 * with exponential backoff and tries again; the failed event has not been acknowledged,
 * so it is delivered again.
 */
export class Pump {
  private running: Promise<void> | undefined;
  private again = false;
  private closed = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** Delivers the next event; resolves false when there was none. */
    private readonly step: () => Promise<boolean>,
    private readonly options: RetryOptions & { onError?: (error: unknown) => void } = {},
  ) {}

  wake(): void {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        this.wake();
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    await this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed && (await this.step())) this.failures = 0;
    } catch (error) {
      this.options.onError?.(error);
      const base = this.options.retryDelayMs ?? 1_000;
      const delay = Math.min(base * 2 ** this.failures, this.options.maxRetryDelayMs ?? 60_000);
      this.failures++;
      clearTimeout(this.retryTimer);
      if (!this.closed) this.retryTimer = setTimeout(() => this.wake(), delay);
    }
  }
}
