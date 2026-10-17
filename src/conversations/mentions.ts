import type { Mention } from "../domain.js";

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function codeUnitOffset(value: string, codePointOffset: number): number {
  return Array.from(value).slice(0, codePointOffset).join("").length;
}

export function mentionRanges(body: string, mentions: Mention[]) {
  return validMentions(body, mentions)
    .map((mention) => ({
      start: codeUnitOffset(body, mention.begin),
      end: codeUnitOffset(body, mention.end),
    }))
    .sort((left, right) => left.start - right.start);
}

export function atomicDeletionRange(
  body: string,
  mentions: Mention[],
  selectionStart: number,
  selectionEnd: number,
  direction: "backward" | "forward",
) {
  let start = selectionStart;
  let end = selectionEnd;
  if (start === end) {
    if (direction === "backward") start = Math.max(0, start - 1);
    else end = Math.min(body.length, end + 1);
  }
  if (start === end) return undefined;
  const ranges = mentionRanges(body, mentions);
  let touched = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const range of ranges) {
      if (start >= range.end || end <= range.start) continue;
      touched = true;
      const nextStart = Math.min(start, range.start);
      const nextEnd = Math.max(end, range.end);
      if (nextStart !== start || nextEnd !== end) {
        start = nextStart;
        end = nextEnd;
        changed = true;
      }
    }
  }
  return touched ? { start, end } : undefined;
}

export function validMentions(body: string, mentions: Mention[]): Mention[] {
  const length = codePointLength(body);
  return mentions.filter(
    ({ begin, end, userId }) =>
      Number.isInteger(begin) &&
      Number.isInteger(end) &&
      begin >= 0 &&
      end > begin &&
      end <= length &&
      Boolean(userId),
  );
}

export function shiftMentions(
  previous: string,
  next: string,
  mentions: Mention[],
): Mention[] {
  const oldPoints = Array.from(previous);
  const newPoints = Array.from(next);
  let prefix = 0;
  while (prefix < oldPoints.length && oldPoints[prefix] === newPoints[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < oldPoints.length - prefix &&
    suffix < newPoints.length - prefix &&
    oldPoints[oldPoints.length - suffix - 1] ===
      newPoints[newPoints.length - suffix - 1]
  )
    suffix++;
  const removedEnd = oldPoints.length - suffix;
  const delta = newPoints.length - oldPoints.length;
  return mentions.flatMap((mention) => {
    if (mention.end <= prefix) return [mention];
    if (mention.begin >= removedEnd)
      return [
        { ...mention, begin: mention.begin + delta, end: mention.end + delta },
      ];
    return [];
  });
}

export function mentionQuery(body: string, caret: number) {
  const beforeCaret = body.slice(0, caret);
  const match = /(?:^|[^\p{L}\p{N}_@])@([\p{L}\p{N}._-]*)$/u.exec(beforeCaret);
  if (!match) return undefined;
  const start = caret - match[1].length - 1;
  if (insideCode(body, start)) return undefined;
  return { start, query: match[1] };
}

function insideCode(body: string, offset: number) {
  const preceding = body.slice(0, offset);
  const lines = preceding.split("\n");
  let fence: { character: string; length: number } | undefined;
  for (const line of lines.slice(0, -1)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) continue;
    if (!fence) fence = { character: marker[0], length: marker.length };
    else if (marker[0] === fence.character && marker.length >= fence.length)
      fence = undefined;
  }
  if (fence) return true;
  const currentLine = lines.at(-1) ?? "";
  const backtickRuns = currentLine.match(/(?<!\\)`+/g) ?? [];
  return backtickRuns.length % 2 === 1;
}
