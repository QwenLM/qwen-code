// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileTypeIcon } from './FileTypeIcon';
import { ARTIFACT_ICON_URLS } from './artifacts/ArtifactIcon';

describe('FileTypeIcon', () => {
  it.each([
    ['report.HTML', 'html'],
    ['C#guide.pdf', 'pdf'],
    ['data?.csv', 'csv'],
    ['folder.with.dot/README', 'file'],
    ['report.pdf', 'pdf'],
    ['notes.md', 'md'],
    ['report.docx', 'word'],
    ['data.csv', 'csv'],
    ['data.xlsx', 'spreadsheet'],
    ['photo.svg', 'image'],
    ['movie.mp4', 'video'],
    ['unknown', 'file'],
  ] as const)('uses the artifact SVG for %s', (name, kind) => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <FileTypeIcon name={name} size={16} />,
    );
    expect(container.querySelector('image')?.getAttribute('href')).toBe(
      ARTIFACT_ICON_URLS[kind],
    );
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('16');
  });

  it('uses the artifact MIME fallback for files without extensions', () => {
    const html = renderToStaticMarkup(
      <FileTypeIcon name="report" mimeType="TEXT/HTML; charset=utf-8" />,
    );
    expect(html).toContain('data-file-type-icon="html"');
  });

  it.each([
    ['config.json', 'braces'],
    ['script.ts', 'file-code-corner'],
    ['archive.zip', 'file-archive'],
  ])('keeps the existing fallback for %s', (name, icon) => {
    expect(renderToStaticMarkup(<FileTypeIcon name={name} />)).toContain(
      `lucide-${icon}`,
    );
  });
});
