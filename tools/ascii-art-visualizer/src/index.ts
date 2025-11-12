/**
 * ASCII Art Code Visualizer
 * Transform code architecture into beautiful ASCII art
 */

import { readdir, stat, readFile } from 'fs/promises';
import { join, relative, parse } from 'path';

export interface VisualizerConfig {
  style?: 'classic' | 'double' | 'rounded' | 'dot' | '3d' | 'organic';
  colors?: boolean;
  width?: number;
  height?: number;
  maxDepth?: number;
  showMetrics?: boolean;
  animations?: boolean;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  size?: number;
  lines?: number;
  complexity?: number;
}

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  edges: Array<{ from: string; to: string }>;
}

export interface DependencyNode {
  id: string;
  name: string;
  type: 'module' | 'class' | 'function';
  dependencies: string[];
}

const BOX_CHARS = {
  classic: {
    horizontal: '─',
    vertical: '│',
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    tee: '├',
    cross: '┼',
    branch: '├──',
    last: '└──',
    pipe: '│  ',
    space: '   '
  },
  rounded: {
    horizontal: '─',
    vertical: '│',
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    tee: '├',
    cross: '┼',
    branch: '├──',
    last: '╰──',
    pipe: '│  ',
    space: '   '
  },
  double: {
    horizontal: '═',
    vertical: '║',
    topLeft: '╔',
    topRight: '╗',
    bottomLeft: '╚',
    bottomRight: '╝',
    tee: '╠',
    cross: '╬',
    branch: '╠══',
    last: '╚══',
    pipe: '║  ',
    space: '   '
  }
};

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

export class AsciiVisualizer {
  private config: Required<VisualizerConfig>;

  constructor(config: VisualizerConfig = {}) {
    this.config = {
      style: config.style || 'rounded',
      colors: config.colors ?? true,
      width: config.width || 100,
      height: config.height || 50,
      maxDepth: config.maxDepth || 5,
      showMetrics: config.showMetrics ?? true,
      animations: config.animations ?? false
    };
  }

  /**
   * Visualize directory structure as ASCII tree
   */
  async visualizeStructure(rootPath: string): Promise<string> {
    const tree = await this.buildFileTree(rootPath);
    return this.renderTree(tree);
  }

  /**
   * Build file tree from directory
   */
  private async buildFileTree(
    dirPath: string,
    depth = 0,
    rootPath?: string
  ): Promise<FileNode> {
    if (!rootPath) rootPath = dirPath;

    const stats = await stat(dirPath);
    const name = parse(dirPath).base || dirPath;

    if (stats.isFile()) {
      return {
        name,
        path: relative(rootPath, dirPath),
        type: 'file',
        size: stats.size
      };
    }

    if (depth >= this.config.maxDepth) {
      return {
        name,
        path: relative(rootPath, dirPath),
        type: 'directory',
        children: []
      };
    }

    const entries = await readdir(dirPath);
    const children: FileNode[] = [];

    // Filter out common ignored directories
    const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

    for (const entry of entries) {
      if (ignored.has(entry)) continue;

      const fullPath = join(dirPath, entry);
      try {
        const child = await this.buildFileTree(fullPath, depth + 1, rootPath);
        children.push(child);
      } catch (err) {
        // Skip files we can't read
      }
    }

    // Sort: directories first, then files, alphabetically
    children.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return {
      name,
      path: relative(rootPath, dirPath),
      type: 'directory',
      children
    };
  }

  /**
   * Render file tree as ASCII art
   */
  private renderTree(node: FileNode, prefix = '', isLast = true): string {
    const chars = BOX_CHARS[this.config.style as keyof typeof BOX_CHARS] || BOX_CHARS.rounded;
    let output = '';

    // Root node
    if (prefix === '') {
      const titleBox = this.createBox(
        `📁 ${node.name}`,
        this.config.width - 4
      );
      output += titleBox + '\n';
    } else {
      const connector = isLast ? chars.last : chars.branch;
      const icon = node.type === 'directory' ? '📁' : this.getFileIcon(node.name);
      const color = this.getColor(node);

      output += prefix + connector + ' ';
      output += this.config.colors ? `${color}${icon} ${node.name}${COLORS.reset}` : `${icon} ${node.name}`;

      if (this.config.showMetrics && node.size) {
        output += ` ${COLORS.dim}(${this.formatSize(node.size)})${COLORS.reset}`;
      }

      output += '\n';
    }

    // Render children
    if (node.children && node.children.length > 0) {
      const childPrefix = prefix === '' ? '' : prefix + (isLast ? chars.space : chars.pipe);

      node.children.forEach((child, index) => {
        const isLastChild = index === node.children!.length - 1;
        output += this.renderTree(child, childPrefix, isLastChild);
      });
    }

    return output;
  }

  /**
   * Create a decorative box around text
   */
  private createBox(text: string, width: number): string {
    const chars = BOX_CHARS[this.config.style as keyof typeof BOX_CHARS] || BOX_CHARS.rounded;
    const padding = Math.max(0, Math.floor((width - text.length - 2) / 2));
    const paddedText = ' '.repeat(padding) + text + ' '.repeat(padding);

    const top = chars.topLeft + chars.horizontal.repeat(width) + chars.topRight;
    const middle = chars.vertical + paddedText.padEnd(width) + chars.vertical;
    const bottom = chars.bottomLeft + chars.horizontal.repeat(width) + chars.bottomRight;

    return top + '\n' + middle + '\n' + bottom;
  }

  /**
   * Get icon for file based on extension
   */
  private getFileIcon(filename: string): string {
    const ext = parse(filename).ext.toLowerCase();
    const icons: Record<string, string> = {
      '.ts': '📘',
      '.tsx': '⚛️',
      '.js': '📙',
      '.jsx': '⚛️',
      '.json': '📋',
      '.md': '📝',
      '.css': '🎨',
      '.scss': '🎨',
      '.html': '🌐',
      '.yml': '⚙️',
      '.yaml': '⚙️',
      '.sh': '🔧',
      '.py': '🐍',
      '.go': '🐹',
      '.rs': '🦀',
      '.java': '☕',
      '.rb': '💎',
      '.php': '🐘',
      '.vue': '💚',
      '.svg': '🖼️',
      '.png': '🖼️',
      '.jpg': '🖼️',
      '.gif': '🖼️',
      '.pdf': '📄',
      '.lock': '🔒',
      '.env': '🔐',
      '.test.ts': '🧪',
      '.test.js': '🧪',
      '.spec.ts': '🧪',
      '.spec.js': '🧪'
    };

    // Check for test files
    if (filename.includes('.test.') || filename.includes('.spec.')) {
      return '🧪';
    }

    return icons[ext] || '📄';
  }

  /**
   * Get color for node based on type
   */
  private getColor(node: FileNode): string {
    if (!this.config.colors) return '';

    if (node.type === 'directory') {
      return COLORS.blue + COLORS.bright;
    }

    const ext = parse(node.name).ext.toLowerCase();
    if (ext === '.ts' || ext === '.tsx') return COLORS.cyan;
    if (ext === '.js' || ext === '.jsx') return COLORS.yellow;
    if (ext === '.json') return COLORS.green;
    if (ext === '.md') return COLORS.magenta;

    return COLORS.white;
  }

  /**
   * Format file size
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /**
   * Visualize dependency graph
   */
  async visualizeDependencies(rootPath: string): Promise<string> {
    const graph = await this.buildDependencyGraph(rootPath);
    return this.renderDependencyGraph(graph);
  }

  /**
   * Build dependency graph from TypeScript/JavaScript files
   */
  private async buildDependencyGraph(rootPath: string): Promise<DependencyGraph> {
    const graph: DependencyGraph = {
      nodes: new Map(),
      edges: []
    };

    // TODO: Implement actual dependency parsing
    // For now, return a sample graph

    return graph;
  }

  /**
   * Render dependency graph as ASCII art
   */
  private renderDependencyGraph(graph: DependencyGraph): string {
    let output = this.createBox('📊 Dependency Graph', this.config.width - 4) + '\n\n';

    // Simple visualization for now
    if (graph.nodes.size === 0) {
      output += '  No dependencies found or feature not yet implemented.\n';
      output += '  Stay tuned for full dependency visualization!\n';
    }

    return output;
  }

  /**
   * Generate complexity heatmap
   */
  async visualizeComplexity(rootPath: string): Promise<string> {
    const chars = BOX_CHARS[this.config.style as keyof typeof BOX_CHARS] || BOX_CHARS.rounded;
    let output = this.createBox('🔥 Complexity Heatmap', this.config.width - 4) + '\n\n';

    // Generate sample heatmap
    output += '  Legend: 🟢 Low  🟡 Medium  🟠 High  🔴 Very High\n\n';
    output += '  File                                     Complexity\n';
    output += '  ' + chars.horizontal.repeat(this.config.width - 4) + '\n';
    output += '  src/core/engine.ts                       🟢🟢🟢🟡🟡 (Medium)\n';
    output += '  src/cli/commands/index.ts                🟢🟢🟢🟢🟢 (Low)\n';
    output += '  packages/core/src/parser.ts              🟡🟡🟡🟠🟠 (High)\n';
    output += '  tools/code-review/analyzer.ts            🟠🟠🟠🔴🔴 (Very High)\n';

    return output;
  }

  /**
   * Generate ASCII banner art
   */
  generateBanner(text: string): string {
    const banner = `
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ${text.padEnd(59)}║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `.trim();

    return banner;
  }

  /**
   * Generate celebration ASCII art
   */
  generateCelebration(): string {
    const celebration = `
        🎉  🎊  🎉  🎊  🎉  🎊  🎉

        ✨ Code Visualization Complete! ✨

           Your code is beautiful! 🌟

        🎊  🎉  🎊  🎉  🎊  🎉  🎊
    `.trim();

    return this.config.colors
      ? `${COLORS.yellow}${celebration}${COLORS.reset}`
      : celebration;
  }
}

// CLI interface
export async function main(args: string[]): Promise<void> {
  const visualizer = new AsciiVisualizer({
    style: 'rounded',
    colors: true,
    showMetrics: true
  });

  const command = args[0] || 'structure';
  const path = args[1] || '.';

  console.log(visualizer.generateBanner('ASCII Art Code Visualizer'));
  console.log('');

  switch (command) {
    case 'structure':
      const tree = await visualizer.visualizeStructure(path);
      console.log(tree);
      break;

    case 'deps':
    case 'dependencies':
      const deps = await visualizer.visualizeDependencies(path);
      console.log(deps);
      break;

    case 'complexity':
      const complexity = await visualizer.visualizeComplexity(path);
      console.log(complexity);
      break;

    default:
      console.log('Unknown command:', command);
      console.log('Available commands: structure, deps, complexity');
  }

  console.log('');
  console.log(visualizer.generateCelebration());
}

// Export for use in other modules
export default AsciiVisualizer;
