import { describe, expect, it } from 'vitest';
import {
  createInputAnnotationsFromComposerTags,
  getComposerTagIconUrl,
  getComposerTagViewModel,
  isBuiltinComposerTagIconUrl,
  splitComposerTagContentByAnnotations,
} from './composerTag';

function referenceAnnotation(
  content: string,
  text: string,
  reference: {
    id: string;
    kind?: string;
    label?: string;
    value?: string;
    serialized?: string;
    removable?: boolean;
  },
) {
  const start = content.indexOf(text);
  if (start < 0) {
    throw new Error(`Missing annotation text: ${text}`);
  }
  return {
    type: 'reference' as const,
    start,
    end: start + text.length,
    text,
    reference,
  };
}

describe('composer tag icon URLs', () => {
  it('uses registered icons for custom tag kinds', () => {
    expect(getComposerTagIconUrl('table', { table: '/icons/table.svg' })).toBe(
      '/icons/table.svg',
    );
  });

  it('falls back to built-in tag icons', () => {
    expect(getComposerTagIconUrl('file')).toBeTruthy();
  });

  it('recognizes only exact built-in tag icon URLs', () => {
    for (const kind of ['extension', 'file', 'mcp', 'skill'] as const) {
      const iconUrl = getComposerTagIconUrl(kind);
      expect(iconUrl).toMatch(/^data:image\/svg\+xml/);
      expect(isBuiltinComposerTagIconUrl(iconUrl)).toBe(true);
    }
    expect(
      isBuiltinComposerTagIconUrl(
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" />',
      ),
    ).toBe(false);
    expect(isBuiltinComposerTagIconUrl('javascript:alert(1)')).toBe(false);
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

describe('composer tag input annotations', () => {
  it('creates reference annotations using ranges from final prompt text', () => {
    expect(
      createInputAnnotationsFromComposerTags('@dataset:users\n\nshow rows', [
        {
          id: 'dataset:users',
          kind: 'dataset',
          label: 'Dataset',
          value: 'users',
          serialized: '@dataset:users',
        },
      ]),
    ).toEqual([
      {
        type: 'reference',
        start: 0,
        end: 14,
        text: '@dataset:users',
        reference: {
          id: 'dataset:users',
          kind: 'dataset',
          label: 'Dataset',
          value: 'users',
          serialized: '@dataset:users',
        },
      },
    ]);
  });

  it('creates annotations for extensionless file references', () => {
    expect(
      createInputAnnotationsFromComposerTags(
        '@Makefile @LICENSE @src/Makefile',
        [
          {
            id: 'file:@Makefile',
            kind: 'file',
            value: 'Makefile',
            serialized: '@Makefile',
          },
          {
            id: 'file:@LICENSE',
            kind: 'file',
            value: 'LICENSE',
            serialized: '@LICENSE',
          },
          {
            id: 'file:@src/Makefile',
            kind: 'file',
            value: 'src/Makefile',
            serialized: '@src/Makefile',
          },
        ],
      ),
    ).toEqual([
      {
        type: 'reference',
        start: 0,
        end: 9,
        text: '@Makefile',
        reference: {
          id: 'file:@Makefile',
          kind: 'file',
          value: 'Makefile',
          serialized: '@Makefile',
        },
      },
      {
        type: 'reference',
        start: 10,
        end: 18,
        text: '@LICENSE',
        reference: {
          id: 'file:@LICENSE',
          kind: 'file',
          value: 'LICENSE',
          serialized: '@LICENSE',
        },
      },
      {
        type: 'reference',
        start: 19,
        end: 32,
        text: '@src/Makefile',
        reference: {
          id: 'file:@src/Makefile',
          kind: 'file',
          value: 'src/Makefile',
          serialized: '@src/Makefile',
        },
      },
    ]);
  });

  it('returns no annotations for empty tags', () => {
    expect(
      createInputAnnotationsFromComposerTags('show @Makefile', []),
    ).toEqual([]);
  });

  it('skips tags whose serialized text is absent from the prompt', () => {
    expect(
      createInputAnnotationsFromComposerTags('show @Makefile', [
        {
          id: 'file:@LICENSE',
          kind: 'file',
          value: 'LICENSE',
          serialized: '@LICENSE',
        },
        {
          id: 'file:@Makefile',
          kind: 'file',
          value: 'Makefile',
          serialized: '@Makefile',
        },
      ]),
    ).toEqual([
      {
        type: 'reference',
        start: 5,
        end: 14,
        text: '@Makefile',
        reference: {
          id: 'file:@Makefile',
          kind: 'file',
          value: 'Makefile',
          serialized: '@Makefile',
        },
      },
    ]);
  });

  it('matches repeated serialized references in order', () => {
    expect(
      createInputAnnotationsFromComposerTags('@file @file', [
        {
          id: 'file:first',
          kind: 'file',
          value: 'first',
          serialized: '@file',
        },
        {
          id: 'file:second',
          kind: 'file',
          value: 'second',
          serialized: '@file',
        },
      ]),
    ).toEqual([
      {
        type: 'reference',
        start: 0,
        end: 5,
        text: '@file',
        reference: {
          id: 'file:first',
          kind: 'file',
          value: 'first',
          serialized: '@file',
        },
      },
      {
        type: 'reference',
        start: 6,
        end: 11,
        text: '@file',
        reference: {
          id: 'file:second',
          kind: 'file',
          value: 'second',
          serialized: '@file',
        },
      },
    ]);
  });

  it('uses annotations for custom provider references', () => {
    expect(
      splitComposerTagContentByAnnotations('open @dataset:users now', [
        {
          type: 'reference',
          start: 5,
          end: 19,
          text: '@dataset:users',
          reference: {
            id: 'dataset:users',
            kind: 'dataset',
            label: 'Dataset',
            value: 'users',
            serialized: '@dataset:users',
          },
        },
      ]),
    ).toEqual([
      { type: 'text', text: 'open ' },
      {
        type: 'reference',
        tag: {
          id: 'dataset:users',
          kind: 'dataset',
          label: 'Dataset',
          value: 'users',
          serialized: '@dataset:users',
        },
      },
      { type: 'text', text: ' now' },
    ]);
  });

  it('uses annotations for extensionless file references', () => {
    const content = 'open @Makefile and @src/Makefile';

    expect(
      splitComposerTagContentByAnnotations(content, [
        referenceAnnotation(content, '@Makefile', {
          id: 'file:@Makefile',
          kind: 'file',
          value: 'Makefile',
          serialized: '@Makefile',
        }),
        referenceAnnotation(content, '@src/Makefile', {
          id: 'file:@src/Makefile',
          kind: 'file',
          value: 'src/Makefile',
          serialized: '@src/Makefile',
        }),
      ]),
    ).toEqual([
      { type: 'text', text: 'open ' },
      {
        type: 'reference',
        tag: {
          id: 'file:@Makefile',
          kind: 'file',
          value: 'Makefile',
          serialized: '@Makefile',
        },
      },
      { type: 'text', text: ' and ' },
      {
        type: 'reference',
        tag: {
          id: 'file:@src/Makefile',
          kind: 'file',
          value: 'src/Makefile',
          serialized: '@src/Makefile',
        },
      },
    ]);
  });

  it('keeps MCP resource trailing punctuation from annotations', () => {
    const serialized = '@docs\\:res\\://doc.';
    const content = `open ${serialized} now`;

    expect(
      splitComposerTagContentByAnnotations(content, [
        referenceAnnotation(content, serialized, {
          id: `mcp:${serialized}`,
          kind: 'mcp',
          value: 'docs:res://doc.',
          serialized,
        }),
      ]),
    ).toEqual([
      { type: 'text', text: 'open ' },
      {
        type: 'reference',
        tag: {
          id: 'mcp:@docs\\:res\\://doc.',
          kind: 'mcp',
          value: 'docs:res://doc.',
          serialized: '@docs\\:res\\://doc.',
        },
      },
      { type: 'text', text: ' now' },
    ]);
  });

  it('keeps escaped trailing punctuation from annotations', () => {
    const serialized = '@path\\:';
    const content = `open ${serialized}`;

    expect(
      splitComposerTagContentByAnnotations(content, [
        referenceAnnotation(content, serialized, {
          id: `file:${serialized}`,
          kind: 'file',
          value: 'path:',
          serialized,
        }),
      ]),
    ).toEqual([
      { type: 'text', text: 'open ' },
      {
        type: 'reference',
        tag: {
          id: 'file:@path\\:',
          kind: 'file',
          value: 'path:',
          serialized: '@path\\:',
        },
      },
    ]);
  });

  it('leaves unannotated references as text', () => {
    expect(splitComposerTagContentByAnnotations('list @.qwen/ files')).toEqual([
      { type: 'text', text: 'list @.qwen/ files' },
    ]);
  });

  it('leaves invalid annotation ranges as text', () => {
    expect(
      splitComposerTagContentByAnnotations('list @.qwen/ files', [
        {
          type: 'reference',
          start: 5,
          end: 12,
          text: '@wrong/',
          reference: {
            id: 'file:@wrong/',
            kind: 'file',
            value: 'wrong/',
            serialized: '@wrong/',
          },
        },
      ]),
    ).toEqual([{ type: 'text', text: 'list @.qwen/ files' }]);
  });

  it('leaves malformed reference annotations as text', () => {
    expect(
      splitComposerTagContentByAnnotations('list @.qwen/ files', [
        {
          type: 'reference',
          start: 5,
          end: 12,
          text: '@.qwen/',
        } as unknown as DaemonInputAnnotation,
      ]),
    ).toEqual([{ type: 'text', text: 'list @.qwen/ files' }]);
  });

  it('skips overlapping annotations', () => {
    expect(
      splitComposerTagContentByAnnotations('open @one @two', [
        {
          type: 'reference',
          start: 5,
          end: 9,
          text: '@one',
          reference: {
            id: 'file:@one',
            kind: 'file',
            value: 'one',
            serialized: '@one',
          },
        },
        {
          type: 'reference',
          start: 8,
          end: 13,
          text: 'e @tw',
          reference: {
            id: 'file:overlap',
            kind: 'file',
            value: 'overlap',
            serialized: 'e @tw',
          },
        },
      ]),
    ).toEqual([
      { type: 'text', text: 'open ' },
      {
        type: 'reference',
        tag: {
          id: 'file:@one',
          kind: 'file',
          value: 'one',
          serialized: '@one',
        },
      },
      { type: 'text', text: ' @two' },
    ]);
  });
});
