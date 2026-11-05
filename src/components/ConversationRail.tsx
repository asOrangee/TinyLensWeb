import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import type { StageId } from '../data/stages';
import { requestStageLabel, type SendIntent } from '../lib/message-intent';
import { isComposerSubmitKey } from '../lib/composer-keys';
import { useDemoI18n } from '../lib/demo-i18n';
import ConversationResizeHandle from './ConversationResizeHandle';
import AssistantReply from './AssistantReply';

export type ConversationMessage = { id: string; role: 'user' | 'assistant'; text: string; complete?: boolean; at?: string; intent?: SendIntent; stages?: StageId[]; note?: string };
type Props = {
  messages: ConversationMessage[]; value: string; onChange: (value: string) => void; onSubmit: () => void;
  disabled?: boolean; busy?: boolean; replyPending?: boolean; error?: string; textareaId: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>; onInterrupt?: () => void | Promise<unknown>; attention?: ReactNode; attentionCount?: number;
  interruptAvailable?: boolean; newTask?: boolean; inactive?:boolean;
  connectionAction?: ReactNode; conversationId?: string; aiName?: string;
};
export default function ConversationRail(props: Props) {
  const { t } = useDemoI18n();
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const reading = useRef(false);
  const composing = useRef(false);
  const composer = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const followReply = useCallback(() => { if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, []);
  const [motion, setMotion] = useState(() => !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.hidden);
  const seen = useRef({ conversationId: props.conversationId, ready: false, ids: new Set<string>() });
  if (seen.current.conversationId !== props.conversationId) seen.current = { conversationId: props.conversationId, ready: false, ids: new Set<string>() };
  useLayoutEffect(() => {
    if (!props.messages.length) return;
    seen.current.ready = true;
    for (const message of props.messages) seen.current.ids.add(message.id);
  }, [props.messages, props.conversationId]);
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setMotion(!preference.matches && !document.hidden);
    preference.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => { preference.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  const [interrupting, setInterrupting] = useState(false);
  const interruptLock = useRef(false);
  const canInterrupt = !!props.onInterrupt && !!(props.busy || props.interruptAvailable);
  async function interrupt() {
    if (interruptLock.current || props.disabled || props.inactive || !canInterrupt) return;
    interruptLock.current = true; setInterrupting(true);
    try { await props.onInterrupt?.(); }
    finally { interruptLock.current = false; setInterrupting(false); }
  }
  const setTextarea = useCallback((node: HTMLTextAreaElement | null) => {
    textarea.current = node;
    if (props.inputRef) props.inputRef.current = node;
  }, [props.inputRef]);
  const resizeInput = useCallback(() => {
    const panel = composer.current, input = textarea.current;
    if (!panel || !input || !input.clientWidth) return;
    const scrollTop = input.scrollTop;
    const atBottom = input.scrollHeight - input.clientHeight - scrollTop < 2;
    // Measure at the minimum so deleting text can shrink the panel as well as grow it.
    // Heights include the panel padding and its send/actions row.
    panel.style.height = '125px';
    const overflow = Math.max(0, input.scrollHeight - input.clientHeight);
    panel.style.height = `${Math.min(225, 125 + overflow)}px`;
    input.scrollTop = atBottom ? input.scrollHeight - input.clientHeight : scrollTop;
    if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, []);
  useLayoutEffect(resizeInput, [resizeInput, props.value, props.error, props.busy, props.interruptAvailable, props.inactive, !!props.connectionAction, t]);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === input.clientWidth) return;
      width = input.clientWidth;
      resizeInput();
    });
    observer.observe(input);
    const root = composer.current?.closest('.app-shell');
    const theme = new MutationObserver(resizeInput);
    if (root) theme.observe(root, { attributes: true, attributeFilter: ['data-design'] });
    window.addEventListener('resize', resizeInput);
    return () => { observer.disconnect(); theme.disconnect(); window.removeEventListener('resize', resizeInput); };
  }, [resizeInput]);
  useEffect(() => { if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [props.messages, props.attentionCount, props.replyPending]);
  const ready = !!props.value.trim() && !props.disabled && !props.inactive && !props.busy && !canInterrupt;
  const activeButton = !!props.value.trim() || !!(props.busy || props.interruptAvailable);
  const submit = () => { if (ready) { reading.current = false; pinned.current = true; props.onSubmit(); } };
  return <aside className="insight-rail conversation-rail" aria-label={t('AI 会话与输入')}>
    <ConversationResizeHandle/>
    <header className="conversation-topbar"><span className="conversation-agent-badge">Agentic Pipeline: {props.aiName?.trim() || '—'}</span></header>
    <section className="conversation-stream" aria-label={t('问答会话')}>
      <div className="conversation-log" ref={log} role="log" aria-label={t('会话记录')} onWheelCapture={event => { if (event.deltaY < 0) { reading.current = true; pinned.current = false; } else if (event.deltaY > 0) reading.current = false; }} onPointerDownCapture={event => { reading.current = event.target !== event.currentTarget; pinned.current = false; }} onKeyDownCapture={event => { if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) { reading.current = true; pinned.current = false; } else if (['PageDown', 'End', 'ArrowDown'].includes(event.key)) reading.current = false; }} onScroll={event => { const el = event.currentTarget; const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4; if (!atBottom) pinned.current = false; else if (!reading.current) pinned.current = true; }}>
        {props.messages.map(message => <article className={`conversation-message is-${message.role}`} hidden={message.role === 'assistant' && !message.text.trim()} key={`${props.conversationId ?? ''}:${message.id}`}>
          <div className="conversation-message-meta"><strong>{message.role === 'user' ? t('你') : 'Pipeline AI'}</strong></div>
          {message.role === 'assistant' ? <AssistantReply text={message.text} animateOnMount={seen.current.ready && !seen.current.ids.has(message.id)} motion={motion} onTextLayout={followReply}/> : message.text.length > 1600 ? <details className="conversation-long-message"><summary>{message.text.slice(0, 150)}…</summary><p>{message.text}</p></details> : <p>{message.text}</p>}
          {!!message.stages?.length && <div className="conversation-message-stages">{message.stages.map(stage => <span key={stage}>{requestStageLabel(stage)}</span>)}</div>}
          {message.note && <small className="conversation-message-note">{message.note}</small>}
        </article>)}
        {props.replyPending && <div className="conversation-typing" role="status" aria-label={t('AI 正在处理，回复尚未结束')}><span className="conversation-typing-dot" aria-hidden="true"/><span className="conversation-typing-dot" aria-hidden="true"/><span className="conversation-typing-dot" aria-hidden="true"/></div>}
        {props.attention && <div className="conversation-attention">{props.attention}</div>}
      </div>
    </section>
    <section className="conversation-composer" ref={composer} aria-label={t('消息输入')}>
      <form onSubmit={event => { event.preventDefault(); submit(); }}>
        <div className="conversation-input-shell"><div className="conversation-input-body"><textarea ref={setTextarea} id={props.textareaId} disabled={props.inactive} aria-label={t('消息内容')} value={props.value} rows={2} maxLength={24000} onChange={event => props.onChange(event.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event => { if (!isComposerSubmitKey(event.nativeEvent,composing.current)) return; event.preventDefault(); if (!event.repeat) submit(); }}/></div><div className="conversation-input-actions">{props.connectionAction}<button className={`conversation-send${canInterrupt ? ' is-stop' : ''}`} type={canInterrupt ? 'button' : 'submit'} data-active={activeButton || undefined} aria-label={t(canInterrupt ? '中断当前回合' : props.newTask ? '发送任务' : '发送消息')} title={t(canInterrupt ? '中断当前回合' : props.newTask ? '发送任务' : '发送消息')} disabled={canInterrupt ? !!props.disabled || !!props.inactive || interrupting : !ready} onClick={canInterrupt ? () => void interrupt() : undefined}>{canInterrupt ? <Square size={11} fill="currentColor" strokeWidth={0}/> : <ArrowUp size={17}/>}</button></div></div>
        {props.error && <div className="conversation-composer-note" role="status">{props.error}</div>}
      </form>
    </section>
  </aside>;
}
