import i18n, { type i18n as I18nInstance, type InitOptions } from "i18next";
import { LOCALE_REGISTRY } from "./registry";
import { SUPPORTED_LANGUAGE_CODES } from "./languages";

// Build i18next resources from the locale registry.
const resources = Object.fromEntries(
  Object.entries(LOCALE_REGISTRY).map(([code, entry]) => [
    code,
    { translation: entry.messages },
  ]),
);

// Safe as a boolean guard because init is synchronous (initImmediate: false).
// If async init is ever needed, replace with a promise-based singleton.
let initialized = false;

/**
 * Initialize i18next with bundled translations.
 * Call once at app startup. Pass `plugins` to add framework integrations
 * (e.g. initReactI18next for React apps, LanguageDetector for browser apps).
 */
export function setupI18n(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: any[] = [],
): I18nInstance {
  if (initialized) return i18n;

  let instance = i18n;
  for (const plugin of plugins) {
    instance = instance.use(plugin);
  }

  instance.init({
    resources,
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGE_CODES],
    interpolation: { escapeValue: false },
    initImmediate: false, // synchronous init — resources are bundled inline
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "i18nextLng",
    },
  } as InitOptions);

  initialized = true;
  return i18n;
}

export { i18n };
