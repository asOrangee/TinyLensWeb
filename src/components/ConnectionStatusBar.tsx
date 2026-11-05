import { useDemoI18n } from '../lib/demo-i18n';

export default function ConnectionStatusBar({ connected }: { connected: boolean }) {
  const { t } = useDemoI18n();
  return <footer className="workbench-status-bar" role="status" aria-label={t('服务器连接状态')}>
    <span className="workbench-connection" data-connected={connected}>
      <i aria-hidden="true"/>{t(connected ? '服务器已连接' : '服务器已断开')}
    </span>
  </footer>;
}
