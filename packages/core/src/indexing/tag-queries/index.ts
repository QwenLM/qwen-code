import { TREE_SITTER_JAVASCRIPT_TAGS } from './tree-sitter-javascript-tags.js';
import { TREE_SITTER_TYPESCRIPT_TAGS } from './tree-sitter-typescript-tags.js';
import { TREE_SITTER_JSX_TAGS } from './tree-sitter-jsx-tags.js';
import { TREE_SITTER_TSX_TAGS } from './tree-sitter-tsx-tags.js';
import { TREE_SITTER_PYTHON_TAGS } from './tree-sitter-python-tags.js';
import { TREE_SITTER_JAVA_TAGS } from './tree-sitter-java-tags.js';
import { TREE_SITTER_GO_TAGS } from './tree-sitter-go-tags.js';
import { TREE_SITTER_RUST_TAGS } from './tree-sitter-rust-tags.js';
import { TREE_SITTER_RUBY_TAGS } from './tree-sitter-ruby-tags.js';
import { TREE_SITTER_CPP_TAGS } from './tree-sitter-cpp-tags.js';
import { TREE_SITTER_C_TAGS } from './tree-sitter-c-tags.js';
import { TREE_SITTER_CSHARP_TAGS } from './tree-sitter-csharp-tags.js';
import { TREE_SITTER_PHP_TAGS } from './tree-sitter-php-tags.js';

export const TAG_QUERIES: Record<string, string> = {
  javascript: TREE_SITTER_JAVASCRIPT_TAGS,
  typescript: TREE_SITTER_TYPESCRIPT_TAGS,
  jsx: TREE_SITTER_JSX_TAGS,
  tsx: TREE_SITTER_TSX_TAGS,
  python: TREE_SITTER_PYTHON_TAGS,
  java: TREE_SITTER_JAVA_TAGS,
  go: TREE_SITTER_GO_TAGS,
  rust: TREE_SITTER_RUST_TAGS,
  ruby: TREE_SITTER_RUBY_TAGS,
  cpp: TREE_SITTER_CPP_TAGS,
  c: TREE_SITTER_C_TAGS,
  csharp: TREE_SITTER_CSHARP_TAGS,
  php: TREE_SITTER_PHP_TAGS,
};
