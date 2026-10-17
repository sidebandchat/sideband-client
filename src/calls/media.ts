import {
  WebRTCEndpoint,
  type Endpoint,
  type TrackContext,
  type WebRTCEndpointEvents,
} from "@fishjam-cloud/webrtc-client";
import { Socket, type Channel } from "phoenix";
import { parseMediaServerIdentity } from "../transports/media-server-identity.js";
import type { InstanceEndpoint } from "../instance-endpoint.js";
import type {
  ManagedMediaCapture,
  MediaCaptureAdapter,
  MediaCallbacks,
  MediaDisconnectReason,
  RemoteEndpointState,
  TrackMetadata,
} from "./media-types.js";
import type { UserId } from "../entity-id.js";

const SCREEN_SHARE_MAX_FRAMERATE = 30;
const SCREEN_SHARE_MAX_BANDWIDTH_KBPS = 3_000;

type ObservableWebRTCEndpoint = WebRTCEndpoint & {
  on<Event extends keyof WebRTCEndpointEvents>(
    event: Event,
    listener: WebRTCEndpointEvents[Event],
  ): void;
};

export class SidebandMedia {
  private endpoint?: ObservableWebRTCEndpoint;
  private socket?: Socket;
  private channel?: Channel;
  private localStream?: MediaStream;
  private audioCaptureCleanup?: () => void | Promise<void>;
  private cameraCaptureCleanup?: () => void | Promise<void>;
  private screenStream?: MediaStream;
  private presentationCaptureCleanup?: () => void | Promise<void>;
  private applicationAudioCapture?: ManagedMediaCapture;
  private sessionId?: string;
  private endpoints = new Set<string>();
  private endpointIdentities = new Map<string, UserId>();
  private remoteEndpointStates = new Map<string, RemoteEndpointState>();
  private localTrackIds = new Map<string, string>();
  private localEndpointState: RemoteEndpointState = {
    muted: false,
    deafened: false,
  };
  private audioStateChange = Promise.resolve();
  private callbacks: MediaCallbacks;

  constructor(
    callbacks: MediaCallbacks,
    private readonly capture: MediaCaptureAdapter,
  ) {
    this.callbacks = callbacks;
  }

  async join(
    endpoint: InstanceEndpoint,
    roomId: string,
    ticket: string,
    displayName: string,
    inputDeviceId = "",
    muted = false,
    deafened = false,
    sessionId: string = crypto.randomUUID(),
  ) {
    if (this.sessionId)
      throw new Error("Another media session is still active");
    this.sessionId = sessionId;
    this.localEndpointState = { displayName, muted, deafened };
    const audioCapture = await this.capture.captureLocalAudio(inputDeviceId);
    if (this.sessionId !== sessionId) {
      audioCapture.cleanup();
      throw new Error("Media session was cancelled");
    }
    this.localStream = audioCapture.stream;
    this.audioCaptureCleanup = audioCapture.cleanup;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });

    if (this.localStream.getTracks().length === 0) {
      this.callbacks.onError(
        "No microphone was found. Connected in listen-only mode; you can still turn on your camera.",
      );
    }

    this.callbacks.onLocalStream(this.localStream);

    this.socket = new Socket(`${endpoint.baseUrl.replace(/\/$/, "")}/media`, {
      params: { ticket },
    });
    this.socket.connect();
    this.channel = this.socket.channel(`room:${roomId}`);
    await channelJoin(this.channel);
    if (this.sessionId !== sessionId) {
      throw new Error("Media session was cancelled");
    }

    this.endpoint = new WebRTCEndpoint() as ObservableWebRTCEndpoint;
    this.endpoint.on("sendMediaEvent", (event) => {
      this.channel?.push("mediaEvent", event.buffer);
    });
    this.endpoint.on("connectionError", (error) =>
      this.callbacks.onError(error.message),
    );
    this.endpoint.on(
      "connected",
      async (_id: string, otherEndpoints: Endpoint[]) => {
        otherEndpoints.forEach((endpoint) => {
          this.endpoints.add(endpoint.id);
          this.publishRemoteEndpoint(endpoint);
        });
        this.emitParticipantCount();

        for (const track of this.localStream!.getTracks()) {
          const source = track.kind === "audio" ? "microphone" : "camera";
          const trackId = await this.endpoint!.addTrack(track, {
            kind: track.kind,
            source,
            displayName,
          });
          this.localTrackIds.set(track.kind, trackId);

          if (track.kind === "audio") {
            if (muted) {
              await this.endpoint!.replaceTrack(trackId, null);
            } else {
              await this.enableAudioDtx(track);
            }
          }
        }
      },
    );
    this.endpoint.on("trackReady", (context: TrackContext) => {
      if (!context.track) return;
      if (context.track.kind === "audio") {
        context.track.enabled = !this.localEndpointState.deafened;
      }
      const stream = new MediaStream([context.track]);
      this.callbacks.onRemoteStream(
        context.trackId,
        context.endpoint.id,
        stream,
        (context.metadata ?? {}) as TrackMetadata,
      );
    });
    this.endpoint.on("trackRemoved", (context: TrackContext) =>
      this.callbacks.onRemoteTrackRemoved(context.trackId),
    );
    this.endpoint.on("endpointAdded", (endpoint: Endpoint) => {
      this.endpoints.add(endpoint.id);
      this.publishRemoteEndpoint(endpoint);
      this.emitParticipantCount();
    });
    this.endpoint.on("endpointUpdated", (endpoint: Endpoint) => {
      this.publishRemoteEndpoint(endpoint);
    });
    this.endpoint.on("endpointRemoved", (endpoint: Endpoint) => {
      this.endpoints.delete(endpoint.id);
      this.endpointIdentities.delete(endpoint.id);
      this.remoteEndpointStates.delete(endpoint.id);
      this.callbacks.onEndpointRemoved(endpoint.id);
      this.emitParticipantCount();
    });
    this.channel.on("mediaEvent", (event: ArrayBuffer) => {
      this.endpoint?.receiveMediaEvent(new Uint8Array(event));
    });
    let terminalDisconnectReason: MediaDisconnectReason | undefined;
    this.channel.on("mediaDisconnect", (event: { reason?: unknown }) => {
      if (isMediaDisconnectReason(event.reason)) {
        terminalDisconnectReason = event.reason;
      }
    });
    const notifyDisconnected = () => {
      if (this.sessionId !== sessionId) return;
      this.sessionId = undefined;
      this.callbacks.onDisconnected(sessionId, terminalDisconnectReason);
    };
    this.channel.onError(notifyDisconnected);
    this.channel.onClose(notifyDisconnected);
    this.channel.on("peerIdentity", (value: unknown) => {
      const identity = parseMediaServerIdentity(value);
      if (!identity) return;
      this.endpointIdentities.set(identity.endpointId, identity.userId);
      const state = this.remoteEndpointStates.get(identity.endpointId) ?? {
        muted: false,
        deafened: false,
      };
      this.publishRemoteEndpointState(identity.endpointId, state);
    });

    this.endpoint.connect(this.localEndpointState);
  }

  async leave(expectedSessionId?: string, graceful = false) {
    if (
      expectedSessionId &&
      this.sessionId &&
      expectedSessionId !== this.sessionId
    ) {
      return false;
    }

    const endpoint = this.endpoint;
    const channel = this.channel;
    const socket = this.socket;
    const audioCaptureCleanup = this.audioCaptureCleanup;
    const cameraCaptureCleanup = this.cameraCaptureCleanup;
    const presentationCaptureCleanup = this.presentationCaptureCleanup;
    const applicationAudioCapture = this.applicationAudioCapture;

    // Detach the session before asynchronous cleanup so this teardown can
    // never operate on resources installed by a newer session.
    this.sessionId = undefined;
    this.endpoint = undefined;
    this.channel = undefined;
    this.socket = undefined;
    this.localStream = undefined;
    this.audioCaptureCleanup = undefined;
    this.cameraCaptureCleanup = undefined;
    this.screenStream = undefined;
    this.presentationCaptureCleanup = undefined;
    this.applicationAudioCapture = undefined;
    if (graceful && channel && (await gracefulChannelLeave(channel))) {
      this.callbacks.onGroupEnded();
    }
    endpoint?.disconnect();
    audioCaptureCleanup?.();
    await Promise.resolve(cameraCaptureCleanup?.()).catch(() => undefined);
    await Promise.resolve(presentationCaptureCleanup?.()).catch(
      () => undefined,
    );
    await Promise.resolve(applicationAudioCapture?.cleanup()).catch(
      () => undefined,
    );
    if (channel) await channelLeave(channel);
    socket?.disconnect();
    this.callbacks.onLocalStream(undefined);
    this.callbacks.onLocalScreen(undefined);
    this.localTrackIds.clear();
    this.endpoints.clear();
    this.endpointIdentities.clear();
    this.remoteEndpointStates.clear();
    this.localEndpointState = { muted: false, deafened: false };
    this.emitParticipantCount();
    return true;
  }

  setAudioState(muted: boolean, deafened: boolean) {
    this.localEndpointState = {
      ...this.localEndpointState,
      muted,
      deafened,
    };
    this.endpoint?.updateEndpointMetadata(this.localEndpointState);
    Object.values(this.endpoint?.getRemoteTracks() ?? {}).forEach((context) => {
      if (context.track?.kind === "audio") context.track.enabled = !deafened;
    });

    this.audioStateChange = this.audioStateChange
      .then(async () => {
        const track = this.localStream?.getAudioTracks()[0];
        const trackId = this.localTrackIds.get("audio");
        if (!track || !trackId || !this.endpoint) return;

        track.enabled = !muted;
        await this.endpoint.replaceTrack(trackId, muted ? null : track);
        if (!muted) await this.enableAudioDtx(track);
      })
      .catch((error) => {
        this.callbacks.onError(
          error instanceof Error
            ? error.message
            : "Unable to update microphone state",
        );
      });
  }

  async setCameraEnabled(enabled: boolean, displayName: string) {
    if (!this.localStream || !this.endpoint)
      throw new Error("Join a call before turning on your camera");

    const currentTrack = this.localStream.getVideoTracks()[0];
    if (enabled) {
      if (currentTrack) return;

      const cameraCapture = await this.capture.captureCamera();
      const stream = cameraCapture.stream;
      const track = stream.getVideoTracks()[0];
      if (!track) {
        await cameraCapture.cleanup();
        throw new Error("The selected camera could not be captured");
      }

      try {
        const trackId = await this.endpoint.addTrack(track, {
          kind: "video",
          source: "camera",
          displayName,
        });
        this.localTrackIds.set("camera", trackId);
        this.cameraCaptureCleanup = cameraCapture.cleanup;
        this.localStream.addTrack(track);
        this.callbacks.onLocalStream(this.localStream);
      } catch (error) {
        await cameraCapture.cleanup();
        throw error;
      }
      return;
    }

    const trackId = this.localTrackIds.get("camera");
    const cameraCaptureCleanup = this.cameraCaptureCleanup;
    this.cameraCaptureCleanup = undefined;
    this.localTrackIds.delete("camera");
    if (trackId) await this.endpoint.removeTrack(trackId);
    if (currentTrack) {
      this.localStream.removeTrack(currentTrack);
      this.callbacks.onLocalStream(this.localStream);
    }
    await cameraCaptureCleanup?.();
  }

  async selectAudioInput(deviceId: string, muted: boolean) {
    if (!this.localStream || !this.endpoint) return;

    const capture = await this.capture.captureLocalAudio(deviceId);
    const nextTrack = capture.stream.getAudioTracks()[0];
    const previousTrack = this.localStream.getAudioTracks()[0];
    const trackId = this.localTrackIds.get("audio");
    if (!nextTrack || !trackId) {
      capture.cleanup();
      return;
    }

    try {
      nextTrack.enabled = !muted;
      await this.endpoint.replaceTrack(trackId, muted ? null : nextTrack);
      if (!muted) await this.enableAudioDtx(nextTrack);
    } catch (error) {
      capture.cleanup();
      throw error;
    }

    this.audioCaptureCleanup?.();
    if (previousTrack) {
      this.localStream.removeTrack(previousTrack);
      previousTrack.stop();
    }
    this.localStream.addTrack(nextTrack);
    this.audioCaptureCleanup = capture.cleanup;
    this.callbacks.onLocalStream(new MediaStream(this.localStream.getTracks()));
  }

  private async enableAudioDtx(track: MediaStreamTrack) {
    const connection = this.endpoint?.connectionManager?.getConnection();
    const sender = connection
      ?.getSenders()
      .find((candidate) => candidate.track?.id === track.id);
    if (!sender) return;

    const parameters = sender.getParameters();
    if (parameters.encodings.length === 0) parameters.encodings = [{}];

    const encoding = parameters.encodings[0] as RTCRtpEncodingParameters & {
      dtx?: "disabled" | "enabled";
    };
    encoding.dtx = "enabled";

    try {
      await sender.setParameters(parameters);
    } catch (error) {
      this.callbacks.onWarning?.("Opus DTX is unavailable", error);
    }
  }

  async startScreenShare(
    sourceId: string,
    displayName: string,
    shareApplicationAudio = false,
  ) {
    if (!this.endpoint)
      throw new Error("Join a call before sharing your screen");
    await this.stopScreenShare();
    const screenCapture = await this.capture.captureScreen(sourceId);
    const stream = screenCapture.stream;
    let applicationAudio: ManagedMediaCapture | undefined;
    let presentationAttempted = false;
    try {
      if (shareApplicationAudio) {
        applicationAudio = await this.capture.captureApplicationAudio(sourceId);
        const audioTrack = applicationAudio.stream.getAudioTracks()[0];
        if (!audioTrack) throw new Error("The shared audio is unavailable");
        stream.addTrack(audioTrack);
        this.applicationAudioCapture = applicationAudio;
      }
      presentationAttempted = true;
      await this.publishPresentation(
        stream,
        displayName,
        "screen",
        screenCapture.cleanup,
      );
    } catch (error) {
      if (this.applicationAudioCapture === applicationAudio) {
        this.applicationAudioCapture = undefined;
      }
      await applicationAudio?.cleanup();
      if (!presentationAttempted) await screenCapture.cleanup();
      throw error;
    }
  }

  async startCameraShare(deviceId: string, displayName: string) {
    if (!this.endpoint) throw new Error("Join a call before sharing a camera");
    await this.stopScreenShare();
    const cameraCapture = await this.capture.captureCamera(deviceId);
    await this.publishPresentation(
      cameraCapture.stream,
      displayName,
      "camera",
      cameraCapture.cleanup,
    );
  }

  private async publishPresentation(
    stream: MediaStream,
    displayName: string,
    sourceName: "screen" | "camera",
    cleanup: () => void | Promise<void>,
  ) {
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((streamTrack) => streamTrack.stop());
      throw new Error(`The selected ${sourceName} could not be captured`);
    }
    if (sourceName === "screen") track.contentHint = "motion";
    this.screenStream = stream;
    this.presentationCaptureCleanup = cleanup;
    track.onended = () => {
      void this.stopScreenShare();
    };
    let trackId: string | undefined;
    let audioTrackId: string | undefined;
    try {
      trackId = await this.endpoint!.addTrack(
        track,
        { kind: "video", source: sourceName, displayName },
        undefined,
        sourceName === "screen" ? SCREEN_SHARE_MAX_BANDWIDTH_KBPS : 4_000,
        stream,
      );
      this.localTrackIds.set("screen", trackId);
      if (sourceName === "screen") await this.configureScreenShareSender(track);
      const audioTrack = stream.getAudioTracks()[0];
      if (sourceName === "screen" && audioTrack) {
        audioTrackId = await this.endpoint!.addTrack(
          audioTrack,
          { kind: "audio", source: "screen-audio", displayName },
          undefined,
          192,
          new MediaStream([audioTrack]),
        );
        this.localTrackIds.set("screen-audio", audioTrackId);
      }
      await this.rebindAudioAfterRenegotiation();
      this.callbacks.onLocalScreen(stream, sourceName);
    } catch (error) {
      this.localTrackIds.delete("screen");
      this.localTrackIds.delete("screen-audio");
      if (trackId) {
        await this.endpoint!.removeTrack(trackId).catch(() => undefined);
      }
      if (audioTrackId) {
        await this.endpoint!.removeTrack(audioTrackId).catch(() => undefined);
      }
      this.screenStream = undefined;
      this.presentationCaptureCleanup = undefined;
      await cleanup();
      throw error;
    }
  }

  private async configureScreenShareSender(track: MediaStreamTrack) {
    const connection = this.endpoint?.connectionManager?.getConnection();
    const sender = connection
      ?.getSenders()
      .find((candidate) => candidate.track?.id === track.id);
    if (!sender) return;

    const parameters = sender.getParameters();
    parameters.degradationPreference = "maintain-framerate";
    if (parameters.encodings.length === 0) parameters.encodings = [{}];
    parameters.encodings[0].maxFramerate = SCREEN_SHARE_MAX_FRAMERATE;

    try {
      await sender.setParameters(parameters);
    } catch (error) {
      this.callbacks.onWarning?.(
        "Screen-share quality preferences are unavailable",
        error,
      );
    }
  }

  async stopScreenShare() {
    const trackIds = [
      this.localTrackIds.get("screen"),
      this.localTrackIds.get("screen-audio"),
    ].filter((trackId): trackId is string => Boolean(trackId));
    this.localTrackIds.delete("screen");
    this.localTrackIds.delete("screen-audio");
    if (trackIds.length && this.endpoint) {
      for (const trackId of trackIds) await this.endpoint.removeTrack(trackId);
      await this.rebindAudioAfterRenegotiation();
    }
    const applicationAudio = this.applicationAudioCapture;
    this.applicationAudioCapture = undefined;
    await applicationAudio?.cleanup();
    const stream = this.screenStream;
    this.screenStream = undefined;
    const presentationCaptureCleanup = this.presentationCaptureCleanup;
    this.presentationCaptureCleanup = undefined;
    stream?.getTracks().forEach((track) => {
      track.onended = null;
    });
    await presentationCaptureCleanup?.();
    this.callbacks.onLocalScreen(undefined);
  }

  private async rebindAudioAfterRenegotiation() {
    const audioTrackId = this.localTrackIds.get("audio");
    const audioTrack = this.localStream?.getAudioTracks()[0];
    if (
      !this.endpoint ||
      !audioTrackId ||
      !audioTrack ||
      audioTrack.readyState !== "live"
    )
      return;

    await this.endpoint.replaceTrack(
      audioTrackId,
      this.localEndpointState.muted ? null : audioTrack,
    );
    if (!this.localEndpointState.muted) await this.enableAudioDtx(audioTrack);
  }

  private emitParticipantCount() {
    this.callbacks.onParticipants(
      this.endpoints.size + (this.localStream ? 1 : 0),
    );
  }

  private publishRemoteEndpoint(endpoint: Endpoint) {
    const metadata = endpoint.metadata as
      Partial<RemoteEndpointState> | undefined;
    const state = {
      displayName:
        typeof metadata?.displayName === "string"
          ? metadata.displayName
          : undefined,
      muted: metadata?.muted === true,
      deafened: metadata?.deafened === true,
    };
    this.remoteEndpointStates.set(endpoint.id, state);
    this.publishRemoteEndpointState(endpoint.id, state);
  }

  private publishRemoteEndpointState(
    endpointId: string,
    state: RemoteEndpointState,
  ) {
    const userId = this.endpointIdentities.get(endpointId);
    this.callbacks.onRemoteEndpoint(endpointId, {
      ...state,
      ...(userId
        ? { userId, displayName: undefined }
        : { displayName: undefined }),
    });
  }
}

function isMediaDisconnectReason(
  value: unknown,
): value is MediaDisconnectReason {
  return ["authorization_revoked", "policy_violation", "replaced"].includes(
    String(value),
  );
}

function channelJoin(channel: Channel) {
  return new Promise<void>((resolve, reject) => {
    channel
      .join()
      .receive("ok", () => resolve())
      .receive("error", (reason) => reject(new Error(JSON.stringify(reason))))
      .receive("timeout", () =>
        reject(new Error("Timed out connecting to call media")),
      );
  });
}

function channelLeave(channel: Channel) {
  return new Promise<void>((resolve) => {
    channel
      .leave(1_000)
      .receive("ok", resolve)
      .receive("error", resolve)
      .receive("timeout", resolve);
  });
}

function gracefulChannelLeave(channel: Channel) {
  return new Promise<boolean>((resolve) => {
    channel
      .push("leave", {})
      .receive("ok", (response: { ended?: unknown }) =>
        resolve(response?.ended === true),
      )
      .receive("error", () => resolve(false))
      .receive("timeout", () => resolve(false));
  });
}
