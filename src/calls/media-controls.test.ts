import { describe, expect, it, vi } from "vitest";
import { MediaControls, usableMediaDevices } from "./media-controls.js";

describe("MediaControls", () => {
  it("preserves pre-deafen mute state", async () => {
    const adapter = mediaAdapter();
    const controls = new MediaControls(adapter);
    await controls.toggleDeafened();
    expect(controls.state).toMatchObject({ muted: true, deafened: true });
    await controls.toggleDeafened();
    expect(controls.state).toMatchObject({ muted: false, deafened: false });
    expect(adapter.setMuted.mock.calls.map(([value]) => value)).toEqual([
      true,
      false,
    ]);
  });

  it("undeafens and unmutes when the microphone is explicitly unmuted", async () => {
    const adapter = mediaAdapter();
    const preferences = {
      load: vi.fn(),
      saveAudio: vi.fn(),
      saveDevice: vi.fn(),
    };
    const controls = new MediaControls(adapter, preferences);

    await controls.toggleDeafened();
    await controls.toggleMuted();

    expect(controls.state).toMatchObject({ muted: false, deafened: false });
    expect(adapter.setDeafened).toHaveBeenLastCalledWith(false);
    expect(adapter.setMuted).toHaveBeenLastCalledWith(false);
    expect(preferences.saveAudio).toHaveBeenLastCalledWith(false, false);
  });

  it("clamps remote volume and restores the previous audible level", () => {
    const adapter = mediaAdapter();
    const controls = new MediaControls(adapter);
    controls.setRemoteVolume("endpoint", 175);
    controls.toggleRemoteMuted("endpoint");
    controls.toggleRemoteMuted("endpoint");
    expect(
      adapter.setRemoteVolume.mock.calls.map(([, value]) => value),
    ).toEqual([175, 0, 175]);
  });

  it("keeps camera selection separate from the microphone", async () => {
    const adapter = mediaAdapter();
    const preferences = {
      load: vi.fn(async () => ({
        muted: false,
        deafened: false,
        inputDeviceId: "",
        outputDeviceId: "",
      })),
      saveAudio: vi.fn(),
      saveDevice: vi.fn(),
    };
    const controls = new MediaControls(adapter, preferences);

    await controls.selectCamera("camera-2");
    await controls.startCameraShare("camera-2");

    expect(adapter.selectCamera).toHaveBeenCalledWith("camera-2");
    expect(adapter.selectInput).not.toHaveBeenCalled();
    expect(adapter.startCameraShare).toHaveBeenCalledWith("camera-2");
    expect(controls.state.cameraDeviceId).toBe("camera-2");
    expect(preferences.saveDevice).toHaveBeenCalledWith("camera", "camera-2");
  });

  it("filters virtual aliases and deduplicates physical devices", () => {
    expect(
      usableMediaDevices([
        device("default", "audio-input", "Default - Desk Mic", "mic-1"),
        device("mic", "audio-input", "Desk Mic", "mic-1"),
        device("mic-copy", "audio-input", "Desk Mic", "mic-1"),
        device("monitor", "audio-input", "Monitor of Speakers"),
        device("rdp", "audio-output", "Remote Audio"),
        device("camera", "video-input", "Webcam", "camera-1"),
        device("camera-copy", "video-input", "Webcam", "camera-1"),
        device("speaker", "audio-output", "Speakers", "speaker-1"),
      ]).map(({ id }) => id),
    ).toEqual(["mic", "camera", "speaker"]);
  });

  it("restores pre-deafen mute state and preserves it across session reset", async () => {
    const adapter = mediaAdapter();
    const preferences = {
      load: vi.fn(async () => ({
        muted: false,
        deafened: true,
        inputDeviceId: "mic",
        outputDeviceId: "speaker",
        cameraDeviceId: "camera",
      })),
      saveAudio: vi.fn(),
      saveDevice: vi.fn(),
    };
    const controls = new MediaControls(adapter, preferences);

    await controls.start();
    controls.resetSession();
    await controls.toggleDeafened();

    expect(controls.state).toMatchObject({
      muted: false,
      deafened: false,
      inputDeviceId: "",
      outputDeviceId: "",
      cameraDeviceId: "",
    });
    expect(adapter.setMuted.mock.calls.map(([muted]) => muted)).toEqual([
      true,
      false,
    ]);
    expect(adapter.selectInput).toHaveBeenCalledWith("mic");
    expect(adapter.selectOutput).toHaveBeenCalledWith("speaker");
    expect(adapter.selectCamera).toHaveBeenCalledWith("camera");
    expect(preferences.saveAudio).toHaveBeenCalledWith(false, false);
  });
});

function device(
  id: string,
  kind: "audio-input" | "audio-output" | "video-input",
  label: string,
  groupId?: string,
) {
  return { id, kind, label, groupId };
}

function mediaAdapter() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    enumerateDevices: vi.fn(async () => []),
    subscribeDevices: vi.fn(() => () => {}),
    setMuted: vi.fn(),
    setDeafened: vi.fn(),
    selectInput: vi.fn(),
    selectCamera: vi.fn(),
    selectOutput: vi.fn(),
    setCameraEnabled: vi.fn(),
    startScreenShare: vi.fn(),
    startCameraShare: vi.fn(),
    stopScreenShare: vi.fn(),
    setRemoteVolume: vi.fn(),
  };
}
