import { DIFFS_TAG_NAME, VirtualizedFile, Virtualizer } from '@pierre/diffs';
import { useEffect, useRef } from 'react';
import { useTheme } from '../../themeContext';

export default function PierreFilePreview({
  path,
  content,
}: {
  path: string;
  content: string;
}) {
  const theme = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<VirtualizedFile | undefined>(undefined);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const contentContainer = document.createElement('div');
    const fileContainer = document.createElement(DIFFS_TAG_NAME);
    // Pierre anchors zero-height files at their bottom during async highlighting.
    fileContainer.style.display = 'block';
    fileContainer.style.minHeight = '1px';
    contentContainer.appendChild(fileContainer);
    host.replaceChildren(contentContainer);
    const virtualizer = new Virtualizer();
    virtualizer.setup(host, contentContainer);
    const view = new VirtualizedFile(
      {
        theme: { light: 'github-light', dark: 'github-dark' },
        preferredHighlighter: 'shiki-js',
        overflow: 'wrap',
        disableFileHeader: true,
        enableLineSelection: true,
        tokenizeMaxLength: 10_000,
      },
      virtualizer,
    );
    viewRef.current = view;
    view.render({
      file: {
        name: path,
        contents: content,
        lang: content.length > 1024 * 1024 ? 'text' : undefined,
      },
      fileContainer,
    });
    return () => {
      viewRef.current = undefined;
      view.cleanUp();
      virtualizer.cleanUp();
      host.replaceChildren();
    };
  }, [path, content]);
  useEffect(() => {
    viewRef.current?.setThemeType(theme);
  }, [theme, path, content]);
  return (
    <div
      ref={hostRef}
      className="h-full overflow-auto"
      data-testid="pierre-file-preview"
    />
  );
}
