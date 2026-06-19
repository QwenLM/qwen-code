import type { WebViewId } from './views';
import { WEB_VIEWS } from './views';

interface SidebarProps {
  activeView: WebViewId;
  onSelectView: (view: WebViewId) => void;
}

export function Sidebar({ activeView, onSelectView }: SidebarProps) {
  return (
    <aside className="web-sidebar">
      <div className="web-sidebar-chrome" aria-hidden="true">
        <div className="web-window-dots">
          <span />
          <span />
          <span />
        </div>
        <div className="web-sidebar-tools">
          <span>⌕</span>
          <span>□</span>
        </div>
      </div>
      <div className="web-brand">
        <div className="web-brand-mark">Q</div>
        <div>
          <div className="web-brand-title">Qwen Code</div>
          <div className="web-brand-subtitle">Workspace</div>
        </div>
      </div>
      <nav className="web-nav" aria-label="Workspace sections">
        {WEB_VIEWS.map((view) => (
          <button
            key={view.id}
            className={
              view.id === activeView ? 'web-nav-item active' : 'web-nav-item'
            }
            type="button"
            onClick={() => onSelectView(view.id)}
          >
            <span>{view.label}</span>
            <small>{view.description}</small>
          </button>
        ))}
      </nav>
      <div className="web-sidebar-footer">
        <div className="web-sidebar-hint">使用工作区上下文，让 Qwen Code 规划、执行和整理任务。</div>
        <div className="web-sidebar-account">
          <div className="web-sidebar-avatar">QC</div>
          <div>
            <strong>42129</strong>
            <span>Qwen Plan</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
