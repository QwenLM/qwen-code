import { resolve } from 'node:path';
import { normalizePath, type Plugin } from 'vite';

export function pierreResources(): Plugin {
  return {
    name: 'web-shell-pierre-resources',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !normalizePath(importer).includes('/@pierre/diffs/'))
        return undefined;
      if (source === 'shiki')
        return resolve(
          __dirname,
          'client/components/artifacts/pierre-highlighter.ts',
        );
      if (
        source === '@pierre/theming/themes' &&
        /\/(?:shared_highlighter|themeResolution)\.js(?:[?#].*)?$/.test(
          normalizePath(importer),
        )
      )
        return resolve(
          __dirname,
          'client/components/artifacts/pierre-themes.ts',
        );
      return undefined;
    },
    generateBundle(_options, bundle) {
      const resources = new Set<string>();
      const visit = (id: string) => {
        if (resources.has(id)) return;
        resources.add(id);
        const module = this.getModuleInfo(id);
        for (const dependency of [
          ...(module?.importedIds ?? []),
          ...(module?.dynamicallyImportedIds ?? []),
        ])
          visit(dependency);
      };
      for (const id of this.getModuleIds()) {
        if (/\/pierre-(?:highlighter|themes)\.ts$/.test(normalizePath(id)))
          visit(id);
      }
      // Shared chunks can also contain unrelated application code.
      const bytes = Object.values(bundle).reduce((size, item) => {
        if (item.type !== 'chunk') return size;
        return (
          size +
          Object.entries(item.modules).reduce(
            (total, [id, module]) =>
              total + (resources.has(id) ? module.renderedLength : 0),
            0,
          )
        );
      }, 0);
      if (bytes > 4 * 1024 * 1024)
        this.error(
          `Pierre highlighter exceeds the 4 MiB budget: ${bytes} bytes`,
        );
      this.info(
        `Pierre highlighter resources: ${bytes} rendered module bytes (4 MiB budget)`,
      );
    },
  };
}
