import { describe, expect, it, vi } from "vitest";
import type { SbpSession } from "../sbp/session.js";
import type { AccountStateController } from "./state.js";
import { LiveEventController } from "./live-event-controller.js";

describe("LiveEventController", () => {
  it("subscribes once, serializes events, and unsubscribes", async () => {
    let receive: ((frame: never) => void) | undefined;
    const unsubscribe = vi.fn();
    const session = {
      subscribeEvents: vi.fn((listener) => {
        receive = listener;
        return unsubscribe;
      }),
    } as unknown as SbpSession;
    const state = {
      applyEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AccountStateController;
    const controller = new LiveEventController(session, state);

    controller.start();
    controller.start();
    receive?.({} as never);
    await vi.waitFor(() => expect(state.applyEvent).toHaveBeenCalledOnce());

    expect(session.subscribeEvents).toHaveBeenCalledOnce();
    controller.stop();
    controller.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("reports event-application failures", async () => {
    let receive: ((frame: never) => void) | undefined;
    const failure = new Error("invalid event");
    const session = {
      subscribeEvents: (listener: (frame: never) => void) => {
        receive = listener;
        return () => undefined;
      },
    } as unknown as SbpSession;
    const state = {
      applyEvent: vi.fn().mockRejectedValue(failure),
    } as unknown as AccountStateController;
    const onError = vi.fn();
    const controller = new LiveEventController(session, state, onError);

    controller.start();
    receive?.({} as never);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });

  it("allows hosts to ignore event-application failures", async () => {
    let receive: ((frame: never) => void) | undefined;
    const session = {
      subscribeEvents: (listener: (frame: never) => void) => {
        receive = listener;
        return () => undefined;
      },
    } as unknown as SbpSession;
    const state = {
      applyEvent: vi.fn().mockRejectedValue(new Error("invalid event")),
    } as unknown as AccountStateController;

    new LiveEventController(session, state).start();
    receive?.({} as never);

    await vi.waitFor(() => expect(state.applyEvent).toHaveBeenCalledOnce());
  });
});
