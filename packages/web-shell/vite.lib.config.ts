import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import pkg from './package.json' with { type: 'json' };

const COMPONENT_SCOPE =
  ':where([data-web-shell-root][data-web-shell-shadcn], [data-web-shell-portal-root][data-web-shell-shadcn], [data-web-shell-root][data-web-shell-shadcn] *, [data-web-shell-portal-root][data-web-shell-shadcn] *)';
const COMPONENT_ROOT_SCOPE =
  ':is([data-web-shell-root]:where([data-web-shell-shadcn]), [data-web-shell-portal-root]:where([data-web-shell-shadcn]))';

function scopeComponentCss(css: string): string {
  const root = postcss.parse(css);
  const scopeNode = selectorParser().astSync(COMPONENT_SCOPE).first.first;
  if (!scopeNode) throw new Error('Invalid WebShell component CSS scope');
  const keyframeNames = new Map<string, string>();
  const propertyNames = new Map<string, string>();

  root.walkAtRules((atRule) => {
    const name = atRule.name.toLowerCase();
    if (name.endsWith('keyframes')) {
      const original = atRule.params.trim();
      const scoped = `qwen-web-shell-${original}`;
      keyframeNames.set(original, scoped);
      atRule.params = scoped;
    } else if (name === 'property' && atRule.params.startsWith('--')) {
      const original = atRule.params.trim();
      const scoped = `--qwen-web-shell-${original.slice(2)}`;
      propertyNames.set(original, scoped);
      atRule.params = scoped;
    }
  });
  const sortedPropertyNames = [...propertyNames].sort(
    ([left], [right]) => right.length - left.length,
  );

  root.walkDecls((declaration) => {
    const scopedProperty = propertyNames.get(declaration.prop);
    if (scopedProperty) declaration.prop = scopedProperty;
    for (const [original, scoped] of sortedPropertyNames) {
      declaration.value = declaration.value.replaceAll(original, scoped);
    }
    for (const [original, scoped] of keyframeNames) {
      declaration.value = declaration.value.replace(
        new RegExp(`(?<![\\w-])${escapeRegExp(original)}(?![\\w-])`, 'g'),
        scoped,
      );
    }
  });
  root.walkRules((rule) => {
    let parent = rule.parent;
    while (parent) {
      if (
        parent.type === 'atrule' &&
        parent.name.toLowerCase().endsWith('keyframes')
      ) {
        return;
      }
      parent = parent.parent;
    }
    if (
      rule.selectors.every(
        (selector) => selector === ':root' || selector === ':host',
      )
    ) {
      rule.selector = COMPONENT_ROOT_SCOPE;
      return;
    }
    rule.selector = selectorParser((selectors) => {
      selectors.each((selector) => {
        const first = selector.first;
        if (first?.type === 'tag' || first?.type === 'universal') {
          selector.insertAfter(first, scopeNode.clone());
        } else {
          selector.prepend(scopeNode.clone());
        }
      });
    }).processSync(rule.selector);
  });
  return root.toString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function injectCssModules(): Plugin {
  return {
    name: 'inject-web-shell-css-modules',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const css = Object.entries(bundle)
        .filter(
          ([, item]) => item.type === 'asset' && item.fileName.endsWith('.css'),
        )
        .map(([fileName, item]) => {
          delete bundle[fileName];
          const source =
            typeof item.source === 'string'
              ? item.source
              : Buffer.from(item.source).toString('utf8');
          return scopeComponentCss(source);
        })
        .join('\n');
      if (!css) return;
      const escapedCss = JSON.stringify(css);
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        if (
          !item.isEntry &&
          !item.facadeModuleId?.endsWith('/client/index.tsx')
        ) {
          continue;
        }
        item.code =
          `const __qwenWebShellCss=${escapedCss};\n` +
          `if(typeof document!=="undefined"&&!document.querySelector('style[data-qwen-web-shell="component"]')){` +
          `const s=document.createElement("style");s.dataset.qwenWebShell="component";s.textContent=__qwenWebShellCss;try{document.head.appendChild(s);}catch(e){console.warn("[qwen-web-shell] CSS injection blocked by CSP:",e);}}\n` +
          item.code;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), injectCssModules()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './client'),
    },
  },
  esbuild: {
    jsxDev: false,
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'client/index.tsx',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
        'react-dom/client',
        'radix-ui',
        'lucide-react',
        'class-variance-authority',
        'clsx',
        'tailwind-merge',
        '@qwen-code/sdk',
        /^@qwen-code\/sdk\//,
        '@qwen-code/webui',
        /^@qwen-code\/webui\//,
        'react-markdown',
        'remark-gfm',
        'remark-math',
        'rehype-katex',
        'shiki',
        'mermaid',
        'katex',
        /^katex\//,
        'codemirror',
        /^@codemirror\//,
      ],
    },
  },
  define: {
    __WEB_SHELL_VERSION__: JSON.stringify(pkg.version),
  },
});
