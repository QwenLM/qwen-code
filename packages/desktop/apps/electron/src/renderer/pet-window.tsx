import ReactDOM from 'react-dom/client';
import { Provider as JotaiProvider } from 'jotai';
import { setupI18n } from '@craft-agent/shared/i18n';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { DesktopPet } from './components/pet/DesktopPet';
import './index.css';

// Match the main window's language for the notification cards.
setupI18n([LanguageDetector, initReactI18next]);

// Standalone renderer entry for the floating desktop-pet window. It reuses the
// bootstrap preload (so `window.electronAPI`, incl. onSessionEvent, works) but
// renders only the pet.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <JotaiProvider>
    <DesktopPet />
  </JotaiProvider>,
);
