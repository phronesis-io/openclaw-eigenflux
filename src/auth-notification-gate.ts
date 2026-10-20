const AUTH_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

/** Coalesce host deliveries only; the CLI and Skills own authentication. */
export class AuthNotificationGate {
  private inFlight = false;
  private lastDeliveredAt: number | null = null;

  reset(): void {
    this.lastDeliveredAt = null;
  }

  async deliver(notify: () => Promise<boolean>): Promise<boolean> {
    if (this.inFlight || (this.lastDeliveredAt !== null &&
      Date.now() - this.lastDeliveredAt < AUTH_NOTIFICATION_COOLDOWN_MS)) {
      return false;
    }

    this.inFlight = true;
    try {
      const delivered = await notify();
      if (delivered) this.lastDeliveredAt = Date.now();
      return delivered;
    } finally {
      this.inFlight = false;
    }
  }
}
