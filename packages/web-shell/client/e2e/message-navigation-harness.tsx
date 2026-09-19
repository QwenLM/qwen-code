import ReactDOM from 'react-dom/client';
import '../styles/standalone.css';
import type { WebShellApi, WebShellMessageNavigationRequest } from '../index';
const entry = '../index.tsx';
const { WebShellWithProviders } = await import(/* @vite-ignore */ entry);
const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.classList.add(`theme-${theme}`);
document.documentElement.classList.toggle('dark', theme === 'dark');
window.localStorage.setItem('qwen-code-web-shell-chat-width', 'wide');
let api: WebShellApi | null = null;
Object.assign(window, {
  navigateSyntheticMessage: (request: WebShellMessageNavigationRequest) =>
    api?.navigateToMessage(request),
});
ReactDOM.createRoot(document.getElementById('root')!).render(
  <WebShellWithProviders
    baseUrl={window.location.origin}
    sessionId={params.get('sessionId')!}
    theme={theme}
    language={params.get('language') === 'zh-CN' ? 'zh-CN' : 'en'}
    shellRef={(value) => {
      api = value;
    }}
  />,
);
