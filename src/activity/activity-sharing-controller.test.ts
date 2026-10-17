import { afterEach, describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import {
  ACTIVITY_REFRESH_MS,
  ActivitySharingController,
  PAUSED_ACTIVITY_GRACE_MS,
  selectActivitySession,
  type ActivitySharingPlatform,
  type MediaActivityChange,
  type MediaActivitySession,
} from "./activity-sharing-controller.js";

afterEach(() => vi.useRealTimers());

const ALICE_ID = entityId<"user">("11111111-1111-4111-8111-111111111111");

const session = (
  id: string,
  applicationId: string,
  playbackState: MediaActivitySession["playbackState"],
): MediaActivitySession => ({
  id,
  applicationId,
  playbackState,
  platform: "win32",
  platformValues: [],
});

function setup(
  initialSessions: MediaActivitySession[],
  preference = { enabled: true, applicationId: "" },
) {
  let listener: ((change: MediaActivityChange) => void) | undefined;
  const publishTune = vi.fn().mockResolvedValue(undefined);
  const platform: ActivitySharingPlatform = {
    loadPreference: vi.fn().mockResolvedValue(preference),
    savePreference: vi.fn().mockResolvedValue(undefined),
    startSessions: vi.fn().mockResolvedValue({
      capabilities: {
        platform: "win32",
        supported: true,
        availability: "available",
        sessionEnumeration: true,
        eventNotifications: true,
        artwork: true,
        trackIds: true,
        trackUris: true,
        positionNotifications: true,
        notes: [],
      },
      sessions: initialSessions,
    }),
    stopSessions: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((next) => {
      listener = next;
      return vi.fn();
    }),
  };
  const runtime = new ActivitySharingController({
    context: {
      account: ALICE_ID,
      connected: true,
    },
    platform,
    publishTune,
    formatError: String,
  });
  return {
    runtime,
    platform,
    publishTune,
    change: (change: MediaActivityChange) => listener?.(change),
  };
}

describe("ActivitySharingController", () => {
  it("publishes playing activity and ignores position-only notifications", async () => {
    vi.useFakeTimers();
    const playing = {
      ...session("spotify", "Spotify.exe", "playing"),
      title: "Dreams",
      positionMs: 10_000,
      durationMs: 240_000,
    };
    const { runtime, publishTune, change } = setup([playing]);

    runtime.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(publishTune).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Dreams", positionMs: 10_000 }),
    );
    publishTune.mockClear();

    change({ kind: "changed", session: { ...playing, positionMs: 11_000 } });
    expect(publishTune).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS);
    expect(publishTune).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Dreams", playbackState: "playing" }),
    );
    runtime.dispose();
  });

  it("keeps the last playing activity during the paused grace period", async () => {
    vi.useFakeTimers();
    const playing = {
      ...session("spotify", "Spotify.exe", "playing"),
      title: "Dreams",
    };
    const { runtime, publishTune, change } = setup([playing]);
    runtime.start();
    await Promise.resolve();
    await Promise.resolve();
    publishTune.mockClear();

    change({
      kind: "changed",
      session: { ...playing, playbackState: "paused" },
    });
    await vi.advanceTimersByTimeAsync(PAUSED_ACTIVITY_GRACE_MS - 1);
    expect(publishTune).not.toHaveBeenCalledWith(undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishTune).toHaveBeenLastCalledWith(undefined);
    runtime.dispose();
  });

  it("persists preferences and rolls an optimistic change back on failure", async () => {
    const { runtime, platform } = setup([]);
    runtime.start();
    await vi.waitFor(() => expect(runtime.state.loading).toBe(false));
    await vi.waitFor(() => expect(platform.startSessions).toHaveBeenCalled());
    vi.mocked(platform.savePreference).mockRejectedValueOnce(new Error("disk"));

    await runtime.setEnabled(false);

    expect(runtime.state.enabled).toBe(true);
    expect(runtime.state.error).toContain("disk");
    runtime.dispose();
  });

  it("stops publishing while disconnected and resumes current activity on reconnect", async () => {
    const playing = {
      ...session("spotify", "Spotify.exe", "playing"),
      title: "Dreams",
    };
    const { runtime, publishTune } = setup([playing]);
    runtime.start();
    await Promise.resolve();
    await Promise.resolve();
    publishTune.mockClear();

    runtime.updateContext({
      account: ALICE_ID,
      connected: false,
    });
    runtime.updateContext({
      account: ALICE_ID,
      connected: true,
    });

    expect(publishTune).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Dreams" }),
    );
    runtime.dispose();
  });
});

describe("selectActivitySession", () => {
  it("prefers playing media within the configured application", () => {
    expect(
      selectActivitySession(
        [
          session("browser", "Chrome.exe", "playing"),
          session("paused", "Spotify.exe", "paused"),
          session("playing", "Spotify.exe", "playing"),
        ],
        "Spotify.exe",
      )?.id,
    ).toBe("playing");
  });

  it("returns no session when the configured application is unavailable", () => {
    expect(
      selectActivitySession(
        [session("browser", "Chrome.exe", "playing")],
        "Spotify.exe",
      ),
    ).toBeUndefined();
  });
});
