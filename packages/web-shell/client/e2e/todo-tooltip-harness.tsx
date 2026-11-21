import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TodoPanel } from '../components/panels/TodoPanel';
import { I18nProvider } from '../i18n';
import appStyles from '../App.module.css';
import '../styles/globals.css';
import '../styles/standalone.css';

// The real bottom-bar container (App.module.css) hosts the real TodoPanel,
// so the spec exercises the true geometry: the bar floats above the footer,
// the card and the 8px band above the bar overlap the transcript behind.
const todos = [
  { id: '1', status: 'in_progress', content: 'First todo row one' },
  { id: '2', status: 'pending', content: 'Second todo row two' },
  { id: '3', status: 'pending', content: 'Third todo row three' },
] as const;

const stats = { opened: 0, transcriptClicks: 0 };
function publish() {
  document.getElementById('demo-stats')?.replaceChildren(JSON.stringify(stats));
}

function Harness() {
  return (
    <div
      data-demo-stage
      // globals.css scopes its box-sizing: border-box reset to
      // [data-web-shell-root]:where([data-web-shell-shadcn]) *, so the
      // harness root must carry both attributes or the card's box model
      // drifts from the real app (560px border-box -> 592px content-box).
      data-web-shell-root
      data-web-shell-shadcn
      style={{ position: 'relative', height: '100vh', overflow: 'hidden' }}
    >
      <div
        data-demo-transcript
        onClick={() => {
          stats.transcriptClicks += 1;
          publish();
        }}
        style={{
          position: 'absolute',
          inset: 0,
          padding: 24,
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        {Array.from({ length: 40 }, (_, index) => (
          <p key={index} style={{ margin: '0 0 14px', color: '#8a8f98' }}>
            Transcript line {index + 1}
          </p>
        ))}
      </div>
      <div
        className={appStyles.footer}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          width: 'auto',
          height: 96,
        }}
      >
        <div
          data-demo-composer
          style={{
            height: 64,
            margin: '0 20px',
            borderRadius: 12,
            border: '1px solid #555a63',
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            color: '#8a8f98',
          }}
        >
          Composer placeholder
        </div>
        <div className={appStyles.bottomPanels}>
          <TodoPanel
            todos={[...todos]}
            onOpen={() => {
              stats.opened += 1;
              publish();
            }}
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider language="en">
      <Harness />
    </I18nProvider>
  </StrictMode>,
);
