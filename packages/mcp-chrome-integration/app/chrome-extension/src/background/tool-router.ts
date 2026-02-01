import { isKnownToolName } from './tool-catalog';

export function createToolRouter(handlers, unsupportedFactory) {
  const map = new Map(Object.entries(handlers || {}));

  return {
    get(name) {
      if (!name) return null;
      if (map.has(name)) return map.get(name);
      if (isKnownToolName(name)) {
        return unsupportedFactory ? unsupportedFactory(name) : null;
      }
      return null;
    },
  };
}
