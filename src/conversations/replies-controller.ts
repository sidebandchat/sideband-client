import type { ChatMessage } from "../domain.js";
import type { ConversationId, MessageId, UserId } from "../entity-id.js";
import type { SbpMessagingClient } from "./messaging-client.js";
import type { AccountState } from "../client/state.js";

export type ReplyPreview = {
  messageId: MessageId;
  authorId?: UserId;
  author?: ChatMessage["author"];
  text: string;
  unavailable: boolean;
};

export type FocusedReplyContext = {
  conversationId: ConversationId;
  targetMessageId: MessageId;
  messages: ChatMessage[];
  loading: boolean;
  reachedBeginning: boolean;
  reachedPresent: boolean;
};

type ContextEdge = {
  complete: boolean;
  cursor?: MessageId;
  loading: boolean;
};

export class RepliesController {
  private static readonly maximumCachedPreviews = 1_000;
  private current?: FocusedReplyContext;
  private previews = new Map<string, ReplyPreview>();
  private previewLoads = new Map<string, Promise<ReplyPreview>>();
  private previewRevision = 0;
  private listeners = new Set<() => void>();
  private before = 30;
  private after = 30;
  private older: ContextEdge = { complete: false, loading: false };
  private newer: ContextEdge = { complete: false, loading: false };
  private generation = 0;

  constructor(
    private readonly messaging: SbpMessagingClient,
    private readonly account: () => AccountState | undefined,
  ) {}

  get state() {
    return this.current;
  }

  get previewsVersion() {
    return this.previewRevision;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(conversationId: ConversationId, messageId: MessageId) {
    const message = this.account()
      ?.messages.get(conversationId)
      ?.get(messageId);
    return message
      ? preview(message)
      : this.previews.get(previewKey(conversationId, messageId));
  }

  async loadPreview(conversationId: ConversationId, messageId: MessageId) {
    const existing = this.get(conversationId, messageId);
    if (existing) return existing;
    const key = previewKey(conversationId, messageId);
    const pending = this.previewLoads.get(key);
    if (pending) return pending;

    const load = this.fetchPreview(conversationId, messageId).then((result) => {
      this.cachePreview(key, result);
      return result;
    });
    this.previewLoads.set(key, load);

    try {
      return await load;
    } finally {
      this.previewLoads.delete(key);
    }
  }

  async open(conversationId: ConversationId, messageId: MessageId) {
    const generation = ++this.generation;
    this.older = { complete: false, loading: true };
    this.newer = { complete: false, loading: true };
    this.current = {
      conversationId,
      targetMessageId: messageId,
      messages: [],
      loading: true,
      reachedBeginning: false,
      reachedPresent: false,
    };
    this.emit();
    try {
      const page = await this.messaging.context(
        conversationId,
        messageId,
        this.before,
        this.after,
      );
      if (generation !== this.generation) return;
      this.older = edge(page.reachedBeginning, page.olderBefore);
      this.newer = edge(page.reachedPresent, page.newerAfter);
      this.current = {
        conversationId,
        targetMessageId: messageId,
        messages: this.withDirection(page.messages),
        loading: false,
        reachedBeginning: this.older.complete,
        reachedPresent: this.newer.complete,
      };
      this.emit();
    } catch (reason) {
      if (generation === this.generation) {
        this.older.loading = false;
        this.newer.loading = false;
        this.current = { ...this.current, loading: false };
        this.emit();
      }
      throw reason;
    }
  }

  loadOlder() {
    return this.loadEdge("older");
  }

  loadNewer() {
    return this.loadEdge("newer");
  }

  reset() {
    this.generation += 1;
    this.current = undefined;
    this.emit();
  }

  private async loadEdge(direction: "older" | "newer") {
    const current = this.current;
    const edgeState = direction === "older" ? this.older : this.newer;
    if (
      !current ||
      current.loading ||
      edgeState.loading ||
      edgeState.complete ||
      edgeState.cursor === undefined
    )
      return;
    const generation = this.generation;
    edgeState.loading = true;
    try {
      const page = await this.messaging.context(
        current.conversationId,
        current.targetMessageId,
        direction === "older" ? 25 : 0,
        direction === "newer" ? 25 : 0,
        direction === "older"
          ? { olderBefore: edgeState.cursor }
          : { newerAfter: edgeState.cursor },
      );
      if (
        generation !== this.generation ||
        this.current?.targetMessageId !== current.targetMessageId
      )
        return;
      const next =
        direction === "older"
          ? edge(page.reachedBeginning, page.olderBefore)
          : edge(page.reachedPresent, page.newerAfter);
      if (direction === "older") this.older = next;
      else this.newer = next;
      this.current = {
        ...this.current,
        messages: mergeMessages(
          this.current.messages,
          this.withDirection(page.messages),
        ),
        loading: false,
        reachedBeginning: this.older.complete,
        reachedPresent: this.newer.complete,
      };
      this.emit();
    } catch (reason) {
      edgeState.loading = false;
      throw reason;
    }
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private withDirection(messages: ChatMessage[]) {
    const ownUserId = this.account()?.ownUserId;
    return messages.map((message) => ({
      ...message,
      outgoing: ownUserId !== undefined && message.authorId === ownUserId,
    }));
  }

  private async fetchPreview(
    conversationId: ConversationId,
    messageId: MessageId,
  ): Promise<ReplyPreview> {
    try {
      const page = await this.messaging.context(
        conversationId,
        messageId,
        0,
        0,
      );
      const message = page.messages.find(
        (candidate) => candidate.id === messageId,
      );
      return message ? preview(message) : unavailablePreview(messageId);
    } catch {
      return unavailablePreview(messageId);
    }
  }

  private cachePreview(key: string, value: ReplyPreview) {
    this.previews.delete(key);
    this.previews.set(key, value);
    while (this.previews.size > RepliesController.maximumCachedPreviews) {
      const oldest = this.previews.keys().next().value;
      if (oldest === undefined) break;
      this.previews.delete(oldest);
    }
    this.previewRevision += 1;
    this.emit();
  }
}

function edge(complete: boolean, cursor?: MessageId): ContextEdge {
  return { complete: complete || cursor === undefined, cursor, loading: false };
}

function mergeMessages(...groups: ChatMessage[][]) {
  const messages = new Map<MessageId, ChatMessage>();
  groups.flat().forEach((message) => messages.set(message.id, message));
  return [...messages.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function previewKey(conversationId: ConversationId, messageId: MessageId) {
  return `${conversationId}:${messageId}`;
}

function unavailablePreview(messageId: MessageId): ReplyPreview {
  return {
    messageId,
    text: "Original message unavailable",
    unavailable: true,
  };
}

function preview(message: ChatMessage): ReplyPreview {
  return {
    messageId: message.id,
    authorId: message.authorId,
    author: message.author,
    text: message.deletedAt ? "Original message deleted" : message.body,
    unavailable: Boolean(message.deletedAt),
  };
}
