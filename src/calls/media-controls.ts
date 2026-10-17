import type {
  CallMediaAdapter,
  CallMediaDevice,
  CallMediaPreferences,
} from "../client/platform-adapters.js";

export type MediaControlsState = {
  devices: CallMediaDevice[];
  inputDeviceId: string;
  outputDeviceId: string;
  muted: boolean;
  deafened: boolean;
  cameraEnabled: boolean;
  screenSharing: boolean;
  remoteVolumes: Readonly<Record<string, number>>;
};

export class MediaControls {
  private current: MediaControlsState = {
    devices: [],
    inputDeviceId: "",
    outputDeviceId: "",
    muted: false,
    deafened: false,
    cameraEnabled: false,
    screenSharing: false,
    remoteVolumes: {},
  };
  private listeners = new Set<() => void>();
  private previousVolumes = new Map<string, number>();
  private unsubscribeDevices?: () => void;
  private mutedBeforeDeafen = false;
  constructor(
    readonly adapter: CallMediaAdapter,
    private readonly preferences?: CallMediaPreferences,
  ) {}
  get state() {
    return this.current;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  async start() {
    if (this.unsubscribeDevices) return;
    this.unsubscribeDevices = this.adapter.subscribeDevices(
      () => void this.refreshDevices(),
    );
    await Promise.all([this.restore(), this.refreshDevices()]);
  }
  stop() {
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = undefined;
    this.previousVolumes.clear();
    this.set({
      ...this.current,
      remoteVolumes: {},
      cameraEnabled: false,
      screenSharing: false,
    });
  }
  async refreshDevices() {
    const devices = await this.adapter.enumerateDevices().catch(() => []);
    const inputDeviceId = available(
      devices,
      "audio-input",
      this.current.inputDeviceId,
    )
      ? this.current.inputDeviceId
      : "";
    const outputDeviceId = available(
      devices,
      "audio-output",
      this.current.outputDeviceId,
    )
      ? this.current.outputDeviceId
      : "";
    this.set({ ...this.current, devices, inputDeviceId, outputDeviceId });
  }
  async selectInput(deviceId: string) {
    await this.adapter.selectInput(deviceId);
    this.set({ ...this.current, inputDeviceId: deviceId });
    await this.preferences?.saveDevice("input", deviceId);
  }
  async selectOutput(deviceId: string) {
    await this.adapter.selectOutput(deviceId);
    this.set({ ...this.current, outputDeviceId: deviceId });
    await this.preferences?.saveDevice("output", deviceId);
  }
  async toggleMuted() {
    if (this.current.deafened) return;
    const muted = !this.current.muted;
    await this.adapter.setMuted(muted);
    this.set({ ...this.current, muted });
    await this.preferences?.saveAudio(muted, false);
  }
  async toggleDeafened() {
    const deafened = !this.current.deafened;
    if (deafened) this.mutedBeforeDeafen = this.current.muted;
    const muted = deafened ? true : this.mutedBeforeDeafen;
    await this.adapter.setDeafened(deafened);
    await this.adapter.setMuted(muted);
    this.set({ ...this.current, deafened, muted });
    await this.preferences?.saveAudio(this.mutedBeforeDeafen, deafened);
  }
  async toggleCamera() {
    const cameraEnabled = !this.current.cameraEnabled;
    await this.adapter.setCameraEnabled(cameraEnabled);
    this.set({ ...this.current, cameraEnabled });
  }
  async startScreenShare(sourceId: string, applicationAudio = false) {
    await this.adapter.startScreenShare(sourceId, applicationAudio);
    this.set({ ...this.current, screenSharing: true });
  }
  async stopScreenShare() {
    await this.adapter.stopScreenShare();
    this.set({ ...this.current, screenSharing: false });
  }
  setRemoteVolume(endpointId: string, value: number) {
    const volume = Math.max(0, Math.min(200, Math.round(value)));
    if (volume > 0) this.previousVolumes.set(endpointId, volume);
    this.adapter.setRemoteVolume(endpointId, volume);
    this.set({
      ...this.current,
      remoteVolumes: { ...this.current.remoteVolumes, [endpointId]: volume },
    });
  }
  toggleRemoteMuted(endpointId: string) {
    const current = this.current.remoteVolumes[endpointId] ?? 100;
    this.setRemoteVolume(
      endpointId,
      current === 0 ? (this.previousVolumes.get(endpointId) ?? 100) : 0,
    );
  }
  private async restore() {
    if (!this.preferences) return;
    const saved = await this.preferences.load();
    this.mutedBeforeDeafen = saved.muted;
    await this.adapter.setMuted(saved.muted || saved.deafened);
    await this.adapter.setDeafened(saved.deafened);
    this.set({
      ...this.current,
      muted: saved.muted || saved.deafened,
      deafened: saved.deafened,
      inputDeviceId: saved.inputDeviceId,
      outputDeviceId: saved.outputDeviceId,
    });
  }
  private set(state: MediaControlsState) {
    this.current = state;
    this.listeners.forEach((listener) => listener());
  }
}

function available(
  devices: CallMediaDevice[],
  kind: CallMediaDevice["kind"],
  id: string,
) {
  return (
    !id || devices.some((device) => device.kind === kind && device.id === id)
  );
}
