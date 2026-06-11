/**
 * Tests for content-based config validators used by PreToolUse hook.
 * These validators check file content in memory before it reaches disk.
 */
import { describe, it, expect } from 'bun:test';
import {
  validateSourceConfigContent,
  validateSkillContent,
  validateStatusesContent,
  validatePermissionsContent,
  detectConfigFileType,
  validateConfigFileContent,
} from '../src/config/validators.ts';

// ============================================================
// validateSourceConfigContent
// ============================================================

describe('validateSourceConfigContent', () => {
  it('passes for valid MCP source config', () => {
    const config = JSON.stringify({
      id: 'test-source',
      name: 'Test Source',
      slug: 'test-source',
      enabled: true,
      provider: 'custom',
      type: 'mcp',
      mcp: { url: 'https://example.com/mcp', authType: 'bearer' },
    });
    const result = validateSourceConfigContent(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes for valid API source config', () => {
    const config = JSON.stringify({
      id: 'api-source',
      name: 'API Source',
      slug: 'api-source',
      enabled: true,
      provider: 'github',
      type: 'api',
      api: { baseUrl: 'https://api.github.com', authType: 'bearer' },
    });
    const result = validateSourceConfigContent(config);
    expect(result.valid).toBe(true);
  });

  it('passes for valid stdio MCP source config', () => {
    const config = JSON.stringify({
      id: 'stdio-source',
      name: 'Stdio Source',
      slug: 'stdio-source',
      enabled: true,
      provider: 'custom',
      type: 'mcp',
      mcp: { transport: 'stdio', command: '/usr/local/bin/my-server' },
    });
    const result = validateSourceConfigContent(config);
    expect(result.valid).toBe(true);
  });

  it('fails for invalid JSON', () => {
    const result = validateSourceConfigContent('{ invalid json }');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Invalid JSON');
  });

  it('fails when required fields are missing', () => {
    const config = JSON.stringify({ id: 'x' });
    const result = validateSourceConfigContent(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('fails when slug has invalid characters', () => {
    const config = JSON.stringify({
      id: 'test',
      name: 'Test',
      slug: 'Invalid_Slug!',
      enabled: true,
      provider: 'custom',
      type: 'mcp',
      mcp: { url: 'https://example.com', authType: 'bearer' },
    });
    const result = validateSourceConfigContent(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('Slug'))).toBe(true);
  });

  it('fails when type-specific config block is missing', () => {
    const config = JSON.stringify({
      id: 'test',
      name: 'Test',
      slug: 'test',
      enabled: true,
      provider: 'custom',
      type: 'mcp',
      // Missing mcp block
    });
    const result = validateSourceConfigContent(config);
    expect(result.valid).toBe(false);
  });
});

// ============================================================
// validateSkillContent
// ============================================================

describe('validateSkillContent', () => {
  it('passes for valid SKILL.md content', () => {
    const content = `---
name: My Skill
description: A test skill for testing
---

# Instructions

Do things.
`;
    const result = validateSkillContent(content, 'my-skill');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes with optional fields (globs, alwaysAllow)', () => {
    const content = `---
name: Git Helper
description: Helps with git operations
globs:
  - "**/*.ts"
alwaysAllow:
  - Bash
---

Help with git.
`;
    const result = validateSkillContent(content, 'git-helper');
    expect(result.valid).toBe(true);
  });

  it('fails when frontmatter is missing name', () => {
    const content = `---
description: A skill without a name
---

Content here.
`;
    const result = validateSkillContent(content, 'test-skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'name')).toBe(true);
  });

  it('fails when frontmatter is missing description', () => {
    const content = `---
name: Test Skill
---

Content here.
`;
    const result = validateSkillContent(content, 'test-skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'description')).toBe(true);
  });

  it('fails when body is empty', () => {
    const content = `---
name: Empty Skill
description: This skill has no body
---
`;
    const result = validateSkillContent(content, 'empty-skill');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('empty'))).toBe(true);
  });

  it('fails when slug has invalid characters', () => {
    const content = `---
name: Test
description: Test skill
---

Content.
`;
    const result = validateSkillContent(content, 'Invalid_Slug');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('Slug'))).toBe(true);
  });

  it('fails for invalid YAML frontmatter', () => {
    const content = `---
name: [invalid yaml
  unclosed: {bracket
---

Content.
`;
    const result = validateSkillContent(content, 'test-skill');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('frontmatter');
  });
});

// ============================================================
// validateStatusesContent
// ============================================================

describe('validateStatusesContent', () => {
  const validStatuses = {
    version: 1,
    defaultStatusId: 'todo',
    statuses: [
      { id: 'todo', label: 'To Do', category: 'open', isFixed: true, isDefault: true, order: 0 },
      { id: 'in-progress', label: 'In Progress', category: 'open', isFixed: false, isDefault: false, order: 1 },
      { id: 'done', label: 'Done', category: 'closed', isFixed: true, isDefault: false, order: 2 },
      { id: 'cancelled', label: 'Cancelled', category: 'closed', isFixed: true, isDefault: false, order: 3 },
    ],
  };

  it('passes for valid statuses config', () => {
    const result = validateStatusesContent(JSON.stringify(validStatuses));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails for invalid JSON', () => {
    const result = validateStatusesContent('not json');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Invalid JSON');
  });

  it('fails when required fixed status is missing', () => {
    const config = {
      ...validStatuses,
      statuses: validStatuses.statuses.filter(s => s.id !== 'cancelled'),
    };
    const result = validateStatusesContent(JSON.stringify(config));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes("'cancelled'"))).toBe(true);
  });

  it('fails when defaultStatusId references non-existent status', () => {
    const config = {
      ...validStatuses,
      defaultStatusId: 'non-existent',
    };
    const result = validateStatusesContent(JSON.stringify(config));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('non-existent'))).toBe(true);
  });

  it('fails when duplicate status IDs exist', () => {
    const config = {
      ...validStatuses,
      statuses: [
        ...validStatuses.statuses,
        { id: 'todo', label: 'Duplicate', category: 'open', isFixed: false, isDefault: false, order: 4 },
      ],
    };
    const result = validateStatusesContent(JSON.stringify(config));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('Duplicate'))).toBe(true);
  });

  it('fails when no open category status exists', () => {
    const config = {
      version: 1,
      defaultStatusId: 'todo',
      statuses: [
        { id: 'todo', label: 'To Do', category: 'closed', isFixed: true, isDefault: true, order: 0 },
        { id: 'done', label: 'Done', category: 'closed', isFixed: true, isDefault: false, order: 1 },
        { id: 'cancelled', label: 'Cancelled', category: 'closed', isFixed: true, isDefault: false, order: 2 },
      ],
    };
    const result = validateStatusesContent(JSON.stringify(config));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('open'))).toBe(true);
  });

  it('warns when fixed status does not have isFixed flag', () => {
    const config = {
      ...validStatuses,
      statuses: validStatuses.statuses.map(s =>
        s.id === 'todo' ? { ...s, isFixed: false } : s
      ),
    };
    const result = validateStatusesContent(JSON.stringify(config));
    expect(result.valid).toBe(true); // Warnings don't make it invalid
    expect(result.warnings.some(w => w.message.includes('isFixed'))).toBe(true);
  });

  it('fails for schema violations (missing required fields)', () => {
    const config = { version: 1, statuses: [] };
    const result = validateStatusesContent(JSON.stringify(config));
    expect(result.valid).toBe(false);
  });
});

// ============================================================
// validatePermissionsContent
// ============================================================

describe('validatePermissionsContent', () => {
  it('passes for valid permissions config', () => {
    const config = JSON.stringify({
      allowedBashPatterns: ['git status', 'npm test'],
      allowedMcpPatterns: ['mcp__session__.*'],
    });
    const result = validatePermissionsContent(config);
    expect(result.valid).toBe(true);
  });

  it('passes for empty object (all fields optional)', () => {
    const result = validatePermissionsContent('{}');
    expect(result.valid).toBe(true);
  });

  it('passes with object-form patterns (pattern + comment)', () => {
    const config = JSON.stringify({
      allowedBashPatterns: [
        { pattern: 'git .*', comment: 'Allow git commands' },
        'npm test',
      ],
    });
    const result = validatePermissionsContent(config);
    expect(result.valid).toBe(true);
  });

  it('fails for invalid JSON', () => {
    const result = validatePermissionsContent('{{bad}}');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Invalid JSON');
  });

  it('fails for invalid regex patterns', () => {
    const config = JSON.stringify({
      allowedBashPatterns: ['[invalid regex('],
    });
    const result = validatePermissionsContent(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('uses custom displayFile for error messages', () => {
    const result = validatePermissionsContent('bad', 'sources/github/permissions.json');
    expect(result.errors[0].file).toBe('sources/github/permissions.json');
  });
});

// ============================================================
// detectConfigFileType
// ============================================================

describe('detectConfigFileType', () => {
  const workspaceRoot = '/Users/test/.craft-agent/workspaces/ws-123';

  it('detects source config files', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/sources/github/config.json`,
      workspaceRoot
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('source');
    expect(result!.slug).toBe('github');
    expect(result!.displayFile).toBe('sources/github/config.json');
  });

  it('detects skill SKILL.md files', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/skills/commit/SKILL.md`,
      workspaceRoot
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('skill');
    expect(result!.slug).toBe('commit');
    expect(result!.displayFile).toBe('skills/commit/SKILL.md');
  });

  it('detects statuses config', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/statuses/config.json`,
      workspaceRoot
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('statuses');
    expect(result!.displayFile).toBe('statuses/config.json');
  });

  it('detects workspace-level permissions.json', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/permissions.json`,
      workspaceRoot
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('permissions');
    expect(result!.displayFile).toBe('permissions.json');
  });

  it('detects source-level permissions.json', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/sources/linear/permissions.json`,
      workspaceRoot
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('permissions');
    expect(result!.slug).toBe('linear');
    expect(result!.displayFile).toBe('sources/linear/permissions.json');
  });

  it('returns null for files outside workspace root', () => {
    const result = detectConfigFileType(
      '/some/other/path/config.json',
      workspaceRoot
    );
    expect(result).toBeNull();
  });

  it('returns null for non-config files in workspace', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/sources/github/guide.md`,
      workspaceRoot
    );
    expect(result).toBeNull();
  });

  it('returns null for nested non-matching paths', () => {
    const result = detectConfigFileType(
      `${workspaceRoot}/sources/github/deep/config.json`,
      workspaceRoot
    );
    expect(result).toBeNull();
  });
});

// ============================================================
// validateConfigFileContent (dispatch)
// ============================================================

describe('validateConfigFileContent', () => {
  it('dispatches to source validator', () => {
    const detection = { type: 'source' as const, slug: 'test', displayFile: 'sources/test/config.json' };
    const validConfig = JSON.stringify({
      id: 'test', name: 'Test', slug: 'test', enabled: true,
      provider: 'custom', type: 'mcp',
      mcp: { url: 'https://example.com', authType: 'none' },
    });
    const result = validateConfigFileContent(detection, validConfig);
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
  });

  it('dispatches to skill validator', () => {
    const detection = { type: 'skill' as const, slug: 'my-skill', displayFile: 'skills/my-skill/SKILL.md' };
    const content = `---
name: Test
description: Test skill
---

Content here.
`;
    const result = validateConfigFileContent(detection, content);
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
  });

  it('dispatches to statuses validator', () => {
    const detection = { type: 'statuses' as const, displayFile: 'statuses/config.json' };
    const config = JSON.stringify({
      version: 1, defaultStatusId: 'todo',
      statuses: [
        { id: 'todo', label: 'To Do', category: 'open', isFixed: true, isDefault: true, order: 0 },
        { id: 'done', label: 'Done', category: 'closed', isFixed: true, isDefault: false, order: 1 },
        { id: 'cancelled', label: 'Cancelled', category: 'closed', isFixed: true, isDefault: false, order: 2 },
      ],
    });
    const result = validateConfigFileContent(detection, config);
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
  });

  it('dispatches to permissions validator', () => {
    const detection = { type: 'permissions' as const, displayFile: 'permissions.json' };
    const result = validateConfigFileContent(detection, '{}');
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
  });

  it('returns validation errors for invalid content', () => {
    const detection = { type: 'source' as const, slug: 'bad', displayFile: 'sources/bad/config.json' };
    const result = validateConfigFileContent(detection, '{ not valid json }');
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
  });
});
