export const PRIVATE_TRANSFER_LIMITS = {
  maximumFileBytes: 25 * 1024 * 1024,
  maximumFilesPerMessage: 10,
  maximumMessageBytes: 100 * 1024 * 1024,
  maximumPendingOffers: 4,
  maximumConcurrentFiles: 2,
  chunkBytes: 60 * 1024,
} as const;
