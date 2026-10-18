import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebandMedia } from "./media";
import { entityId } from "../entity-id";

const instanceEndpoint = {
  domain: "instance.test",
  baseUrl: "https://instance.test",
};

const mocks = vi.hoisted(() => ({
  endpoint: undefined as FakeEndpoint | undefined,
  channel: undefined as FakeChannel | undefined,
  socket: undefined as FakeSocket | undefined,
  captureLocalAudio: vi.fn(),
  captureApplicationAudio: vi.fn(),
  captureCamera: vi.fn(),
  captureScreen: vi.fn(),
  stopApplicationAudio: vi.fn(),
  joinStatus: "ok" as string,
  leaveStatus: "ok" as string,
  pushStatus: "ok" as string,
}));

class FakeTrack {
  enabled = true;
  onended: (() => void) | null = null;
  readyState = "live";
  contentHint = "";
  applyConstraints = vi.fn().mockResolvedValue(undefined);
  getSettings = vi.fn().mockReturnValue({ sampleRate: 48_000 });
  stop = vi.fn(() => {
    this.readyState = "ended";
  });

  constructor(
    public kind: "audio" | "video",
    public id: string,
  ) {}
}

class FakeStream {
  constructor(private tracks: FakeTrack[] = []) {}
  getTracks = () => [...this.tracks];
  getAudioTracks = () => this.tracks.filter((track) => track.kind === "audio");
  getVideoTracks = () => this.tracks.filter((track) => track.kind === "video");
  addTrack = (track: FakeTrack) => this.tracks.push(track);
  removeTrack = (track: FakeTrack) => {
    this.tracks = this.tracks.filter((candidate) => candidate !== track);
  };
}

class FakeEndpoint {
  listeners = new Map<string, (...args: unknown[]) => unknown>();
  addTrack = vi.fn(async (track: FakeTrack) => `${track.kind}-${track.id}`);
  removeTrack = vi.fn().mockResolvedValue(undefined);
  replaceTrack = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn();
  receiveMediaEvent = vi.fn();
  updateEndpointMetadata = vi.fn();
  remoteTracks: Record<string, { track?: FakeTrack }> = {};
  connectionManager = { getConnection: vi.fn().mockReturnValue(undefined) };

  on(event: string, listener: (...args: unknown[]) => unknown) {
    this.listeners.set(event, listener);
  }
  connect = vi.fn(() => this.emit("connected", "local", []));
  emit(event: string, ...args: unknown[]) {
    return this.listeners.get(event)?.(...args);
  }
  getRemoteTracks = () => this.remoteTracks;
}

class FakeChannel {
  listeners = new Map<string, (...args: unknown[]) => void>();
  push = vi.fn((event: string) =>
    this.response(
      event === "leave" ? { ended: true } : undefined,
      mocks.pushStatus,
    ),
  );
  leave = vi.fn(() => this.response(undefined, mocks.leaveStatus));
  join = vi.fn(() => {
    return this.response(undefined, mocks.joinStatus);
  });
  private response(payload: unknown, result: string) {
    const response = {
      receive: (status: string, callback: (payload?: unknown) => void) => {
        if (status === result) queueMicrotask(() => callback(payload));
        return response;
      },
    };
    return response;
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, listener);
  }
  onError(listener: (...args: unknown[]) => void) {
    this.listeners.set("error", listener);
  }
  onClose(listener: (...args: unknown[]) => void) {
    this.listeners.set("close", listener);
  }
  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.(...args);
  }
}

class FakeSocket {
  connect = vi.fn();
  disconnect = vi.fn();
  channel = vi.fn(() => {
    mocks.channel = new FakeChannel();
    return mocks.channel;
  });
}

vi.mock("@fishjam-cloud/webrtc-client", () => ({
  WebRTCEndpoint: class {
    constructor() {
      mocks.endpoint = new FakeEndpoint();
      return mocks.endpoint;
    }
  },
}));
vi.mock("phoenix", () => ({
  Socket: class {
    constructor() {
      mocks.socket = new FakeSocket();
      return mocks.socket;
    }
  },
}));
function callbacks() {
  return {
    onLocalStream: vi.fn(),
    onLocalScreen: vi.fn(),
    onRemoteStream: vi.fn(),
    onRemoteTrackRemoved: vi.fn(),
    onRemoteEndpoint: vi.fn(),
    onEndpointRemoved: vi.fn(),
    onParticipants: vi.fn(),
    onGroupEnded: vi.fn(),
    onError: vi.fn(),
    onWarning: vi.fn(),
    onDisconnected: vi.fn(),
  };
}

function audioStream(id = "mic") {
  return new FakeStream([new FakeTrack("audio", id)]);
}

const capture = {
  captureLocalAudio: mocks.captureLocalAudio,
  captureApplicationAudio: mocks.captureApplicationAudio,
  captureCamera: mocks.captureCamera,
  captureScreen: mocks.captureScreen,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.endpoint = undefined;
  mocks.channel = undefined;
  mocks.socket = undefined;
  mocks.captureLocalAudio.mockReset();
  mocks.captureLocalAudio.mockImplementation(async () => ({
    stream: audioStream(),
    cleanup: vi.fn(),
  }));
  mocks.captureApplicationAudio.mockReset();
  mocks.captureCamera.mockReset();
  mocks.captureCamera.mockImplementation(async (deviceId?: string) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    return {
      stream,
      cleanup: vi.fn(() => stream.getTracks().forEach((track) => track.stop())),
    };
  });
  mocks.captureScreen.mockReset();
  mocks.captureScreen.mockImplementation(async (sourceId: string) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          maxWidth: 1_920,
          maxHeight: 1_080,
          maxFrameRate: 30,
        },
      } as MediaTrackConstraints,
    });
    return {
      stream,
      cleanup: vi.fn(() => stream.getTracks().forEach((track) => track.stop())),
    };
  });
  mocks.stopApplicationAudio.mockReset();
  mocks.joinStatus = "ok";
  mocks.leaveStatus = "ok";
  mocks.pushStatus = "ok";
  Object.defineProperty(globalThis, "MediaStream", {
    configurable: true,
    value: FakeStream,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(audioStream()) },
  });
});

afterEach(() => vi.restoreAllMocks());

async function joined() {
  const events = callbacks();
  const media = new SidebandMedia(events, capture);
  await media.join(instanceEndpoint, "room-1", "ticket-1", "Alice");
  await vi.waitFor(() => expect(mocks.endpoint?.addTrack).toHaveBeenCalled());
  return { events, media, endpoint: mocks.endpoint! };
}

describe("SidebandMedia", () => {
  it("captures audio, joins the media channel, and publishes its track", async () => {
    const { events, endpoint } = await joined();

    expect(mocks.captureLocalAudio).toHaveBeenCalledWith("");
    expect(mocks.socket?.connect).toHaveBeenCalledOnce();
    expect(mocks.socket?.channel).toHaveBeenCalledWith("room:room-1");
    expect(endpoint.addTrack).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "audio" }),
      { kind: "audio", source: "microphone", displayName: "Alice" },
    );
    expect(events.onLocalStream).toHaveBeenCalled();
    expect(events.onParticipants).toHaveBeenCalledWith(1);
  });

  it("reports when a graceful departure ends the empty group room", async () => {
    const events = callbacks();
    const media = new SidebandMedia(events, capture);
    await media.join(instanceEndpoint, "room-1", "ticket-1", "Alice");

    await media.leave(undefined, true);

    expect(mocks.channel?.push).toHaveBeenCalledWith("leave", {});
    expect(events.onGroupEnded).toHaveBeenCalledOnce();
  });

  it("reports an unexpected channel loss once for the active session", async () => {
    const events = callbacks();
    const media = new SidebandMedia(events, capture);
    await media.join(
      instanceEndpoint,
      "room-1",
      "ticket-1",
      "Alice",
      "",
      false,
      false,
      "session-1",
    );

    mocks.channel?.emit("error");
    mocks.channel?.emit("close");

    expect(events.onDisconnected).toHaveBeenCalledOnce();
    expect(events.onDisconnected).toHaveBeenCalledWith("session-1", undefined);
  });

  it("reports a server policy closure as terminal", async () => {
    const events = callbacks();
    const media = new SidebandMedia(events, capture);
    await media.join(
      instanceEndpoint,
      "room-1",
      "ticket-1",
      "Alice",
      "",
      false,
      false,
      "session-1",
    );

    mocks.channel?.emit("mediaDisconnect", { reason: "replaced" });
    mocks.channel?.emit("close");

    expect(events.onDisconnected).toHaveBeenCalledWith("session-1", "replaced");
  });

  it("routes remote endpoint and track lifecycle events", async () => {
    const { events, endpoint } = await joined();
    const remoteTrack = new FakeTrack("audio", "remote-mic");

    endpoint.emit("endpointAdded", {
      id: "peer-1",
      metadata: { displayName: "Bob", muted: true },
    });
    endpoint.emit("trackReady", {
      trackId: "track-1",
      track: remoteTrack,
      endpoint: { id: "peer-1" },
      metadata: { source: "microphone", displayName: "Bob" },
    });
    endpoint.emit("trackRemoved", { trackId: "track-1" });
    endpoint.emit("endpointRemoved", { id: "peer-1" });

    expect(events.onRemoteEndpoint).toHaveBeenCalledWith("peer-1", {
      displayName: undefined,
      muted: true,
      deafened: false,
    });
    expect(events.onRemoteStream).toHaveBeenCalledWith(
      "track-1",
      "peer-1",
      expect.any(FakeStream),
      expect.objectContaining({ source: "microphone" }),
    );
    expect(events.onRemoteTrackRemoved).toHaveBeenCalledWith("track-1");
    expect(events.onEndpointRemoved).toHaveBeenCalledWith("peer-1");
  });

  it("uses the server-authenticated user ID instead of client display metadata", async () => {
    const { events, endpoint } = await joined();
    const userId = entityId<"user">("11111111-1111-4111-8111-111111111111");

    endpoint.emit("endpointAdded", {
      id: "peer-1",
      metadata: { displayName: "Impersonated name", muted: false },
    });
    mocks.channel?.listeners.get("peerIdentity")?.({
      endpointId: "peer-1",
      userId,
    });

    expect(events.onRemoteEndpoint).toHaveBeenLastCalledWith("peer-1", {
      userId,
      displayName: undefined,
      muted: false,
      deafened: false,
    });
  });

  it("replaces the published microphone when mute state changes", async () => {
    const { media, endpoint } = await joined();
    const remoteAudio = new FakeTrack("audio", "remote-audio");
    const remoteVideo = new FakeTrack("video", "remote-screen");
    endpoint.remoteTracks = {
      audio: { track: remoteAudio },
      video: { track: remoteVideo },
    };
    media.setAudioState(true, true);
    await vi.waitFor(() =>
      expect(endpoint.replaceTrack).toHaveBeenCalledWith("audio-mic", null),
    );
    expect(endpoint.updateEndpointMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ muted: true, deafened: true }),
    );
    expect(remoteAudio.enabled).toBe(true);
    expect(remoteVideo.enabled).toBe(true);

    media.setAudioState(false, false);
    await vi.waitFor(() =>
      expect(endpoint.replaceTrack).toHaveBeenLastCalledWith(
        "audio-mic",
        expect.objectContaining({ kind: "audio" }),
      ),
    );
    expect(remoteAudio.enabled).toBe(true);
    expect(remoteVideo.enabled).toBe(true);
  });

  it("keeps newly received media enabled while deafened", async () => {
    const { media, endpoint } = await joined();
    const remoteAudio = new FakeTrack("audio", "remote-audio");
    const remoteVideo = new FakeTrack("video", "remote-screen");

    media.setAudioState(false, true);
    endpoint.emit("trackReady", {
      trackId: "audio-1",
      track: remoteAudio,
      endpoint: { id: "peer-1" },
      metadata: { source: "microphone" },
    });
    endpoint.emit("trackReady", {
      trackId: "video-1",
      track: remoteVideo,
      endpoint: { id: "peer-1" },
      metadata: { source: "screen" },
    });

    expect(remoteAudio.enabled).toBe(true);
    expect(remoteVideo.enabled).toBe(true);
  });

  it("publishes and stops a screen share", async () => {
    const { events, media, endpoint } = await joined();
    const screenTrack = new FakeTrack("video", "screen");
    const screen = new FakeStream([screenTrack]);
    const setParameters = vi.fn().mockResolvedValue(undefined);
    endpoint.connectionManager.getConnection.mockReturnValue({
      getSenders: () => [
        {
          track: screenTrack,
          getParameters: () => ({ encodings: [] }),
          setParameters,
        },
      ],
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(
      screen as unknown as MediaStream,
    );

    await media.startScreenShare("screen:1", "Alice");
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: "screen:1",
          maxWidth: 1_920,
          maxHeight: 1_080,
          maxFrameRate: 30,
        },
      },
    });
    expect(endpoint.addTrack).toHaveBeenCalledWith(
      screenTrack,
      { kind: "video", source: "screen", displayName: "Alice" },
      undefined,
      8_000,
      screen,
    );
    expect(screenTrack.contentHint).toBe("detail");
    expect(setParameters).toHaveBeenCalledWith({
      degradationPreference: "maintain-resolution",
      encodings: [{ maxFramerate: 30 }],
    });
    expect(events.onLocalScreen).toHaveBeenCalledWith(screen, "screen");

    await media.stopScreenShare();
    expect(endpoint.removeTrack).toHaveBeenCalledWith("video-screen");
    expect(screenTrack.stop).toHaveBeenCalledOnce();
    expect(events.onLocalScreen).toHaveBeenLastCalledWith(undefined);
  });

  it("publishes application audio as a separate screen track", async () => {
    const { media, endpoint } = await joined();
    const screenTrack = new FakeTrack("video", "screen");
    const applicationTrack = new FakeTrack("audio", "application");
    const screen = new FakeStream([screenTrack]);
    mocks.captureApplicationAudio.mockResolvedValue({
      stream: new FakeStream([applicationTrack]),
      cleanup: mocks.stopApplicationAudio,
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(
      screen as unknown as MediaStream,
    );

    await media.startScreenShare("window:42:0", "Alice", true);

    expect(mocks.captureApplicationAudio).toHaveBeenCalledWith("window:42:0");
    expect(endpoint.addTrack).toHaveBeenCalledWith(
      applicationTrack,
      { kind: "audio", source: "screen-audio", displayName: "Alice" },
      undefined,
      192,
      expect.any(FakeStream),
    );
    await media.stopScreenShare();
    expect(endpoint.removeTrack).toHaveBeenCalledWith("audio-application");
    expect(mocks.stopApplicationAudio).toHaveBeenCalledOnce();
  });

  it("switches input devices and cleans up all media on leave", async () => {
    const initialStream = audioStream("first");
    const initialTrack = initialStream.getAudioTracks()[0];
    mocks.captureLocalAudio.mockResolvedValueOnce({
      stream: initialStream,
      cleanup: vi.fn(),
    });
    const events = callbacks();
    const media = new SidebandMedia(events, capture);
    await media.join(instanceEndpoint, "room", "ticket", "Alice");
    await vi.waitFor(() => expect(mocks.endpoint?.addTrack).toHaveBeenCalled());
    const replacement = audioStream("second");
    mocks.captureLocalAudio.mockResolvedValueOnce({
      stream: replacement,
      cleanup: vi.fn(),
    });

    await media.selectAudioInput("mic-2", false);
    expect(mocks.captureLocalAudio).toHaveBeenLastCalledWith("mic-2");
    expect(mocks.endpoint?.replaceTrack).toHaveBeenCalledWith(
      "audio-first",
      expect.objectContaining({ id: "second" }),
    );
    expect(initialTrack.stop).toHaveBeenCalled();

    await media.leave();
    expect(mocks.endpoint?.disconnect).toHaveBeenCalledOnce();
    expect(mocks.channel?.leave).toHaveBeenCalledOnce();
    expect(mocks.socket?.disconnect).toHaveBeenCalledOnce();
    expect(events.onLocalStream).toHaveBeenLastCalledWith(undefined);
    expect(events.onParticipants).toHaveBeenLastCalledWith(0);
    mocks.channel?.emit("close");
    expect(events.onDisconnected).not.toHaveBeenCalled();
  });

  it("does not let stale cleanup disconnect a newer media session", async () => {
    const media = new SidebandMedia(callbacks(), capture);
    await media.join(
      instanceEndpoint,
      "room-1",
      "ticket-1",
      "Alice",
      "",
      false,
      false,
      "session-1",
    );
    await media.leave("session-1");

    await media.join(
      instanceEndpoint,
      "room-2",
      "ticket-2",
      "Alice",
      "",
      false,
      false,
      "session-2",
    );
    const currentEndpoint = mocks.endpoint!;
    const currentSocket = mocks.socket!;

    await expect(media.leave("session-1")).resolves.toBe(false);
    expect(currentEndpoint.disconnect).not.toHaveBeenCalled();
    expect(currentSocket.disconnect).not.toHaveBeenCalled();

    await media.leave("session-2");
  });

  it("does not finish a join after that session was cancelled", async () => {
    let resolveCapture!: (stream: MediaStream) => void;
    mocks.captureLocalAudio.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCapture = (stream) =>
          resolve({
            stream,
            cleanup: () => stream.getTracks().forEach((track) => track.stop()),
          });
      }),
    );
    const media = new SidebandMedia(callbacks(), capture);
    const joining = media.join(
      instanceEndpoint,
      "room-1",
      "ticket-1",
      "Alice",
      "",
      false,
      false,
      "cancelled-session",
    );
    await vi.waitFor(() => expect(mocks.captureLocalAudio).toHaveBeenCalled());

    await media.leave("cancelled-session");
    const captured = audioStream("cancelled");
    resolveCapture(captured as unknown as MediaStream);

    await expect(joining).rejects.toThrow("cancelled");
    expect(captured.getAudioTracks()[0].stop).toHaveBeenCalled();
    expect(mocks.socket).toBeUndefined();
  });

  it("routes signaling events and rejects unauthenticated identity metadata", async () => {
    const { events, endpoint } = await joined();
    const payload = new Uint8Array([1, 2, 3]);

    endpoint.emit("sendMediaEvent", { buffer: payload });
    expect(mocks.channel?.push).toHaveBeenCalledWith("mediaEvent", payload);
    mocks.channel?.emit("mediaEvent", payload.buffer);
    expect(endpoint.receiveMediaEvent).toHaveBeenCalledWith(
      expect.any(Uint8Array),
    );
    endpoint.emit("connectionError", { message: "ICE failed" });
    expect(events.onError).toHaveBeenCalledWith("ICE failed");

    endpoint.emit("endpointUpdated", {
      id: "peer-1",
      metadata: { muted: true, deafened: true },
    });
    mocks.channel?.emit("peerIdentity", { endpointId: 3, address: null });
    expect(events.onRemoteEndpoint).toHaveBeenCalledWith("peer-1", {
      displayName: undefined,
      muted: true,
      deafened: true,
    });

    mocks.channel?.emit("mediaDisconnect", { reason: "unknown" });
    mocks.channel?.emit("close");
    expect(events.onDisconnected).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
    );
  });

  it("enables and disables a camera track", async () => {
    const { events, media, endpoint } = await joined();
    const cameraTrack = new FakeTrack("video", "camera");
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(
      new FakeStream([cameraTrack]) as unknown as MediaStream,
    );

    await media.setCameraEnabled(true, "Alice", "camera-2");
    expect(mocks.captureCamera).toHaveBeenCalledWith("camera-2");
    expect(endpoint.addTrack).toHaveBeenCalledWith(cameraTrack, {
      kind: "video",
      source: "camera",
      displayName: "Alice",
    });
    await media.setCameraEnabled(true, "Alice", "camera-2");
    await media.setCameraEnabled(false, "Alice");
    expect(endpoint.removeTrack).toHaveBeenCalledWith("video-camera");
    expect(cameraTrack.stop).toHaveBeenCalledOnce();
    expect(events.onLocalStream).toHaveBeenCalled();
  });

  it("reports listen-only mode and publishes a muted microphone", async () => {
    const events = callbacks();
    mocks.captureLocalAudio.mockResolvedValueOnce({
      stream: new FakeStream(),
      cleanup: vi.fn(),
    });
    const listenOnly = new SidebandMedia(events, capture);
    await listenOnly.join(instanceEndpoint, "room", "ticket", "Alice");
    expect(events.onError).toHaveBeenCalledWith(
      expect.stringContaining("listen-only mode"),
    );
    await listenOnly.leave();

    const mutedEvents = callbacks();
    const muted = new SidebandMedia(mutedEvents, capture);
    await muted.join(instanceEndpoint, "room", "ticket", "Alice", "", true);
    await vi.waitFor(() =>
      expect(mocks.endpoint?.replaceTrack).toHaveBeenCalledWith(
        "audio-mic",
        null,
      ),
    );
  });

  it("configures Opus DTX when an RTP sender is available", async () => {
    const parameters = { encodings: [] as Record<string, unknown>[] };
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const { media, endpoint } = await joined();
    endpoint.connectionManager.getConnection.mockReturnValue({
      getSenders: () => [
        {
          track: { id: "mic" },
          getParameters: () => parameters,
          setParameters,
        },
      ],
    });
    media.setAudioState(false, false);
    await vi.waitFor(() => expect(setParameters).toHaveBeenCalled());
    expect(parameters.encodings).toEqual([{ dtx: "enabled" }]);
  });

  it("cleans rejected replacement audio and presentation captures", async () => {
    const { media, endpoint } = await joined();
    const replacement = audioStream("replacement");
    const cleanup = vi.fn();
    mocks.captureLocalAudio.mockResolvedValueOnce({
      stream: replacement,
      cleanup,
    });
    endpoint.replaceTrack.mockRejectedValueOnce(new Error("replace failed"));
    await expect(media.selectAudioInput("mic-2", false)).rejects.toThrow(
      "replace failed",
    );
    expect(cleanup).toHaveBeenCalledOnce();

    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(
      new FakeStream() as unknown as MediaStream,
    );
    await expect(media.startCameraShare("camera-1", "Alice")).rejects.toThrow(
      "could not be captured",
    );
  });

  it("ignores an input capture that contains no audio track", async () => {
    const { media, endpoint } = await joined();
    const cleanup = vi.fn();
    mocks.captureLocalAudio.mockResolvedValueOnce({
      stream: new FakeStream(),
      cleanup,
    });

    await media.selectAudioInput("empty-device", false);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(endpoint.replaceTrack).not.toHaveBeenCalledWith(
      "audio-mic",
      expect.anything(),
    );
  });

  it("rejects media operations before joining a call", async () => {
    const media = new SidebandMedia(callbacks(), capture);
    await expect(media.setCameraEnabled(true, "Alice")).rejects.toThrow(
      "Join a call",
    );
    await expect(media.startScreenShare("screen:1", "Alice")).rejects.toThrow(
      "Join a call",
    );
    await expect(media.startCameraShare("camera-1", "Alice")).rejects.toThrow(
      "Join a call",
    );
    await expect(
      media.selectAudioInput("mic-2", false),
    ).resolves.toBeUndefined();
  });

  it.each(["error", "timeout"])(
    "reports a %s response while joining the media channel",
    async (status) => {
      mocks.joinStatus = status;
      const media = new SidebandMedia(callbacks(), capture);

      await expect(
        media.join(instanceEndpoint, "room", "ticket", "Alice"),
      ).rejects.toThrow();
    },
  );

  it.each(["error", "timeout"])(
    "completes cleanup after a channel leave %s response",
    async (status) => {
      const media = new SidebandMedia(callbacks(), capture);
      await media.join(instanceEndpoint, "room", "ticket", "Alice");
      mocks.leaveStatus = status;

      await expect(media.leave()).resolves.toBe(true);
    },
  );

  it.each(["error", "timeout"])(
    "does not report a group ending when graceful leave returns %s",
    async (status) => {
      const events = callbacks();
      const media = new SidebandMedia(events, capture);
      await media.join(instanceEndpoint, "room", "ticket", "Alice");
      mocks.pushStatus = status;

      await media.leave(undefined, true);

      expect(events.onGroupEnded).not.toHaveBeenCalled();
    },
  );

  it("guards duplicate joins and incomplete remote events", async () => {
    const { events, media, endpoint } = await joined();
    const userId = entityId<"user">("22222222-2222-4222-8222-222222222222");

    await expect(
      media.join(instanceEndpoint, "other", "ticket", "Alice"),
    ).rejects.toThrow("Another media session");
    endpoint.emit("trackReady", {
      trackId: "missing-track",
      endpoint: { id: "peer-1" },
    });
    mocks.channel?.emit("peerIdentity", {
      endpointId: "peer-2",
      userId,
    });
    endpoint.emit("endpointAdded", { id: "peer-3" });

    expect(events.onRemoteStream).not.toHaveBeenCalledWith(
      "missing-track",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(events.onRemoteEndpoint).toHaveBeenCalledWith(
      "peer-2",
      expect.objectContaining({
        userId,
      }),
    );
  });

  it("cleans up camera capture when publication fails", async () => {
    const { media, endpoint } = await joined();
    const cameraTrack = new FakeTrack("video", "camera");
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(
      new FakeStream([cameraTrack]) as unknown as MediaStream,
    );
    endpoint.addTrack.mockRejectedValueOnce(new Error("publish failed"));

    await expect(media.setCameraEnabled(true, "Alice")).rejects.toThrow(
      "publish failed",
    );
    expect(cameraTrack.stop).toHaveBeenCalledOnce();
  });

  it("publishes a selected camera as a presentation", async () => {
    const { events, media, endpoint } = await joined();
    const cameraTrack = new FakeTrack("video", "presentation-camera");
    const stream = new FakeStream([cameraTrack]);
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(
      stream as unknown as MediaStream,
    );

    await media.startCameraShare("camera-2", "Alice");

    expect(endpoint.addTrack).toHaveBeenCalledWith(
      cameraTrack,
      { kind: "video", source: "camera", displayName: "Alice" },
      undefined,
      4_000,
      stream,
    );
    expect(events.onLocalScreen).toHaveBeenCalledWith(stream, "camera");
  });

  it("rejects application audio captures without an audio track", async () => {
    const { media } = await joined();
    const screenTrack = new FakeTrack("video", "screen");
    const screen = new FakeStream([screenTrack]);
    const cleanup = vi.fn();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(
      screen as unknown as MediaStream,
    );
    mocks.captureApplicationAudio.mockResolvedValueOnce({
      stream: new FakeStream(),
      cleanup,
    });

    await expect(
      media.startScreenShare("window:1:0", "Alice", true),
    ).rejects.toThrow("shared audio is unavailable");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(screenTrack.stop).toHaveBeenCalledOnce();
  });

  it("tolerates unsupported RTP sender preferences", async () => {
    const { events, media, endpoint } = await joined();
    const audioParameters = { encodings: [{}] };
    endpoint.connectionManager.getConnection.mockReturnValue({
      getSenders: () => [
        {
          track: { id: "mic" },
          getParameters: () => audioParameters,
          setParameters: vi.fn().mockRejectedValue(new Error("unsupported")),
        },
      ],
    });

    media.setAudioState(false, false);
    await vi.waitFor(() =>
      expect(events.onWarning).toHaveBeenCalledWith(
        "Opus DTX is unavailable",
        expect.any(Error),
      ),
    );
    expect(audioParameters.encodings).toEqual([{ dtx: "enabled" }]);
  });
});
