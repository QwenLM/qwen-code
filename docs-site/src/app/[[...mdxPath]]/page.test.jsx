import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const generateAllStaticParams = vi.fn();

  return {
    generateAllStaticParams,
    generateStaticParamsFor: vi.fn(() => generateAllStaticParams),
  };
});

vi.mock('nextra/pages', () => ({
  generateStaticParamsFor: mocks.generateStaticParamsFor,
  importPage: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
}));

vi.mock('../../../mdx-components', () => ({
  useMDXComponents: () => ({
    wrapper: ({ children }) => children,
  }),
}));

describe('generateStaticParams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters internal docs from Nextra static params', async () => {
    mocks.generateAllStaticParams.mockResolvedValue([
      { mdxPath: [] },
      { mdxPath: ['users', 'foo'] },
      { mdxPath: ['en', 'users'] },
      { mdxPath: ['design', 'bar'] },
      { mdxPath: ['plans'] },
    ]);

    const { generateStaticParams } = await import('./page.jsx');

    await expect(generateStaticParams()).resolves.toEqual([
      { mdxPath: [] },
      { mdxPath: ['users', 'foo'] },
      { mdxPath: ['en', 'users'] },
    ]);
  });

  it('fails closed if Nextra changes the static params shape', async () => {
    mocks.generateAllStaticParams.mockResolvedValue([{ slug: ['users'] }]);

    const { generateStaticParams } = await import('./page.jsx');

    await expect(generateStaticParams()).rejects.toThrow(
      'Expected generateStaticParamsFor("mdxPath") to return objects with an mdxPath array.',
    );
  });
});
