import type {
  AttachmentId,
  ActivityId,
  BlockId,
  CallId,
  ChannelId,
  CommunityId,
  ConversationId,
  DeviceId,
  EventId,
  FriendshipId,
  InvitationId,
  MessageId,
  NotificationId,
  PrivateConversationId,
  PrivateMessageId,
  PrivateTransferId,
  RoleId,
  UserId,
} from "./entity-id.js";

export type ChatState = "active" | "composing" | "paused" | "inactive" | "gone";
export type PresenceMode = "online" | "idle" | "dnd" | "invisible";
export type ContactPresence = Exclude<PresenceMode, "invisible"> | "offline";
export type UserBadge = "early-adopter" | "supporter" | "developer";
export type HistoryDirection = "before" | "after";
export type Mention = { begin: number; end: number; userId: UserId };

export type AttachmentMetadata = {
  id: AttachmentId;
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: Uint8Array;
  width?: number;
  height?: number;
  blurhash?: string;
  revision: number;
};
export type AttachmentUploadTarget = {
  attachmentId: AttachmentId;
  url: string;
  expiresAt: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
};
export type AttachmentGrant = {
  url: string;
  expiresAt: string;
};
export type GifResult = {
  id: string;
  title: string;
  previewUrl: string;
  url: string;
  previewWidth: number;
  previewHeight: number;
  blurhash?: string;
  width: number;
  height: number;
  selectionToken: string;
};
export type ReactionSummary = {
  emoji: string;
  count: number;
  own: boolean;
};
export type ReactionDetailsPage = {
  users: UserSummary[];
  nextOffset?: number;
};
export type ChatMessage = {
  id: MessageId;
  conversationId: ConversationId;
  authorId?: UserId;
  author?: UserSummary;
  kind: "user" | "system" | "call" | "invitation";
  authorName?: string;
  body: string;
  mentions?: Mention[];
  gif?: {
    url: string;
    title?: string;
    width?: number;
    height?: number;
    thumbnailUrl?: string;
    thumbnailWidth?: number;
    thumbnailHeight?: number;
    blurhash?: string;
  };
  attachments?: AttachmentMetadata[];
  communityInvite?: {
    url: string;
    communityName: string;
    communityId?: CommunityId;
  };
  communityEvent?: {
    id: MessageId;
    type: "member-joined" | "member-left";
    communityId: CommunityId;
    userId: UserId;
  };
  outgoing: boolean;
  timestamp: string;
  editedAt?: string;
  deletedAt?: string;
  revision: number;
  system?: unknown;
  replaces?: MessageId;
  retracts?: MessageId;
  reply?: { id: MessageId; authorId?: UserId };
  replyPreview?: {
    messageId: MessageId;
    authorId?: UserId;
    author?: UserSummary;
    text: string;
    unavailable: boolean;
  };
  edited?: boolean;
  reactions?: ReactionSummary[];
  reactionUpdate?: {
    targetId: MessageId;
    senderId: UserId;
    emojis: string[];
  };
  callEvent?: {
    type: "missed" | "completed";
    callId: CallId;
    duration: number;
    initiatedByMe?: boolean;
    initiatorId?: UserId;
    group?: boolean;
  };
  privateEvent?: {
    type: "missed" | "completed";
    sessionId: PrivateConversationId;
    duration: number;
    initiatorId?: UserId;
    initiatedByMe?: boolean;
  };
  pending?: {
    requestId: string;
    state: "sending" | "failed";
    error?: string;
  };
  confirmationTransition?: {
    requestId: string;
  };
  pendingMutation?: {
    requestId: string;
    kind: "edit" | "reaction";
  };
};
export type HistoryPage = {
  conversationId: ConversationId;
  messages: ChatMessage[];
  profiles: UserSummary[];
  reachedBeginning: boolean;
  reachedPresent: boolean;
  olderBefore?: MessageId;
  newerAfter?: MessageId;
};
export type ContextHistoryPage = HistoryPage;

export type ConversationSummary = {
  id: ConversationId;
  kind: "direct" | "group" | "community-channel";
  name?: string;
  avatarId?: AttachmentId;
  participantIds: UserId[];
  channelId?: ChannelId;
  newestEventId?: EventId;
  readThroughMessageId?: MessageId;
  ownerId?: UserId;
  createdAt?: string;
  revision: number;
};

export type CommunityChannel = {
  id: ChannelId;
  communityId: CommunityId;
  name: string;
  kind: "text" | "voice";
  conversationId: ConversationId;
  position: number;
  permissionOverrides: CommunityPermissionOverride[];
  revision: number;
  members?: CommunityMember[];
  memberCount?: number;
  membersComplete?: boolean;
  membersNextCursor?: string;
  onlineMembers?: CommunityMember[];
  onlineMembersComplete?: boolean;
  onlineMembersNextCursor?: string;
  onlineMemberCount?: number;
};
export type Community = {
  id: CommunityId;
  name: string;
  kind: "community" | "group_dm";
  avatarId?: AttachmentId;
  ownerId: UserId;
  createdAt?: string;
  members: CommunityMember[];
  membersComplete?: boolean;
  membersNextAfter?: UserId;
  onlineMembers?: CommunityMember[];
  onlineMembersComplete?: boolean;
  onlineMembersNextAfter?: UserId;
  onlineMemberCount?: number;
  channels: CommunityChannel[];
  roles: CommunityRole[];
  revision: number;
};
export type CommunityMemberPage = {
  communityId: CommunityId;
  channelId?: ChannelId;
  members: CommunityMember[];
  profiles: UserSummary[];
  nextAfter?: UserId;
  nextCursor?: string;
  complete: boolean;
  total: number;
  online: boolean;
};
export type CommunityInvitation = {
  id: InvitationId;
  communityId: CommunityId;
  token?: string;
  createdAt: string;
  expiresAt?: string;
  url: string;
  reusable: boolean;
  maximumUses?: number;
  uses: number;
  revoked: boolean;
  revision: number;
};
export type CommunityParticipant = {
  userId: UserId;
  nick: string;
  profile?: UserSummary;
};
export type CommunityMember = {
  userId: UserId;
  profile?: UserSummary;
  joinedAt: string;
  roleIds: RoleId[];
  permissions: CommunityPermission[];
  revision: number;
};
export type CommunityRole = {
  id: RoleId;
  communityId: CommunityId;
  name: string;
  position: number;
  permissions: CommunityPermission[];
  managed: boolean;
  revision: number;
};
export type CommunityPermission =
  | "view-channels"
  | "manage-community"
  | "manage-channels"
  | "manage-roles"
  | "manage-members"
  | "create-invitations"
  | "send-messages"
  | "join-voice"
  | "manage-messages";
export type CommunityPermissionOverride = {
  subject:
    | { kind: "everyone" }
    | { kind: "role"; roleId: RoleId }
    | { kind: "user"; userId: UserId };
  allow: CommunityPermission[];
  deny: CommunityPermission[];
};
export type ResolvedCommunityChannel = CommunityChannel;
export type ResolvedCommunity = Community;
export type ResolvedCommunityParticipant = CommunityParticipant;

export type RosterContact = {
  friendshipId: FriendshipId;
  userId: UserId;
  name: string;
  state: "pending" | "accepted" | "declined" | "cancelled" | "removed";
  requesterId: UserId;
  createdAt: string;
  acceptedAt?: string;
  revision: number;
};
export type UserSummary = {
  id: UserId;
  username: string;
  displayName: string;
  avatarId?: AttachmentId;
  revision: number;
};
export type UserProfile = UserSummary & {
  bio: string;
  createdAt: string;
  badges?: UserBadge[];
  badgeAssertion?: string;
};
export type Block = {
  id: BlockId;
  userId: UserId;
  createdAt: string;
  revision: number;
};
export type InboxEntry = {
  id: NotificationId;
  kind: "unread" | "mention";
  conversationId: ConversationId;
  messageId?: MessageId;
  senderId?: UserId;
  preview?: string;
  createdAt: string;
  read: boolean;
  unreadCount?: number;
};
export type NotificationSettings = {
  scope:
    | { kind: "account" }
    | { kind: "conversation"; conversationId: ConversationId }
    | { kind: "community"; communityId: CommunityId };
  level: "all" | "mentions" | "none";
  suppressMassMentions: boolean;
  revision: number;
};
export type RealtimeSettings = {
  presenceVisibility: "nobody" | "friends" | "shared-context";
  activityVisibility: "nobody" | "friends" | "shared-context";
  activitySharingEnabled: boolean;
  customStatus?: { text?: string; emoji?: string; expiresAt?: string };
  revision: number;
};
export type CustomStatus = {
  text?: string;
  emoji?: string;
  expiresAt?: string;
};
export type PresenceView = {
  userId: UserId;
  availability: "offline" | "online" | "idle" | "dnd";
  customStatus?: CustomStatus;
  observedAt: string;
  idleSince?: string;
};
export type ActivityArtwork =
  | { kind: "attachment"; attachmentId: AttachmentId }
  | { kind: "url"; url: string };
export type UserActivity = {
  id: ActivityId;
  kind: "music" | "game" | "custom";
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  payload: unknown;
};
export type ActivityView = {
  userId: UserId;
  deviceId: DeviceId;
  activity: UserActivity;
};
export type ClientDevice = {
  id: DeviceId;
  name?: string;
  platform?: string;
  clientVersion?: string;
  createdAt: string;
  lastSeenAt: string;
  lastIp?: string;
  current: boolean;
  revision: number;
};
export type AccountSnapshot = {
  schemaVersion: number;
  ownUser: UserProfile;
  users: UserSummary[];
  friendships: RosterContact[];
  conversations: ConversationSummary[];
  communities: Community[];
  realtimeSettings: RealtimeSettings;
  inbox: InboxEntry[];
  blocks: Block[];
  notificationSettings: NotificationSettings[];
  devices: ClientDevice[];
};
export type ConversationSnapshot = {
  schemaVersion: number;
  conversation: ConversationSummary;
  messages: ChatMessage[];
  profiles: UserSummary[];
  reachedBeginning: boolean;
};
export type UserTune = {
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  positionMs?: number;
  playbackState?: "playing" | "paused" | "stopped" | "unknown";
  applicationId?: string;
  applicationName?: string;
  trackId?: string;
  trackUri?: string;
};
export type IncomingCall = {
  id: CallId;
  initiatorId: UserId;
  kind?: "direct" | "group_dm";
  conversationId?: ConversationId;
  channelId?: ChannelId;
  startedAt?: number;
  phase?: "proposal" | "session";
  direction?: "incoming" | "outgoing";
};
export type CallTarget =
  | { kind: "user"; userId: UserId }
  | { kind: "conversation"; conversationId: ConversationId }
  | { kind: "channel"; channelId: ChannelId };
export type CallParticipant = {
  userId: UserId;
  state: "invited" | "ringing" | "joining" | "active" | "declined" | "left";
  joinedAt?: string;
};
export type CallSession = {
  id: CallId;
  target: CallTarget;
  originatorId: UserId;
  media: "voice" | "video";
  state: "ringing" | "connecting" | "active" | "ended" | "declined" | "expired";
  startedAt: string;
  endedAt?: string;
  participants: CallParticipant[];
  emptyRoomExpiresAt?: string;
  establishedAt?: string;
};
export type MediaAdmission = {
  credential: Uint8Array;
  expiresAt: string;
  room: string;
};
export type SessionEvent = {
  kind: "call" | "private";
  type: "missed" | "completed";
  sessionId: CallId | PrivateConversationId;
  duration: number;
  initiatorId: UserId;
};
export type PrivateConversationSignal = {
  fromUserId: UserId;
  sessionId: PrivateConversationId;
  action:
    "invite" | "accept" | "decline" | "encrypted" | "end" | "delivery-error";
  payload?: string;
};
export type PrivateConversationSession = {
  id: PrivateConversationId;
  initiatorId: UserId;
  peerId: UserId;
  state: "ringing" | "negotiating" | "active" | "reconnecting" | "ended";
  startedAt: string;
  reconnectExpiresAt?: string;
  encryptedInvitation?: Uint8Array;
};
export type PrivateConversationMessage = {
  id: PrivateMessageId;
  privateConversationId: PrivateConversationId;
  senderId: UserId;
  body: string;
  timestamp: string;
  attachments?: PrivateConversationAttachment[];
  transferIds?: PrivateTransferId[];
};
export type PrivateConversationAttachment = {
  transferId: PrivateTransferId;
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: Uint8Array;
  width?: number;
  height?: number;
  state:
    | "offered"
    | "waiting"
    | "transferring"
    | "completed"
    | "declined"
    | "canceled"
    | "failed";
  progress: number;
};
export type PrivateConversationView = {
  session?: PrivateConversationSession;
  status: "idle" | "incoming" | "outgoing" | "connecting" | "active";
  messages: PrivateConversationMessage[];
};
export type PrivateConversationRealtimeEvent = {
  privateConversationId: PrivateConversationId;
  senderId: UserId;
  action:
    "invite" | "accept" | "decline" | "signal" | "end" | "reconnect" | "state";
  payload: Uint8Array;
  state: PrivateConversationSession["state"];
  receivedAt: string;
};
export type PrivateTransfer = {
  id: PrivateTransferId;
  privateConversationId: PrivateConversationId;
  senderId: UserId;
  filename?: string;
  mediaType?: string;
  byteSize: number;
  sha256?: Uint8Array;
  state:
    | "offered"
    | "accepted"
    | "transferring"
    | "completed"
    | "declined"
    | "canceled";
};
export type PrivateTransferAdmission = {
  credential: Uint8Array;
  expiresAt: string;
  room: string;
};
export type MentionNotification = {
  id: NotificationId;
  kind: "dm" | "channel";
  conversationId: ConversationId;
  senderId: UserId;
  messageId: MessageId;
  body: string;
  timestamp: string;
};

export const PROFILE_LIMITS = { displayName: 32, bio: 300 } as const;
const profileCharacterSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
export function profileCharacterCount(value: string) {
  return Array.from(profileCharacterSegmenter.segment(value)).length;
}
export function limitProfileCharacters(value: string, limit: number) {
  return Array.from(
    profileCharacterSegmenter.segment(value),
    ({ segment }) => segment,
  )
    .slice(0, limit)
    .join("");
}
