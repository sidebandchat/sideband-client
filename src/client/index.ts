export {
  SidebandClient,
  type AccountKey,
  type StoredCredential,
  type CredentialStore,
  type SidebandClientState,
  type SidebandClientOptions,
} from "./sideband-client.js";

export type {
  CallMediaAdapter,
  CallMediaEvent,
  CallMediaState,
  CallMediaParticipant,
  CallMediaRemoteTrack,
  PrivateCryptoAdapter,
  PrivateCryptoHandle,
  PrivateTransferAdapter,
  CallMediaDevice,
  CallMediaPreferences,
} from "./platform-adapters.js";

export {
  initialAccountState,
  type AccountState,
  type CachedConversation,
  type MessageCache,
} from "./state.js";

export type { WorkspaceState } from "../workspace/workspace-controller.js";
export type {
  ReplyPreview,
  FocusedReplyContext,
} from "../conversations/replies-controller.js";

export {
  friendshipLists,
  unreadCounts,
  unreadInboxEntries,
  type FriendshipLists,
} from "../model/selectors.js";
