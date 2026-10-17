import type {
  AttachmentId,
  ConversationId,
  MessageId,
  UserId,
} from "../entity-id.js";
import type {
  AttachmentMetadata,
  ChatMessage,
  GifResult,
  Mention,
  ReactionDetailsPage,
  ReactionSummary,
} from "../domain.js";
import { Tag } from "cbor-x";
import { entityRef, wireMap } from "../sbp/codec.js";
import type { SbpCommandTransport } from "../sbp/command-transport.js";
import type { AccountStateController } from "../client/state.js";
import {
  decodeContextHistoryPage,
  decodeConversation,
  decodeHistoryPage,
  decodeMessage,
  decodeReactionSummaries,
  decodeUserSummary,
} from "../sbp/records.js";
import {
  booleanValue,
  arrayValue,
  mapValue,
  optional,
  orderedValue,
  required,
  unsignedValue,
  textValue,
} from "../sbp/value.js";

export type SendMessageInput = {
  conversationId: ConversationId;
  text?: string;
  replyTo?: MessageId;
  attachmentIds?: AttachmentId[];
  gifToken?: string;
  mentions?: Mention[];
  optimisticAttachments?: AttachmentMetadata[];
  optimisticGif?: GifResult;
};

export class SbpMessagingClient {
  private readonly readThrough = new Map<ConversationId, MessageId>();
  private readonly pendingSends = new Map<string, SendMessageInput>();
  private pendingSequence = 0n;

  constructor(
    private readonly transport: SbpCommandTransport,
    private readonly onMessageSent: (
      conversationId: ConversationId,
    ) => void = () => undefined,
    private readonly state?: AccountStateController,
  ) {}

  async send(input: SendMessageInput) {
    if (!input.text?.trim() && !input.attachmentIds?.length && !input.gifToken)
      throw new TypeError(
        "A message must contain text, an attachment, or a GIF",
      );
    return this.sendWithRequest(input);
  }

  async retry(requestId: string) {
    const input = this.pendingSends.get(requestId);
    if (!input) throw new Error("The pending message is unavailable");
    this.state?.markPendingMessageSending(requestId);
    return this.sendWithRequest(input, requestId);
  }

  discard(requestId: string) {
    this.pendingSends.delete(requestId);
    this.state?.discardPendingMessage(requestId);
  }

  private async sendWithRequest(input: SendMessageInput, requestId?: string) {
    const payload = wireMap([
      [0, entityRef("conversation", input.conversationId)],
      ...optionalEntry(1, input.text),
      ...optionalEntry(2, input.replyTo),
      ...optionalEntry(
        3,
        input.attachmentIds?.length
          ? input.attachmentIds.map((id) => entityRef("attachment", id))
          : undefined,
      ),
      ...optionalEntry(4, input.gifToken),
      ...optionalEntry(5, encodeMentions(input.mentions)),
    ]);
    const command = this.command(100, payload, requestId);
    this.pendingSends.set(command.requestId, input);
    if (!requestId)
      this.state?.addPendingMessage(
        command.requestId,
        this.pendingMessage(command.requestId, input),
      );

    let message: ChatMessage;
    try {
      message = decodeMessage(await command.response);

      const current = this.readThrough.get(input.conversationId);
      if (current === undefined || message.id > current)
        this.readThrough.set(input.conversationId, message.id);

      await this.state?.confirmPendingMessage(command.requestId, message);
      this.pendingSends.delete(command.requestId);
    } catch (reason) {
      this.state?.failPendingMessage(command.requestId, reason);
      throw reason;
    }

    this.onMessageSent(input.conversationId);

    return message.id;
  }

  private pendingMessage(
    requestId: string,
    input: SendMessageInput,
  ): ChatMessage {
    const ownUserId = this.state?.state.ownUserId;
    return {
      id: --this.pendingSequence as MessageId,
      conversationId: input.conversationId,
      authorId: ownUserId,
      kind: "user",
      body: input.text ?? "",
      mentions: input.mentions,
      attachments: input.optimisticAttachments,
      gif: input.optimisticGif
        ? {
            url: input.optimisticGif.url,
            title: input.optimisticGif.title,
            width: input.optimisticGif.width,
            height: input.optimisticGif.height,
            thumbnailUrl: input.optimisticGif.previewUrl,
            thumbnailWidth: input.optimisticGif.previewWidth,
            thumbnailHeight: input.optimisticGif.previewHeight,
            blurhash: input.optimisticGif.blurhash,
          }
        : undefined,
      outgoing: true,
      timestamp: new Date().toISOString(),
      revision: 0,
      reply: input.replyTo ? { id: input.replyTo } : undefined,
      pending: { requestId, state: "sending" },
    };
  }

  private command(opcode: number, payload: unknown, requestId?: string) {
    if (this.transport.commandWithHandle)
      return this.transport.commandWithHandle(opcode, payload, requestId);
    return {
      requestId: requestId ?? crypto.randomUUID(),
      response: this.transport.command(opcode, payload),
    };
  }

  async edit(
    conversationId: ConversationId,
    messageId: MessageId,
    text: string,
    revision: number,
    mentions?: Mention[],
  ) {
    const payload = wireMap([
      [0, entityRef("conversation", conversationId)],
      [1, messageId],
      [2, text],
      [3, revision],
      ...optionalEntry(4, encodeMentions(mentions)),
    ]);
    const command = this.command(101, payload);
    this.state?.beginOptimisticMutation(
      command.requestId,
      conversationId,
      messageId,
      "edit",
      (message) => ({
        ...message,
        body: text,
        mentions,
        editedAt: new Date().toISOString(),
      }),
    );
    try {
      const response = mapValue(await command.response);
      const nextRevision = unsignedValue(required(response, 0));
      this.state?.completeOptimisticMutation(command.requestId, nextRevision);
      return nextRevision;
    } catch (reason) {
      this.state?.rollbackOptimisticMutation(command.requestId);
      throw reason;
    }
  }

  async delete(
    conversationId: ConversationId,
    messageId: MessageId,
    revision: number,
  ) {
    const command = this.command(
      102,
      wireMap([
        [0, entityRef("conversation", conversationId)],
        [1, messageId],
        [2, revision],
      ]),
    );
    this.state?.beginOptimisticMutation(
      command.requestId,
      conversationId,
      messageId,
      "delete",
    );
    try {
      const response = mapValue(await command.response);
      const nextRevision = unsignedValue(required(response, 0));
      this.state?.completeOptimisticMutation(command.requestId, nextRevision);
      return nextRevision;
    } catch (reason) {
      this.state?.rollbackOptimisticMutation(command.requestId);
      throw reason;
    }
  }

  async react(
    conversationId: ConversationId,
    messageId: MessageId,
    emojis: string[],
  ) {
    const command = this.command(
      103,
      wireMap([
        [0, entityRef("conversation", conversationId)],
        [1, messageId],
        [2, emojis],
      ]),
    );
    const ownUserId = this.state?.state.ownUserId;
    this.state?.beginOptimisticMutation(
      command.requestId,
      conversationId,
      messageId,
      "reaction",
      (message) =>
        ownUserId
          ? {
              ...message,
              reactions: withOwnReactions(message.reactions, emojis),
            }
          : message,
    );
    try {
      const response = mapValue(await command.response);
      const nextRevision = unsignedValue(required(response, 0));
      const reactions = decodeReactionSummaries(required(response, 1));
      this.state?.completeOptimisticMutation(
        command.requestId,
        nextRevision,
        (message) => ({ ...message, reactions }),
      );
      return nextRevision;
    } catch (reason) {
      this.state?.rollbackOptimisticMutation(command.requestId);
      throw reason;
    }
  }

  async reactors(
    conversationId: ConversationId,
    messageId: MessageId,
    emoji: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<ReactionDetailsPage> {
    const response = mapValue(
      await this.transport.command(
        114,
        wireMap([
          [0, entityRef("conversation", conversationId)],
          [1, messageId],
          [2, emoji],
          [3, options.offset ?? 0],
          [4, options.limit ?? 50],
        ]),
      ),
    );
    return {
      users: arrayValue(required(response, 0)).map(decodeUserSummary),
      nextOffset: optional(response, 1, unsignedValue),
    };
  }

  async history(
    conversationId: ConversationId,
    options: { before?: MessageId; limit?: number } = {},
  ) {
    return decodeHistoryPage(
      await this.transport.command(
        104,
        wireMap([
          [0, entityRef("conversation", conversationId)],
          ...optionalEntry(1, options.before),
          [2, options.limit ?? 50],
        ]),
      ),
    );
  }

  async markRead(conversationId: ConversationId, messageId: MessageId) {
    const previous = this.readThrough.get(conversationId);
    if (previous !== undefined && previous >= messageId) return previous;

    // Reserve the high-water mark before awaiting so simultaneous focus and
    // state effects cannot enqueue the same acknowledgement twice.
    this.readThrough.set(conversationId, messageId);

    try {
      const response = mapValue(
        await this.transport.command(
          105,
          wireMap([
            [0, entityRef("conversation", conversationId)],
            [1, messageId],
          ]),
        ),
      );
      const acknowledged = orderedValue<"message">(required(response, 0));
      const current = this.readThrough.get(conversationId);
      if (current === undefined || acknowledged > current)
        this.readThrough.set(conversationId, acknowledged);
      return acknowledged;
    } catch (error) {
      if (this.readThrough.get(conversationId) === messageId) {
        if (previous === undefined) this.readThrough.delete(conversationId);
        else this.readThrough.set(conversationId, previous);
      }
      throw error;
    }
  }

  async context(
    conversationId: ConversationId,
    messageId: MessageId,
    before = 30,
    after = 30,
    cursors: { olderBefore?: MessageId; newerAfter?: MessageId } = {},
  ) {
    return decodeContextHistoryPage(
      await this.transport.command(
        106,
        wireMap([
          [0, entityRef("conversation", conversationId)],
          [1, messageId],
          [2, before],
          [3, after],
          ...optionalEntry(4, cursors.olderBefore),
          ...optionalEntry(5, cursors.newerAfter),
        ]),
      ),
    );
  }

  async createGroup(participantIds: UserId[], name?: string) {
    return decodeConversation(
      await this.transport.command(
        107,
        wireMap([
          [0, participantIds.map((id) => entityRef("user", id))],
          ...optionalEntry(1, name),
        ]),
      ),
    );
  }

  async sendInvitation(conversationId: ConversationId, token: string) {
    return decodeMessage(
      await this.transport.command(
        113,
        wireMap([
          [0, entityRef("conversation", conversationId)],
          [1, token],
        ]),
      ),
    );
  }

  async renameGroup(
    conversationId: ConversationId,
    name: string,
    revision: number,
  ) {
    return decodeConversation(
      await this.transport.command(
        108,
        wireMap([
          [0, entityRef("conversation", conversationId)],
          [1, name],
          [2, revision],
        ]),
      ),
    );
  }

  async replaceGroupParticipants(
    conversationId: ConversationId,
    participantIds: UserId[],
    revision: number,
  ) {
    return decodeConversation(
      await this.transport.command(
        109,
        wireMap([
          [0, entityRef("conversation", conversationId)],
          [1, participantIds.map((id) => entityRef("user", id))],
          [2, revision],
        ]),
      ),
    );
  }

  async leaveGroup(conversationId: ConversationId, revision: number) {
    const response = mapValue(
      await this.transport.command(
        110,
        wireMap([
          [0, entityRef("conversation", conversationId)],
          [1, revision],
        ]),
      ),
    );
    return {
      archived: booleanValue(required(response, 0)),
      conversation: response.has(1)
        ? decodeConversation(required(response, 1))
        : undefined,
    };
  }

  async direct(userId: UserId) {
    return decodeConversation(
      await this.transport.command(
        111,
        wireMap([[0, entityRef("user", userId)]]),
      ),
    );
  }

  async searchGifs(query = "", page = 1): Promise<GifResult[]> {
    if (query.length > 100) throw new TypeError("GIF search query is too long");
    if (!Number.isInteger(page) || page < 1 || page > 100)
      throw new TypeError("Invalid GIF search page");

    const response = mapValue(
      await this.transport.command(
        112,
        wireMap([...optionalEntry(0, query || undefined), [1, page]]),
      ),
    );
    return arrayValue(required(response, 0)).map(decodeGifSearchResult);
  }
}

function withOwnReactions(
  current: ReactionSummary[] | undefined,
  emojis: string[],
) {
  const desired = new Set(emojis);
  const next = (current ?? []).flatMap((reaction) => {
    const own = desired.has(reaction.emoji);
    const count = reaction.count + (own ? 1 : 0) - (reaction.own ? 1 : 0);
    return count > 0 ? [{ ...reaction, count, own }] : [];
  });
  const existing = new Set(next.map((reaction) => reaction.emoji));
  desired.forEach((emoji) => {
    if (!existing.has(emoji)) next.push({ emoji, count: 1, own: true });
  });
  return next;
}

function decodeGifSearchResult(value: unknown): GifResult {
  const result = mapValue(value);
  const gif = mapValue(required(result, 0));
  const primary = decodeGifRendition(required(gif, 3));
  const preview = decodeGifRendition(required(gif, 4));
  return {
    id: textValue(required(gif, 1)),
    title: optional(gif, 2, textValue) ?? "GIF",
    url: primary.url,
    width: primary.width,
    height: primary.height,
    previewUrl: preview.url,
    previewWidth: preview.width,
    previewHeight: preview.height,
    blurhash: optional(gif, 5, textValue),
    selectionToken: textValue(required(result, 1)),
  };
}

function decodeGifRendition(value: unknown) {
  const rendition = mapValue(value);
  const url = required(rendition, 0);
  if (!(url instanceof Tag) || url.tag !== 32)
    throw new TypeError("Expected SBP GIF URL");
  return {
    url: textValue(url.value),
    width: unsignedValue(required(rendition, 2)),
    height: unsignedValue(required(rendition, 3)),
  };
}

function encodeMentions(mentions?: Mention[]) {
  return mentions?.length
    ? mentions.map((mention) =>
        wireMap([
          [0, entityRef("user", mention.userId)],
          [1, mention.begin],
          [2, mention.end],
        ]),
      )
    : undefined;
}

function optionalEntry(key: number, value: unknown): [number, unknown][] {
  return value === undefined ? [] : [[key, value]];
}
