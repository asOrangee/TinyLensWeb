type ComposerKey = { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number };

/** IME confirmation belongs to the input method, including Safari's legacy 229 event. */
export function isComposerSubmitKey(event: ComposerKey, composing = false): boolean {
  return event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing && event.keyCode !== 229;
}
