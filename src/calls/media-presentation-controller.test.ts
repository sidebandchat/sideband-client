import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPresentationController } from "./media-presentation-controller";
import { entityId } from "../entity-id";

const ALICE_ID = entityId<"user">("11111111-1111-4111-8111-111111111111");

function createController() {
  const options = {
    onScreenShareStarted: vi.fn(),
    onScreenShareStopped: vi.fn(),
    onEndpointDeparted: vi.fn(),
    onGroupEnded: vi.fn(),
    onError: vi.fn(),
    onDisconnected: vi.fn(),
  };
  return { controller: new MediaPresentationController(options), options };
}

function stream() {
  return {} as MediaStream;
}

beforeEach(() => vi.clearAllMocks());

describe("MediaPresentationController", () => {
  it("publishes local and remote presentation state", () => {
    const { controller } = createController();
    const listener = vi.fn();
    controller.subscribe(listener);
    const local = stream();
    const remote = stream();

    controller.callbacks.onLocalStream(local);
    controller.callbacks.onLocalScreen(local, "camera");
    controller.callbacks.onRemoteEndpoint("endpoint-1", {
      userId: ALICE_ID,
      displayName: "Alice",
      muted: false,
      deafened: false,
    });
    controller.callbacks.onRemoteStream("track-1", "endpoint-1", remote, {
      source: "camera",
      displayName: "Alice",
    });
    controller.callbacks.onParticipants(2);

    expect(controller.state).toMatchObject({
      participants: 2,
      localStream: local,
      localScreen: local,
      localScreenSource: "camera",
      remoteEndpointStates: {
        "endpoint-1": {
          userId: ALICE_ID,
        },
      },
      remoteStreams: {
        "track-1": { endpointId: "endpoint-1", stream: remote },
      },
    });
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it("tracks screen-share transitions without duplicate notifications", () => {
    const { controller, options } = createController();
    const shared = stream();

    controller.callbacks.onLocalScreen(shared, "screen");
    controller.callbacks.onLocalScreen(shared, "screen");
    controller.callbacks.onLocalScreen(undefined);
    controller.callbacks.onRemoteStream("screen-1", "endpoint-1", shared, {
      source: "screen",
    });
    controller.callbacks.onRemoteStream("screen-1", "endpoint-1", shared, {
      source: "screen",
    });
    controller.callbacks.onRemoteTrackRemoved("screen-1");

    expect(options.onScreenShareStarted).toHaveBeenCalledTimes(2);
    expect(options.onScreenShareStopped).toHaveBeenCalledTimes(2);
  });

  it("removes every track for a departed endpoint and exposes its user ID", () => {
    const { controller, options } = createController();
    controller.callbacks.onRemoteEndpoint("endpoint-1", {
      userId: ALICE_ID,
      muted: false,
      deafened: false,
    });
    controller.callbacks.onRemoteStream("camera-1", "endpoint-1", stream(), {
      source: "camera",
    });
    controller.callbacks.onRemoteStream("screen-1", "endpoint-1", stream(), {
      source: "screen",
    });

    controller.callbacks.onEndpointRemoved("endpoint-1");

    expect(controller.state.remoteEndpointStates).toEqual({});
    expect(controller.state.remoteStreams).toEqual({});
    expect(options.onEndpointDeparted).toHaveBeenCalledWith(ALICE_ID);
    expect(options.onScreenShareStopped).toHaveBeenCalledWith(true);
  });

  it("clears remote state while preserving local media", () => {
    const { controller } = createController();
    const local = stream();
    controller.callbacks.onLocalStream(local);
    controller.callbacks.onRemoteEndpoint("endpoint-1", {
      muted: false,
      deafened: false,
    });
    controller.callbacks.onRemoteStream("track-1", "endpoint-1", stream(), {});

    controller.clearRemoteState();

    expect(controller.state.localStream).toBe(local);
    expect(controller.state.remoteEndpointStates).toEqual({});
    expect(controller.state.remoteStreams).toEqual({});
  });

  it("forwards lifecycle callbacks", () => {
    const { controller, options } = createController();
    controller.callbacks.onGroupEnded();
    controller.callbacks.onError("broken");
    controller.callbacks.onDisconnected("session-1", "replaced");

    expect(options.onGroupEnded).toHaveBeenCalledOnce();
    expect(options.onError).toHaveBeenCalledWith("broken");
    expect(options.onDisconnected).toHaveBeenCalledWith(
      "session-1",
      "replaced",
    );
  });

  it("supports consumers that do not install optional presentation effects", () => {
    const controller = new MediaPresentationController({
      onGroupEnded: vi.fn(),
      onError: vi.fn(),
      onDisconnected: vi.fn(),
    });
    const shared = stream();

    controller.callbacks.onLocalScreen(shared, "screen");
    controller.callbacks.onLocalScreen(undefined);
    controller.callbacks.onRemoteStream("screen-1", "endpoint-1", shared, {
      source: "screen",
    });
    controller.callbacks.onRemoteEndpoint("endpoint-1", {
      userId: ALICE_ID,
      muted: false,
      deafened: false,
    });
    controller.callbacks.onEndpointRemoved("endpoint-1");
    controller.reset();
    controller.reset();

    expect(controller.state).toEqual({
      participants: 0,
      remoteStreams: {},
      remoteEndpointStates: {},
    });
  });
});
