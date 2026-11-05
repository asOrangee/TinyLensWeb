export const REPLY_FADE_MS = 360;
const MAX_ACTIVE_FRAGMENTS = 48;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type ReplyFragment = { id: number; text: string; delay: number; until: number };
export type ReplyReveal = { text: string; stable: string; fragments: ReplyFragment[]; nextId: number };

export function plainReply(text: string, nextId = 0): ReplyReveal {
  return { text, stable: text, fragments: [], nextId };
}

export function settleReply(frame: ReplyReveal, now: number): ReplyReveal {
  let count = 0;
  while (count < frame.fragments.length && frame.fragments[count].until <= now) count++;
  if (!count) return frame;
  return { ...frame, stable: frame.stable + frame.fragments.slice(0, count).map(part => part.text).join(''), fragments: frame.fragments.slice(count) };
}

/** Animate only newly received text; every frame retains the exact original string. */
export function revealReply(frame: ReplyReveal, text: string, now: number, animate = true): ReplyReveal {
  if (!animate || !text.startsWith(frame.text)) return plainReply(text, frame.nextId);
  const settled = settleReply(frame, now);
  if (text === frame.text) return settled;
  const units = Array.from(graphemes.segment(text.slice(frame.text.length)), unit => unit.segment);
  const size = Math.max(6, Math.ceil(units.length / 12));
  const fragments = [...settled.fragments];
  let nextId = frame.nextId;
  for (let start = 0, index = 0; start < units.length; start += size, index++) {
    const delay = Math.min(index * 9, 72);
    fragments.push({ id: nextId++, text: units.slice(start, start + size).join(''), delay, until: now + delay + REPLY_FADE_MS });
  }
  const overflow = Math.max(0, fragments.length - MAX_ACTIVE_FRAGMENTS);
  return { text, stable: settled.stable + fragments.slice(0, overflow).map(part => part.text).join(''), fragments: fragments.slice(overflow), nextId };
}
