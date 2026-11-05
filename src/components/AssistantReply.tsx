import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { plainReply, revealReply, settleReply } from '../lib/reply-reveal';

type Props = { text: string; animateOnMount: boolean; motion: boolean; onTextLayout: () => void };

function ReplyText({ text, animateOnMount, motion, onTextLayout }: Props) {
  const [frame, setFrame] = useState(() => animateOnMount && motion ? revealReply(plainReply(''), text, performance.now()) : plainReply(text));
  useLayoutEffect(() => {
    setFrame(previous => revealReply(previous, text, performance.now(), motion));
  }, [text, motion]);
  useLayoutEffect(onTextLayout, [frame.text, onTextLayout]);
  useEffect(() => {
    const next = frame.fragments[0];
    if (!next) return;
    const timer = window.setTimeout(() => setFrame(previous => settleReply(previous, performance.now())), Math.max(1, Math.ceil(next.until - performance.now()) + 1));
    return () => window.clearTimeout(timer);
  }, [frame]);
  return <>{frame.stable}{frame.fragments.map(part => <span key={part.id} className="assistant-reply-fragment" style={{ animationDelay: `${part.delay}ms` }}>{part.text}</span>)}</>;
}

export default memo(function AssistantReply({ text, animateOnMount, motion, onTextLayout }: Props) {
  const initial = useRef(text);
  const live = useRef(animateOnMount);
  if (text !== initial.current) live.current = true;
  // Keep saved long messages folded, but never fold a reply midway through streaming.
  if (text.length > 1600 && !live.current) return <details className="conversation-long-message"><summary>{text.slice(0, 150)}…</summary><p>{text}</p></details>;
  return <p><ReplyText text={text} animateOnMount={animateOnMount} motion={motion} onTextLayout={onTextLayout}/></p>;
});
