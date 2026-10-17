export type InstancePolicy = {
  attachmentsEnabled: boolean;
  maximumAttachmentBytes: number;
  maximumAttachmentsPerMessage: number;
  maximumAttachmentBytesPerMessage: number;
  privateConversationsEnabled: boolean;
  privateFileTransfersEnabled: boolean;
  gifSearchEnabled: boolean;
  callEmptyGraceMs: number;
  privateInviteTimeoutMs: number;
  privateReconnectGraceMs: number;
};
