import type { AttachmentMetadata } from "../domain.js";

/**
 * Platform-neutral attachment selected for a message that has not been sent.
 *
 * Browser/Electron applications use `File` as `Source`; native applications
 * can use a URI, asset handle, or another platform-owned value.
 */
export type DraftAttachment<Source = unknown> = {
  id: string;
  file: Source;
  previewUrl?: string;
  progress: number;
  status: "queued" | "uploading" | "uploaded" | "failed";
  uploaded?: AttachmentMetadata;
  error?: string;
};
