export {
  instanceEndpoint,
  discoverInstanceEndpoint,
  loadCommunityInvitationPreview,
  parseInstanceDocument,
  parseCommunityInvitationPreview,
  type CommunityInvitationPreview,
  type InstanceAuthentication,
  type InstanceEndpoint,
  type InstanceEndpointInput,
} from "../instance-endpoint.js";

export type {
  AttachmentCapabilities,
  InstanceCapabilities,
} from "../instance-capabilities.js";
export type { InstancePolicy } from "./instance-policy.js";

export {
  InstanceApiError,
  InstanceHttpClient,
  type InstanceAccess,
  type SidebandClientIdentity,
  type AuthenticatedInstanceAccess,
  type InstanceAccessProvider,
  type InstanceRequestOptions,
} from "../instance-access.js";
