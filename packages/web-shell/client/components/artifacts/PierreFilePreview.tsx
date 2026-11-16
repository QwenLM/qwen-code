import { bundledLanguages } from './pierre-resources';
import {
  DIFFS_TAG_NAME,
  getFiletypeFromFileName,
  VirtualizedFile,
  Virtualizer,
} from '@pierre/diffs';
import { useEffect, useRef } from 'react';
import { useTheme } from '../../themeContext';

/** @internal */
export function getPreviewLanguage(
  path: string,
): keyof typeof bundledLanguages | 'text' {
  // Fold case on the extension only: a whole-path toLowerCase() would break
  // the detector's uppercase-only whole-name keys (Gemfile, BUILD, ...).
  const detected = getFiletypeFromFileName(
    path.replace(/\.([^./\\]+)$/, (dot) => dot.toLowerCase()),
  );
  const language =
    detected === 'yml' ? 'yaml' : detected === 'kts' ? 'kotlin' : detected;
  return Object.hasOwn(bundledLanguages, language)
    ? (language as keyof typeof bundledLanguages)
    : 'text';
}

export default function PierreFilePreview({
  path,
  content,
}: {
  path: string;
  content: string;
}) {
  const theme = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const appliedThemeRef = useRef(theme);
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
    let view: VirtualizedFile | undefined;
    const cleanUp = () => {
      viewRef.current = undefined;
      view?.cleanUp();
      virtualizer.cleanUp();
      host.replaceChildren();
    };
    try {
      virtualizer.setup(host, contentContainer);
      view = new VirtualizedFile(
        {
          theme: { light: 'github-light', dark: 'github-dark' },
          themeType: themeRef.current,
          disableErrorHandling: true,
          preferredHighlighter: 'shiki-js',
          overflow: 'wrap',
          disableFileHeader: true,
          enableLineSelection: true,
          tokenizeMaxLength: 10_000,
        },
        virtualizer,
      );
      viewRef.current = view;
      appliedThemeRef.current = themeRef.current;
      view.render({
        file: {
          name: path,
          contents: content,
          lang:
            content.length > 1024 * 1024 ? 'text' : getPreviewLanguage(path),
        },
        fileContainer,
      });
    } catch (error) {
      cleanUp();
      throw error;
    }
    return cleanUp;
  }, [path, content]);
  useEffect(() => {
    if (appliedThemeRef.current !== theme) {
      viewRef.current?.setThemeType(theme);
      appliedThemeRef.current = theme;
    }
  }, [theme, path, content]);
  return (
    <div
      ref={hostRef}
      className="h-full overflow-auto"
      data-testid="pierre-file-preview"
    />
  );
}
