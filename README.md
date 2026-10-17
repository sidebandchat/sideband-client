# Sideband Client

Sideband Client is the shared TypeScript SDK used by Sideband applications. It
owns authenticated client sessions, application state, messaging, communities,
calls, presence, activity, attachments, and private conversations over the
Sideband Binary Protocol (SBP).

The core client does not depend on React or Electron. Host applications provide
credential storage, message persistence, media, private-conversation crypto,
and private-transfer integrations appropriate to their platform.

## Installation

Sideband Client is an ESM-only package intended for modern bundlers and
JavaScript runtimes with native ES module support.

```sh
npm install @sidebandchat/client
```

## Usage

```ts
import {
  SidebandClient,
  discoverInstanceEndpoint,
  type ConversationId,
  type CredentialStore,
  type StoredCredential,
} from "@sidebandchat/client";

const stored = new Map<string, StoredCredential>();
const key = (account: { instanceDomain: string; userId: string }) =>
  `${account.instanceDomain}:${account.userId}`;

const credentials: CredentialStore = {
  load: async (account) => stored.get(key(account)),
  save: async (credential) => {
    stored.set(key(credential), credential);
  },
  delete: async (account) => {
    stored.delete(key(account));
  },
};

const client = new SidebandClient({
  clientFamily: "example",
  clientVersion: "1.0.0",
  credentials,
});

declare const credential: StoredCredential;
declare const conversationId: ConversationId;

const unsubscribe = client.subscribe(() => {
  console.log(client.state.connection, client.accountState);
});

const endpoint = await discoverInstanceEndpoint("chat.example.com");
await client.connect(endpoint, credential);

await client.messaging.send({
  conversationId,
  body: "Hello from Sideband",
});

unsubscribe();
client.disconnect();
```

`credential` is a `StoredCredential` obtained through Sideband's identity
and account bootstrap flow. Applications should keep it in secure platform
storage rather than ordinary browser storage.

## Client services

An online `SidebandClient` exposes feature services for:

- `messaging` — messages, history, reactions, replies, GIF search, and groups
- `social` — profiles, friendships, blocks, and notification settings
- `communities` — communities, channels, roles, permissions, and invitations
- `attachments` — upload admission, completion, and content grants
- `calls` — call signaling and authenticated media admission
- `privateConversations` — encrypted private sessions and file transfers
- `devices` — account device listing and revocation
- `realtime` — presence, typing, activity, and realtime preferences
- `workspace` — transport-independent workspace selection

Accessing an online-only service while disconnected throws an error. Connection
and account snapshots are observable through `client.subscribe()`.

## Platform integrations

Applications can provide the following integrations through
`SidebandClientOptions`:

- `credentials` securely persists account credentials.
- `messages` returns a persistent message cache for an account.
- `media` connects admitted calls to the platform's WebRTC implementation.
- `privateCrypto` provides private-conversation encryption and trust storage.
- `privateTransfers` streams private files using platform-owned resources.
- `mediaPreferences` persists mute, deafen, and audio-device choices.

The package also provides optional browser-oriented entry points for call
media, OMEMO, private-transfer framing and transport, and Blob hashing.
Applications can dynamically load these only when the corresponding feature is
used.

## Development

```sh
npm install
npm run check
```

`npm run check` verifies formatting, lint, compilation, tests, coverage, and the
published package contents.

## License

Sideband Client is licensed under the [GNU General Public License v3.0](LICENSE).
See [COPYRIGHT](COPYRIGHT) for copyright and trademark information.
