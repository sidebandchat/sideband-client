export type AttachmentCapabilities = {
  maximumFileBytes: number;
  maximumFilesPerMessage: number;
  maximumMessageBytes: number;
};

export type InstanceCapabilities = {
  attachments?: AttachmentCapabilities;
  privateConversations: boolean;
  privateFileTransfers: boolean;
  gifs: boolean;
};
