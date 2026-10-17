import { describe, expect, it, vi } from "vitest";
import { MediaControls } from "./media-controls.js";

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
});

function mediaAdapter() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    enumerateDevices: vi.fn(async () => []),
    subscribeDevices: vi.fn(() => () => {}),
    setMuted: vi.fn(),
    setDeafened: vi.fn(),
    selectInput: vi.fn(),
    selectOutput: vi.fn(),
    setCameraEnabled: vi.fn(),
    startScreenShare: vi.fn(),
    stopScreenShare: vi.fn(),
    setRemoteVolume: vi.fn(),
  };
}
