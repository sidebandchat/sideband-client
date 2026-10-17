import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as publicApi from "./index.js";
import type {
  AccountKey,
  AccountState,
  CredentialStore,
  InstancePolicy,
  MessageCache,
  SidebandClient,
  StoredCredential,
  WorkspaceState,
} from "./index.js";

const runtimeExports = [
  "ActivitySharingController",
  "IdentityClient",
  "InstanceApiError",
  "InstanceHttpClient",
  "MediaPresentationController",
  "PRIVATE_TRANSFER_LIMITS",
  "PROFILE_LIMITS",
  "SidebandClient",
  "atomicDeletionRange",
  "codePointLength",
  "codeUnitOffset",
  "communityForChannel",
  "conversationDisplayName",
  "conversationRelationship",
  "createMentionCandidates",
  "createWorkspaceDirectory",
  "discoverInstanceEndpoint",
  "entityId",
  "friendshipLists",
  "idKey",
  "initialAccountState",
  "instanceEndpoint",
  "limitProfileCharacters",
  "loadCommunityInvitationPreview",
  "mentionQuery",
  "mentionRanges",
  "orderedId",
  "parseCommunityInvitationPreview",
  "parseInstanceDocument",
  "profileCharacterCount",
  "selectActivitySession",
  "shiftMentions",
  "typingDisplayNames",
  "uniqueMentionCandidates",
  "unreadCounts",
  "unreadInboxEntries",
  "userDisplayName",
  "validMentions",
];

describe("public package API", () => {
  it("exports only the reviewed root runtime surface", () => {
    expect(Object.keys(publicApi).sort()).toEqual(runtimeExports);
    expect(publicApi).not.toHaveProperty("SidebandMedia");
  });

  it("publishes platform-heavy implementations only through explicit subpaths", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(packageJson.exports).sort()).toEqual([
      ".",
      "./attachments/hash",
      "./calls/media",
      "./private-conversation/crypto",
      "./private-conversation/transfers",
      "./private-conversation/transport",
    ]);
  });

  it("keeps generic application types available without protocol aliases", () => {
    expectTypeOf<AccountKey>().toHaveProperty("userId");
    expectTypeOf<StoredCredential>().toMatchTypeOf<AccountKey>();
    expectTypeOf<CredentialStore>().toHaveProperty("load");
    expectTypeOf<AccountState>().toHaveProperty("conversations");
    expectTypeOf<MessageCache>().toHaveProperty("load");
    expectTypeOf<WorkspaceState>().toHaveProperty("view");
    expectTypeOf<InstancePolicy>().toHaveProperty("attachmentsEnabled");
    expectTypeOf<SidebandClient>().toHaveProperty("connect");
  });
});
