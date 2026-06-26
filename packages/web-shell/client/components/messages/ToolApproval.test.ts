import { describe, expect, it } from 'vitest';
import { parseTitle } from './ToolApproval';

describe('parseTitle', () => {
  it('splits short CLI-style tool prefixes', () => {
    expect(parseTitle('Bash: npm test')).toEqual({
      toolName: 'Bash',
      description: 'npm test',
    });
  });

  it('does not split descriptive titles that contain prose colons', () => {
    const title =
      'Fetching content from https://www.aliyun.com/activity (format: auto) and processing with prompt: "请列出阿里云官网当前正在进行的所有活动，包括活动名称、主要内容、优惠信息和链接"';

    expect(parseTitle(title)).toEqual({
      toolName: title,
      description: '',
    });
  });
});
