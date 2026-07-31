/**
 * Tests for validation.ts
 */

import { describe, it, expect } from 'bun:test';
import { validateAutomationsConfig, validateAutomationsContent } from './validation.ts';
import { AutomationsConfigSchema } from './schemas.ts';

describe('validation', () => {
  describe('validateAutomationsConfig', () => {
    it('should accept a valid config', () => {
      const config = {
        automations: {
          SessionStatusChange: [{
            matcher: 'done',
            actions: [{ type: 'prompt', prompt: 'echo done' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.config).not.toBeNull();
    });

    it('should accept an empty automations object', () => {
      const result = validateAutomationsConfig({ automations: {} });
      expect(result.valid).toBe(true);
    });

    it('should reject non-object input', () => {
      const result = validateAutomationsConfig('not an object');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should accept config without automations key (defaults to empty)', () => {
      // The schema provides a default empty automations object
      const result = validateAutomationsConfig({});
      expect(result.valid).toBe(true);
      expect(result.config?.automations).toEqual({});
    });

    it('should accept config with prompt actions', () => {
      const config = {
        automations: {
          SchedulerTick: [{
            cron: '0 9 * * *',
            actions: [{ type: 'prompt', prompt: 'Good morning!' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should accept config with disabled matchers', () => {
      const config = {
        automations: {
          LabelAdd: [{
            enabled: false,
            matcher: 'bug',
            actions: [{ type: 'prompt', prompt: 'echo disabled' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should accept config with optional name field', () => {
      const config = {
        automations: {
          SchedulerTick: [{
            name: 'Daily Weather Report',
            cron: '0 8 * * *',
            actions: [{ type: 'prompt', prompt: 'Check the weather' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should reject state conditions with no operator', () => {
      const config = {
        automations: {
          LabelAdd: [{
            conditions: [{ condition: 'state', field: 'mode' }],
            actions: [{ type: 'prompt', prompt: 'test' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('at least one operator'))).toBe(true);
    });

    it('should reject state conditions with conflicting operator groups', () => {
      const config = {
        automations: {
          LabelAdd: [{
            conditions: [{ condition: 'state', field: 'mode', value: 'ask', not_value: 'safe' }],
            actions: [{ type: 'prompt', prompt: 'test' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('exactly one operator group'))).toBe(true);
    });

    it('should reject semantically invalid time values in object validation path', () => {
      const config = {
        automations: {
          LabelAdd: [{
            conditions: [{ condition: 'time', after: '25:61' }],
            actions: [{ type: 'prompt', prompt: 'test' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid time value'))).toBe(true);
    });

    it('should reject condition nesting beyond maximum depth', () => {
      let nested: unknown = { condition: 'state', field: 'mode', value: 'ask' };
      for (let i = 0; i < 9; i++) {
        nested = { condition: 'and', conditions: [nested] };
      }

      const config = {
        automations: {
          LabelAdd: [{
            conditions: [nested],
            actions: [{ type: 'prompt', prompt: 'test' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('exceeds maximum depth'))).toBe(true);
    });
  });

  describe('validateAutomationsContent', () => {
    it('should accept valid JSON config', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: 'bug',
            actions: [{ type: 'prompt', prompt: 'echo bug' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid JSON', () => {
      const result = validateAutomationsContent('not json{');
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain('Invalid JSON');
    });

    it('should reject ReDoS patterns (nested quantifiers)', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: '(a+)+',
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('ReDoS'))).toBe(true);
    });

    it('should reject ReDoS patterns (repeated alternation)', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: '(a|b)+',
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
    });

    it('should reject ReDoS patterns (repeated greedy quantifiers)', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: '.*.*',
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
    });

    it('should reject invalid regex syntax', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: '[invalid',
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Invalid regex'))).toBe(true);
    });

    it('should reject regex patterns that are too long', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: 'a'.repeat(501),
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('too long'))).toBe(true);
    });

    it('should reject invalid cron expressions', () => {
      const json = JSON.stringify({
        automations: {
          SchedulerTick: [{
            cron: 'not a cron',
            actions: [{ type: 'prompt', prompt: 'echo tick' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Invalid cron'))).toBe(true);
    });

    it('should reject invalid timezone', () => {
      const json = JSON.stringify({
        automations: {
          SchedulerTick: [{
            cron: '0 9 * * *',
            timezone: 'Not/A/Timezone',
            actions: [{ type: 'prompt', prompt: 'echo tick' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Invalid timezone'))).toBe(true);
    });

    it('should warn about allow-all permission mode', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            permissionMode: 'allow-all',
            actions: [{ type: 'prompt', prompt: 'echo danger' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(true); // Warning, not error
      expect(result.warnings.some(w => w.message.includes('allow-all'))).toBe(true);
    });

    it('should warn about empty automations config', () => {
      const json = JSON.stringify({ automations: {} });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.message.includes('No automations configured'))).toBe(true);
    });

    it('should warn when cron is used on non-SchedulerTick event', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            cron: '0 9 * * *',
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.warnings.some(w => w.message.includes('SchedulerTick'))).toBe(true);
    });

    it('should accept valid simple regex patterns', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: 'bug|feature|fix',
            actions: [{ type: 'prompt', prompt: 'echo matched' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(true);
    });

    it('should accept valid cron with timezone', () => {
      const json = JSON.stringify({
        automations: {
          SchedulerTick: [{
            cron: '15 16 * * *',
            timezone: 'Europe/Budapest',
            actions: [{ type: 'prompt', prompt: 'Schedule check' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(true);
    });
  });

  describe('deprecated event aliases', () => {
    it('should accept TodoStateChange as deprecated alias', () => {
      const config = JSON.stringify({
        automations: {
          TodoStateChange: [{
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(config);
      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          path: 'automations.TodoStateChange',
          severity: 'warning',
          suggestion: expect.stringContaining('SessionStatusChange'),
        })
      );
    });

    it('should rewrite TodoStateChange to SessionStatusChange in schema transform', () => {
      const raw = {
        automations: {
          TodoStateChange: [{
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      };
      const result = AutomationsConfigSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.automations['SessionStatusChange']).toBeDefined();
        expect(result.data.automations['TodoStateChange']).toBeUndefined();
      }
    });
  });
});
