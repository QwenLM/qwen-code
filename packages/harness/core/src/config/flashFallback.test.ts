import { describe, expect, it, vi } from 'vitest';
import { Config } from './config.js';
describe('activateFallbackMode', () => {
  it.each([true, false])(
    'awaits the existing model selection when it returns %s',
    async (accepted) => {
      const setModel = vi.fn().mockResolvedValue(accepted);
      const config = {
        setModel,
        getContentGeneratorConfig: () => undefined,
      } as unknown as Config;
      await Config.prototype.activateFallbackMode.call(config, 'lite');
      expect(setModel).toHaveBeenCalledExactlyOnceWith('lite', true);
    },
  );
});
