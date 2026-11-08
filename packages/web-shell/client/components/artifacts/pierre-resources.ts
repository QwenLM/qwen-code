// Explicit imports keep unused Shiki grammars and themes out of both builds.
/** @internal */
export const bundledLanguages = {
  c: () => import('shiki-files/langs/c.mjs'),
  cpp: () => import('shiki-files/langs/cpp.mjs'),
  csharp: () => import('shiki-files/langs/csharp.mjs'),
  css: () => import('shiki-files/langs/css.mjs'),
  diff: () => import('shiki-files/langs/diff.mjs'),
  dockerfile: () => import('shiki-files/langs/dockerfile.mjs'),
  go: () => import('shiki-files/langs/go.mjs'),
  html: () => import('shiki-files/langs/html.mjs'),
  ini: () => import('shiki-files/langs/ini.mjs'),
  java: () => import('shiki-files/langs/java.mjs'),
  javascript: () => import('shiki-files/langs/javascript.mjs'),
  json: () => import('shiki-files/langs/json.mjs'),
  jsonc: () => import('shiki-files/langs/jsonc.mjs'),
  jsx: () => import('shiki-files/langs/jsx.mjs'),
  kotlin: () => import('shiki-files/langs/kotlin.mjs'),
  lua: () => import('shiki-files/langs/lua.mjs'),
  makefile: () => import('shiki-files/langs/makefile.mjs'),
  markdown: () => import('shiki-files/langs/markdown.mjs'),
  'objective-cpp': () => import('shiki-files/langs/objective-cpp.mjs'),
  php: () => import('shiki-files/langs/php.mjs'),
  python: () => import('shiki-files/langs/python.mjs'),
  ruby: () => import('shiki-files/langs/ruby.mjs'),
  rust: () => import('shiki-files/langs/rust.mjs'),
  shellscript: () => import('shiki-files/langs/shellscript.mjs'),
  sql: () => import('shiki-files/langs/sql.mjs'),
  swift: () => import('shiki-files/langs/swift.mjs'),
  toml: () => import('shiki-files/langs/toml.mjs'),
  tsx: () => import('shiki-files/langs/tsx.mjs'),
  typescript: () => import('shiki-files/langs/typescript.mjs'),
  vue: () => import('shiki-files/langs/vue.mjs'),
  xml: () => import('shiki-files/langs/xml.mjs'),
  yaml: () => import('shiki-files/langs/yaml.mjs'),
  zsh: () => import('shiki-files/langs/shellscript.mjs'),
};

/** @internal */
export const bundledThemes = {
  'github-light': () => import('shiki-files/themes/github-light.mjs'),
  'github-dark': () => import('shiki-files/themes/github-dark.mjs'),
};
