import { describe, expect, it } from "vitest";
import { entityId } from "../entity-id.js";
import {
  atomicDeletionRange,
  mentionQuery,
  shiftMentions,
  validMentions,
} from "./mentions.js";

const alice = entityId<"user">("11111111-1111-4111-8111-111111111111");

describe("mention editing", () => {
  it("deletes a mention atomically even when only part is selected", () => {
    expect(
      atomicDeletionRange(
        "hello @Alice there",
        [{ begin: 6, end: 12, userId: alice }],
        9,
        9,
        "backward",
      ),
    ).toEqual({ start: 6, end: 12 });
  });

  it("shifts unaffected mentions and drops edited mentions", () => {
    const mentions = [{ begin: 6, end: 12, userId: alice }];
    expect(
      shiftMentions("hello @Alice", "well hello @Alice", mentions),
    ).toEqual([{ begin: 11, end: 17, userId: alice }]);
    expect(shiftMentions("hello @Alice", "hello @Ally", mentions)).toEqual([]);
  });

  it("recognizes mention queries outside inline and fenced code", () => {
    expect(mentionQuery("hello @ali", 10)).toEqual({ start: 6, query: "ali" });
    expect(mentionQuery("`hello @ali", 11)).toBeUndefined();
    expect(mentionQuery("```\nhello @ali", 14)).toBeUndefined();
  });

  it("rejects invalid ranges", () => {
    expect(
      validMentions("hello", [
        { begin: -1, end: 2, userId: alice },
        { begin: 0, end: 20, userId: alice },
      ]),
    ).toEqual([]);
  });
});
