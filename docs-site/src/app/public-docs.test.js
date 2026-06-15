import { describe, expect, it } from 'vitest';

import { filterPublicStaticParams, isPublicDocsPath } from './public-docs.js';

describe('isPublicDocsPath', () => {
  it.each([
    [[], true],
    [[''], true],
    [['users', 'foo'], true],
    [['design', 'bar'], false],
    [['en', 'users'], true],
    [['plans'], false],
    [['en'], true],
  ])('returns %s for %j', (mdxPath, expected) => {
    expect(isPublicDocsPath(mdxPath)).toBe(expected);
  });
});

describe('filterPublicStaticParams', () => {
  it('keeps public paths and rejects internal docs paths', () => {
    expect(
      filterPublicStaticParams([
        { mdxPath: [] },
        { mdxPath: [''] },
        { mdxPath: ['users', 'foo'] },
        { mdxPath: ['en', 'developers'] },
        { mdxPath: ['design', 'bar'] },
        { mdxPath: ['plans'] },
      ]),
    ).toEqual([
      { mdxPath: [] },
      { mdxPath: [''] },
      { mdxPath: ['users', 'foo'] },
      { mdxPath: ['en', 'developers'] },
    ]);
  });

  it('fails closed if Nextra changes the static params shape', () => {
    expect(() => filterPublicStaticParams([{ slug: ['users'] }])).toThrow(
      'Expected generateStaticParamsFor("mdxPath") to return objects with an mdxPath array.',
    );
  });
});
