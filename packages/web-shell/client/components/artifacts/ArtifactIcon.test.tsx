// @vitest-environment jsdom
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WebShellCustomizationProvider } from '../../customization';
import { ArtifactIcon } from './ArtifactIcon';

describe('ArtifactIcon', () => {
  it('lets the host replace the image with the complete artifact record', () => {
    const artifact = {
      id: 'artifact-1',
      kind: 'html',
      title: 'Report',
      workspacePath: 'report.html',
      metadata: { audience: 'reviewer' },
    } as DaemonSessionArtifact;
    const renderImage = vi.fn(() => <span data-custom-image="report" />);

    const html = renderToStaticMarkup(
      <WebShellCustomizationProvider value={{ artifact: { renderImage } }}>
        <ArtifactIcon artifact={artifact} />
      </WebShellCustomizationProvider>,
    );

    expect(renderImage).toHaveBeenCalledWith(artifact);
    expect(html).toContain('data-custom-image="report"');
    expect(html).not.toContain('data-artifact-icon');
  });

  it.each([
    ['audio', 'lucide-file-headphone'],
    ['document', 'lucide-file-text'],
    ['notebook', 'lucide-notebook-tabs'],
  ])('keeps the legacy %s icon when no SVG matches', (kind, className) => {
    const html = renderToStaticMarkup(
      <ArtifactIcon
        artifact={{ kind, title: 'Untitled' } as DaemonSessionArtifact}
      />,
    );

    expect(html).toContain(className);
    expect(html).toContain(`data-artifact-icon="${kind}"`);
  });

  it('uses file.svg when neither SVG nor legacy icon matches', () => {
    const html = renderToStaticMarkup(
      <ArtifactIcon
        artifact={{ kind: 'other', title: 'Untitled' } as DaemonSessionArtifact}
      />,
    );

    expect(html).toContain('data-artifact-icon="file"');
  });
});
