import type { CustomStatus, RealtimeSettings, UserTune } from "../domain.js";
import type { ActivityId, ConversationId } from "../entity-id.js";
import { entityRef, requestRef, wireMap } from "../sbp/codec.js";
import type { SbpCommandTransport } from "../sbp/command-transport.js";
import { decodeRealtimeSettings } from "../sbp/records.js";

export type SbpRealtimeTransport = SbpCommandTransport & {
  control(opcode: number, payload: unknown): void;
};

export type PublishPresenceInput = {
  availability: "offline" | "online" | "idle" | "dnd" | "invisible";
  customStatus?: CustomStatus;
  idleSince?: Date;
};

export type PublishActivityInput = {
  id: ActivityId;
  kind: "music" | "game" | "custom";
  startedAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  payload: unknown;
};

export class SbpRealtimeClient {
  private readonly typingPublications = new Map<
    ConversationId,
    { typing: boolean; sentAt: number }
  >();

  constructor(private readonly transport: SbpRealtimeTransport) {}

  publishPresence(input: PublishPresenceInput) {
    this.transport.control(
      32,
      wireMap([
        [0, availabilityId(input.availability)],
        ...optionalEntry(
          1,
          input.customStatus && encodeCustomStatus(input.customStatus),
        ),
        ...optionalEntry(3, input.idleSince),
      ]),
    );
  }

  publishTyping(
    conversationId: ConversationId,
    typing: boolean,
    leaseMs: number,
  ) {
    const now = Date.now();
    const previous = this.typingPublications.get(conversationId);
    const refreshAfterMs = Math.max(1_000, Math.floor(leaseMs / 2));

    if (
      (!previous && !typing) ||
      (previous?.typing === typing &&
        (!typing || now - previous.sentAt < refreshAfterMs))
    ) {
      return;
    }

    this.transport.control(
      34,
      wireMap([
        [0, entityRef("conversation", conversationId)],
        [1, typing],
        [2, leaseMs],
      ]),
    );
    this.typingPublications.set(conversationId, { typing, sentAt: now });
  }

  messageSent(conversationId: ConversationId) {
    this.typingPublications.delete(conversationId);
  }

  publishActivity(input: PublishActivityInput) {
    this.transport.control(
      36,
      wireMap([
        [0, requestRef(input.id)],
        [1, activityKindId(input.kind)],
        [2, input.startedAt],
        [3, input.updatedAt],
        [4, input.expiresAt],
        [5, encodeActivityPayload(input.kind, input.payload)],
      ]),
    );
  }

  clearActivity(kind: PublishActivityInput["kind"]) {
    this.transport.control(36, [activityKindId(kind), null]);
  }

  async updateSettings(settings: RealtimeSettings) {
    return decodeRealtimeSettings(
      await this.transport.command(
        500,
        wireMap([[0, encodeSettings(settings)]]),
      ),
    );
  }
}

function availabilityId(value: PublishPresenceInput["availability"]) {
  return { offline: 0, online: 1, idle: 2, dnd: 3, invisible: 4 }[value];
}
function activityKindId(value: PublishActivityInput["kind"]) {
  return { music: 0, game: 1, custom: 255 }[value];
}
function encodeActivityPayload(
  kind: PublishActivityInput["kind"],
  payload: unknown,
) {
  if (kind !== "music") return payload;
  const tune = payload as UserTune;
  if (!tune.title) throw new TypeError("Music activity requires a title");
  return [
    0,
    wireMap([
      [0, tune.title],
      ...optionalEntry(1, tune.artist ? [tune.artist] : undefined),
      ...optionalEntry(2, tune.album),
      [3, playbackStateId(tune.playbackState)],
      ...optionalEntry(4, tune.durationMs),
      ...optionalEntry(5, tune.positionMs),
      ...optionalEntry(8, tune.applicationName),
      ...optionalEntry(9, tune.applicationId),
      ...optionalEntry(
        10,
        tune.trackId ? [["native", tune.trackId]] : undefined,
      ),
      ...optionalEntry(11, tune.trackUri),
    ]),
  ];
}
function playbackStateId(value: UserTune["playbackState"]) {
  return { stopped: 0, paused: 1, playing: 2, unknown: 0 }[value ?? "unknown"];
}
function encodeCustomStatus(status: CustomStatus) {
  return wireMap([
    ...optionalEntry(0, status.text),
    ...optionalEntry(1, status.emoji),
    ...optionalEntry(2, status.expiresAt && new Date(status.expiresAt)),
  ]);
}
function encodeSettings(settings: RealtimeSettings) {
  const visibility = { nobody: 0, friends: 1, "shared-context": 2 };
  return wireMap([
    [0, visibility[settings.presenceVisibility]],
    [1, visibility[settings.activityVisibility]],
    [2, settings.activitySharingEnabled],
    ...optionalEntry(
      3,
      settings.customStatus && encodeCustomStatus(settings.customStatus),
    ),
    [4, settings.revision],
  ]);
}
function optionalEntry(key: number, value: unknown): [number, unknown][] {
  return value === undefined ? [] : [[key, value]];
}
