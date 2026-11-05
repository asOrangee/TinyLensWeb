import { useDemoI18n } from '../lib/demo-i18n';
import { useEffect, useState } from 'react';
import { ArrowUpRight, CircleHelp } from 'lucide-react';
import type { DesignId } from '../lib/designs';
import './agent-inbox-notice.css';

/** A link to real AI questions, kept distinct from this page's synthetic run. */
export default function AgentInboxNotice({ designId, onConnectionChange }: { designId: DesignId; onConnectionChange?: (connected: boolean) => void }) {
  const {t}=useDemoI18n();
  const [notice, setNotice] = useState({ count: 0, title: '', live: false });
  useEffect(() => {
    const events = new EventSource('/api/agent/events');
    events.addEventListener('state', event => {
      try {
        const state = JSON.parse((event as MessageEvent).data);
        onConnectionChange?.(state.connection === 'connected');
        const pending = Array.isArray(state.questions) ? state.questions.filter((question: { threadId?: unknown; status?: unknown }) => question && question.threadId === state.threadId && ['pending', 'sending', 'delivery_unknown'].includes(String(question.status))) : [];
        setNotice({ count: pending.length, title: typeof pending[0]?.title === 'string' ? pending[0].title : '', live: true });
      } catch { /* The real workspace displays protocol diagnostics. */ }
    });
    events.onerror = () => { setNotice(previous => ({ ...previous, live: false })); onConnectionChange?.(false); };
    return () => events.close();
  }, [onConnectionChange]);
  if (!notice.count) return null;
  return <aside className="real-agent-inbox" aria-label={t("真实 AI 待处理问题")} role="status">
    <CircleHelp size={20}/><div><strong>{t('真实 Pipeline AI 有 {count} 个待处理问题',{count:notice.count})}</strong><span>{notice.title || t("请在真实会话中查看并答复。")}{!notice.live && t(" · 正在恢复更新连接")}</span></div>
    <a href={`/?mode=agent&design=${designId}#agent-pending-questions`}>{t("查看并答复")}<ArrowUpRight size={15}/></a>
  </aside>;
}
