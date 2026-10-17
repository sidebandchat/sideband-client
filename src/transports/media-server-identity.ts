import { entityId, type UserId } from "../entity-id.js";

export type MediaServerIdentity = {
  endpointId: string;
  userId: UserId;
};

/** Translate authenticated media-server metadata at the wire boundary. */
export function parseMediaServerIdentity(
  value: unknown,
): MediaServerIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as {
    endpointId?: unknown;
    userId?: unknown;
  };
  if (typeof record.endpointId !== "string") return undefined;
  if (typeof record.userId === "string") {
    try {
      return {
        endpointId: record.endpointId,
        userId: entityId<"user">(record.userId),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
