import type { SbpSession } from "../sbp/session.js";
import type { AccountStateController } from "./state.js";

/** Applies transient events received while the authenticated session is live. */
export class LiveEventController {
  private unsubscribe?: () => void;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: SbpSession,
    private readonly state: AccountStateController,
    private readonly onError: (reason: unknown) => void = () => {},
  ) {}

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.session.subscribeEvents((frame) => {
      this.queue = this.queue
        .then(() => this.state.applyEvent(frame).then(() => undefined))
        .catch((reason) => this.onError(reason));
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.queue = Promise.resolve();
  }
}
