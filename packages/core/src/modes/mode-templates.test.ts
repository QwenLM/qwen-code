/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModeTemplateManager,
  toPascalCase,
  toCamelCase,
  toConstantCase,
} from './mode-templates.js';

describe('ModeTemplateManager', () => {
  let manager: ModeTemplateManager;

  beforeEach(() => {
    manager = new ModeTemplateManager();
  });

  describe('constructor', () => {
    it('should start with no templates', () => {
      expect(manager.getAllTemplates()).toHaveLength(0);
    });
  });

  describe('registerTemplate', () => {
    it('should register a template', () => {
      const template = {
        id: 'test-template',
        name: 'Test Template',
        description: 'A test template',
        icon: '🧪',
        category: 'test' as const,
        variables: [],
        files: [],
      };

      manager.registerTemplate(template);

      expect(manager.getTemplate('test-template')).toBeDefined();
      expect(manager.getTemplate('test-template')?.name).toBe('Test Template');
    });

    it('should overwrite existing template with same id', () => {
      manager.registerTemplate({
        id: 'test',
        name: 'Original',
        description: 'Original',
        icon: '📄',
        category: 'test',
        variables: [],
        files: [],
      });

      manager.registerTemplate({
        id: 'test',
        name: 'Updated',
        description: 'Updated',
        icon: '📄',
        category: 'test',
        variables: [],
        files: [],
      });

      expect(manager.getTemplate('test')?.name).toBe('Updated');
    });
  });

  describe('getAllTemplates', () => {
    it('should return all registered templates', () => {
      manager.registerTemplate({
        id: 't1',
        name: 'T1',
        description: 'T1',
        icon: '📄',
        category: 'test',
        variables: [],
        files: [],
      });
      manager.registerTemplate({
        id: 't2',
        name: 'T2',
        description: 'T2',
        icon: '📄',
        category: 'react',
        variables: [],
        files: [],
      });

      const templates = manager.getAllTemplates();
      expect(templates).toHaveLength(2);
      expect(templates.map((t) => t.id)).toContain('t1');
      expect(templates.map((t) => t.id)).toContain('t2');
    });
  });

  describe('getTemplate', () => {
    it('should return undefined for unknown template', () => {
      expect(manager.getTemplate('nonexistent')).toBeUndefined();
    });

    it('should return template by id', () => {
      manager.registerTemplate({
        id: 'my-template',
        name: 'My Template',
        description: 'A template',
        icon: '📄',
        category: 'typescript',
        variables: [],
        files: [],
      });

      const template = manager.getTemplate('my-template');
      expect(template).toBeDefined();
      expect(template?.id).toBe('my-template');
    });
  });

  describe('generateFiles', () => {
    it('should throw error for unknown template', () => {
      expect(() => manager.generateFiles('unknown')).toThrow(
        'Template not found: unknown',
      );
    });

    it('should generate files with default variables', () => {
      manager.registerTemplate({
        id: 'simple',
        name: 'Simple',
        description: 'Simple template',
        icon: '📄',
        category: 'typescript',
        variables: [
          { name: 'name', default: 'MyComponent', description: 'Name' },
          { name: 'dir', default: 'src', description: 'Directory' },
        ],
        files: [
          {
            path: '{{dir}}/{{name}}.ts',
            content: 'export const {{name}} = {};',
            description: 'Main file',
          },
        ],
      });

      const files = manager.generateFiles('simple');

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('src/MyComponent.ts');
      expect(files[0].content).toBe('export const MyComponent = {};');
    });

    it('should generate files with custom variables', () => {
      manager.registerTemplate({
        id: 'simple',
        name: 'Simple',
        description: 'Simple template',
        icon: '📄',
        category: 'typescript',
        variables: [{ name: 'name', default: 'Default', description: 'Name' }],
        files: [
          {
            path: '{{name}}.ts',
            content: 'export const {{name}} = {};',
            description: 'Main file',
          },
        ],
      });

      const files = manager.generateFiles('simple', { name: 'CustomName' });

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('CustomName.ts');
      expect(files[0].content).toBe('export const CustomName = {};');
    });

    it('should preserve unknown variables as-is', () => {
      manager.registerTemplate({
        id: 'simple',
        name: 'Simple',
        description: 'Simple template',
        icon: '📄',
        category: 'typescript',
        variables: [],
        files: [
          {
            path: 'file.ts',
            content: 'const x = {{unknown}};',
            description: 'Main file',
          },
        ],
      });

      const files = manager.generateFiles('simple');

      expect(files[0].content).toBe('const x = {{unknown}};');
    });

    it('should generate multiple files', () => {
      manager.registerTemplate({
        id: 'multi',
        name: 'Multi',
        description: 'Multi-file template',
        icon: '📄',
        category: 'react',
        variables: [{ name: 'name', default: 'Comp', description: 'Name' }],
        files: [
          {
            path: '{{name}}.tsx',
            content: 'export const {{name}} = () => null;',
            description: 'Component',
          },
          {
            path: '{{name}}.test.tsx',
            content: 'describe("{{name}}", () => {});',
            description: 'Test',
          },
        ],
      });

      const files = manager.generateFiles('multi');

      expect(files).toHaveLength(2);
      expect(files[0].path).toBe('Comp.tsx');
      expect(files[1].path).toBe('Comp.test.tsx');
    });
  });

  describe('addBuiltInTemplates', () => {
    it('should register all built-in templates', () => {
      manager.addBuiltInTemplates();

      const templates = manager.getAllTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(6);

      const ids = templates.map((t) => t.id);
      expect(ids).toContain('react-component');
      expect(ids).toContain('api-endpoint');
      expect(ids).toContain('cli-command');
      expect(ids).toContain('test-suite');
      expect(ids).toContain('docker-service');
      expect(ids).toContain('github-action');
    });

    it('should generate react-component files', () => {
      manager.addBuiltInTemplates();

      const files = manager.generateFiles('react-component', {
        name: 'Button',
        dir: 'src/components',
      });

      expect(files.length).toBeGreaterThanOrEqual(4);
      expect(files.some((f) => f.path.includes('Button.tsx'))).toBe(true);
      expect(files.some((f) => f.path.includes('Button.module.css'))).toBe(
        true,
      );
      expect(files.some((f) => f.path.includes('Button.test.tsx'))).toBe(true);
      expect(files.some((f) => f.path.includes('index.ts'))).toBe(true);
    });

    it('should generate api-endpoint files', () => {
      manager.addBuiltInTemplates();

      const files = manager.generateFiles('api-endpoint', {
        name: 'users',
        dir: 'src/api',
      });

      expect(files.length).toBeGreaterThanOrEqual(5);
      expect(files.some((f) => f.path.includes('users.route.ts'))).toBe(true);
      expect(files.some((f) => f.path.includes('users.controller.ts'))).toBe(
        true,
      );
      expect(files.some((f) => f.path.includes('users.service.ts'))).toBe(true);
      expect(files.some((f) => f.path.includes('users.test.ts'))).toBe(true);
    });

    it('should generate docker-service files', () => {
      manager.addBuiltInTemplates();

      const files = manager.generateFiles('docker-service', {
        name: 'api',
        port: '8080',
        dir: '.',
      });

      expect(files).toHaveLength(2);
      expect(files.some((f) => f.path.includes('Dockerfile.api'))).toBe(true);
      expect(files.some((f) => f.path.includes('docker-compose.api.yml'))).toBe(
        true,
      );
      expect(files.some((f) => f.content.includes('8080'))).toBe(true);
    });

    it('should generate github-action files', () => {
      manager.addBuiltInTemplates();

      const files = manager.generateFiles('github-action', {
        name: 'ci',
        dir: '.github/workflows',
      });

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('.github/workflows/ci.yml');
      expect(files[0].content).toContain('name: ci');
    });
  });
});

describe('Case conversion utilities', () => {
  describe('toPascalCase', () => {
    it('should convert kebab-case to PascalCase', () => {
      expect(toPascalCase('my-component')).toBe('MyComponent');
    });

    it('should convert snake_case to PascalCase', () => {
      expect(toPascalCase('my_component')).toBe('MyComponent');
    });

    it('should handle single word', () => {
      expect(toPascalCase('button')).toBe('Button');
    });

    it('should handle already PascalCase', () => {
      expect(toPascalCase('MyComponent')).toBe('MyComponent');
    });
  });

  describe('toCamelCase', () => {
    it('should convert kebab-case to camelCase', () => {
      expect(toCamelCase('my-component')).toBe('myComponent');
    });

    it('should convert snake_case to camelCase', () => {
      expect(toCamelCase('my_component')).toBe('myComponent');
    });

    it('should handle single word', () => {
      expect(toCamelCase('button')).toBe('button');
    });
  });

  describe('toConstantCase', () => {
    it('should convert kebab-case to CONSTANT_CASE', () => {
      expect(toConstantCase('my-constant')).toBe('MY_CONSTANT');
    });

    it('should convert snake_case to CONSTANT_CASE', () => {
      expect(toConstantCase('my_constant')).toBe('MY_CONSTANT');
    });

    it('should handle spaces', () => {
      expect(toConstantCase('my constant')).toBe('MY_CONSTANT');
    });
  });
});
