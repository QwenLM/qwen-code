import { describe, expect, it } from 'vitest';
import { buildCompactDirective } from './compact-utils.js';
import type { Config } from '../config/config.js';

const config = { getApprovedPlanPath: () => '/plan.md' } as Config;
const qwen = { key: 'qwen4-max', displayName: 'Qwen4-Max' };
const nonQwen = { key: 'dfmodel', displayName: 'DeepSeek' };

describe('compact directive by selected model', () => {
  it.each([
    'qwen3.8-max',
    'qwen3.8-max-0902',
    'qwen4-max',
    'qwen4.0-max-preview',
    'custom/qwen3.8-flash',
    'qmodel_38max',
    'qmodel_latest',
    'qmodel_latest_preview',
    'qfmodel',
  ])('requests only a summary for %s', (key) => {
    const directive = buildCompactDirective(config, undefined, {
      key,
      displayName: key,
    });
    expect(directive).toContain('Output only the <summary> block.');
    expect(directive).not.toContain('<analysis>');
  });

  it('recognizes a Qwen display name behind an opaque custom key', () => {
    expect(
      buildCompactDirective(config, undefined, {
        key: 'custom/model-123',
        displayName: 'Qwen4-Max',
      }),
    ).toContain('Output only the <summary> block.');
  });

  it('keeps the summary instructions, approved plan, and no-tools reminder', () => {
    const directive = buildCompactDirective(config, 'Keep task IDs.', qwen);
    const standard = buildCompactDirective(config, 'Keep task IDs.', nonQwen);
    expect(directive).toContain('Do not output an analysis block');
    expect(directive).toContain(
      'Preserve any security-relevant instructions or constraints verbatim',
    );
    expect(directive).toContain('/plan.md');
    expect(directive).toContain('Keep task IDs.');
    expect(directive).toContain('Do NOT call any tools');
    expect(directive.slice(directive.indexOf('Your summary should include'))).toBe(
      standard
        .slice(standard.indexOf('Your summary should include'))
        .replace(
          '<analysis>\n[Your thought process, ensuring all points are covered thoroughly and accurately]\n</analysis>\n',
          '',
        )
        .replace(
          'an <analysis> block followed by a <summary> block',
          'a <summary> block only',
        ),
    );
  });

  it('keeps non-Qwen and unknown compact models unchanged', () => {
    for (const model of [
      undefined,
      nonQwen,
      { key: 'custom/not-qwen', displayName: 'Other' },
    ]) {
      expect(buildCompactDirective(config, undefined, model)).toContain(
        'wrap your analysis in <analysis>',
      );
    }
  });
});
