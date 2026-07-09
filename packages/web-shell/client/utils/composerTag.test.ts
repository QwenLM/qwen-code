import { describe, expect, it } from 'vitest';
import {
  getComposerTagIconUrl,
  getComposerTagViewModel,
  splitComposerTagContent,
} from './composerTag';

describe('composer tag icon URLs', () => {
  it('uses registered icons for custom tag kinds', () => {
    expect(getComposerTagIconUrl('table', { table: '/icons/table.svg' })).toBe(
      '/icons/table.svg',
    );
  });

  it('falls back to built-in tag icons', () => {
    expect(getComposerTagIconUrl('file')).toBeTruthy();
  });

  it('ignores inherited object properties', () => {
    const icons = Object.create({ table: '/icons/table.svg' }) as Record<
      string,
      string
    >;

    expect(getComposerTagIconUrl('table', icons)).toBeUndefined();
    expect(getComposerTagIconUrl('toString')).toBeUndefined();
  });
});

describe('splitComposerTagContent', () => {
  it('returns text for empty content and bare @', () => {
    expect(splitComposerTagContent('')).toEqual([{ type: 'text', text: '' }]);
    expect(splitComposerTagContent('@')).toEqual([{ type: 'text', text: '@' }]);
    expect(splitComposerTagContent('hello @ world')).toEqual([
      { type: 'text', text: 'hello @ world' },
    ]);
    expect(splitComposerTagContent('end @')).toEqual([
      { type: 'text', text: 'end @' },
    ]);
  });

  it('splits file references into text and reference segments', () => {
    expect(splitComposerTagContent('list @.qwen/ files')).toEqual([
      { type: 'text', text: 'list ' },
      {
        type: 'reference',
        tag: {
          id: 'file:@.qwen/',
          kind: 'file',
          value: '.qwen/',
          serialized: '@.qwen/',
        },
      },
      { type: 'text', text: ' files' },
    ]);
  });

  it('keeps adjacent non-boundary references as text', () => {
    expect(splitComposerTagContent('@.qwen/@src/index.ts')).toEqual([
      {
        type: 'reference',
        tag: {
          id: 'file:@.qwen/',
          kind: 'file',
          value: '.qwen/',
          serialized: '@.qwen/',
        },
      },
      { type: 'text', text: '@src/index.ts' },
    ]);
  });

  it('creates extension and MCP reference tags', () => {
    expect(splitComposerTagContent('@ext:browser and @mcp:docs')).toEqual([
      {
        type: 'reference',
        tag: {
          id: 'extension:@ext:browser',
          kind: 'extension',
          value: 'browser',
          serialized: '@ext:browser',
        },
      },
      { type: 'text', text: ' and ' },
      {
        type: 'reference',
        tag: {
          id: 'mcp:@mcp:docs',
          kind: 'mcp',
          value: 'docs',
          serialized: '@mcp:docs',
        },
      },
    ]);
  });

  it('creates MCP resource tags from escaped server resource references', () => {
    expect(splitComposerTagContent('open @docs\\:res\\://doc')).toEqual([
      { type: 'text', text: 'open ' },
      {
        type: 'reference',
        tag: {
          id: 'mcp:@docs\\:res\\://doc',
          kind: 'mcp',
          value: 'docs:res://doc',
          serialized: '@docs\\:res\\://doc',
        },
      },
    ]);
  });

  it('does not split inline email-like text', () => {
    expect(splitComposerTagContent('mail a@b.test')).toEqual([
      { type: 'text', text: 'mail a@b.test' },
    ]);
  });

  it('keeps package and handle-like references as text', () => {
    expect(
      splitComposerTagContent('install @types/node and ask @alice'),
    ).toEqual([{ type: 'text', text: 'install @types/node and ask @alice' }]);
  });

  it('does not split references after non-boundary characters', () => {
    expect(splitComposerTagContent('prefix/@.qwen/')).toEqual([
      { type: 'text', text: 'prefix/@.qwen/' },
    ]);
  });

  it('keeps custom provider-prefixed references as text', () => {
    expect(splitComposerTagContent('open @dataset:users')).toEqual([
      { type: 'text', text: 'open @dataset:users' },
    ]);
  });

  it('keeps short Windows drive references as file tags', () => {
    expect(splitComposerTagContent('open @C:file')).toEqual([
      { type: 'text', text: 'open ' },
      {
        type: 'reference',
        tag: {
          id: 'file:@C:file',
          kind: 'file',
          value: 'C:file',
          serialized: '@C:file',
        },
      },
    ]);
  });

  it('keeps Windows drive references as file tags', () => {
    expect(splitComposerTagContent('open @C:/Users/name/file.ts')).toEqual([
      { type: 'text', text: 'open ' },
      {
        type: 'reference',
        tag: {
          id: 'file:@C:/Users/name/file.ts',
          kind: 'file',
          value: 'C:/Users/name/file.ts',
          serialized: '@C:/Users/name/file.ts',
        },
      },
    ]);
  });

  it('unescapes reference display text', () => {
    expect(
      splitComposerTagContent('open @path/file\\ with\\ spaces.txt'),
    ).toEqual([
      { type: 'text', text: 'open ' },
      {
        type: 'reference',
        tag: {
          id: 'file:@path/file\\ with\\ spaces.txt',
          kind: 'file',
          value: 'path/file with spaces.txt',
          serialized: '@path/file\\ with\\ spaces.txt',
        },
      },
    ]);
  });

  it('advances over escaped emoji code points', () => {
    expect(splitComposerTagContent('open @path/\\😀.txt')).toEqual([
      { type: 'text', text: 'open ' },
      {
        type: 'reference',
        tag: {
          id: 'file:@path/\\😀.txt',
          kind: 'file',
          value: 'path/😀.txt',
          serialized: '@path/\\😀.txt',
        },
      },
    ]);
  });

  it('leaves trailing sentence punctuation outside chips', () => {
    expect(splitComposerTagContent('See @file.ts.')).toEqual([
      { type: 'text', text: 'See ' },
      {
        type: 'reference',
        tag: {
          id: 'file:@file.ts',
          kind: 'file',
          value: 'file.ts',
          serialized: '@file.ts',
        },
      },
      { type: 'text', text: '.' },
    ]);
  });
});

describe('getComposerTagViewModel', () => {
  it('returns display fields for custom tags', () => {
    expect(
      getComposerTagViewModel({
        id: 'custom:1',
        label: '  Dataset  ',
        value: '  users.csv  ',
      }),
    ).toEqual({
      tagLabel: 'Dataset',
      tagValue: 'users.csv',
      fallback: 'custom:1',
      iconUrl: undefined,
    });
  });

  it('hides labels for built-in tag kinds and resolves icons', () => {
    const model = getComposerTagViewModel({
      id: 'file:@.qwen/',
      kind: 'file',
      label: 'File',
      value: '.qwen/',
    });

    expect(model.tagLabel).toBe('');
    expect(model.tagValue).toBe('.qwen/');
    expect(model.fallback).toBe('file:@.qwen/');
    expect(model.iconUrl).toBeTruthy();
  });

  it('uses custom icon maps when provided', () => {
    expect(
      getComposerTagViewModel(
        {
          id: 'file:@src/index.ts',
          kind: 'file',
          value: 'src/index.ts',
        },
        { file: '/custom-file.svg' },
      ).iconUrl,
    ).toBe('/custom-file.svg');
  });

  it('uses fallback when tag has no display text', () => {
    expect(getComposerTagViewModel({ id: 'tag-id' })).toEqual({
      tagLabel: '',
      tagValue: '',
      fallback: 'tag-id',
      iconUrl: undefined,
    });
  });

  it('keeps labels for custom tag kinds', () => {
    expect(
      getComposerTagViewModel({
        id: 'dataset:users',
        kind: 'dataset',
        label: 'Dataset',
        value: 'users',
      }),
    ).toEqual({
      tagLabel: 'Dataset',
      tagValue: 'users',
      fallback: 'dataset:users',
      iconUrl: undefined,
    });
  });
});
