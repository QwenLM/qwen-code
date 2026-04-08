/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode templates for file generation.
 *
 * Templates define reusable file structures for common development patterns
 * like React components, API endpoints, CLI commands, and more.
 */

export type TemplateCategory =
  | 'react'
  | 'node'
  | 'typescript'
  | 'test'
  | 'config'
  | 'devops';

export interface ModeTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: TemplateCategory;
  files: Array<{
    path: string;
    content: string;
    description: string;
  }>;
  variables: Array<{
    name: string;
    default: string;
    description: string;
  }>;
}

/**
 * Substitutes variables in a template string.
 * Variables are denoted as {{variableName}}.
 */
function substituteVariables(
  content: string,
  variables: Record<string, string>,
): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_match, varName) => variables[varName] ?? `{{${varName}}}`);
}

/**
 * Resolves the file path with variable substitution.
 */
function resolvePath(path: string, variables: Record<string, string>): string {
  return substituteVariables(path, variables);
}

export class ModeTemplateManager {
  private templates: Map<string, ModeTemplate> = new Map();

  /**
   * Register a template definition.
   */
  registerTemplate(template: ModeTemplate): void {
    this.templates.set(template.id, template);
  }

  /**
   * Get all registered templates.
   */
  getAllTemplates(): ModeTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get a template by its ID.
   */
  getTemplate(id: string): ModeTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Generate files from a template with variable substitution.
   */
  generateFiles(
    templateId: string,
    variables?: Record<string, string>,
  ): Array<{ path: string; content: string }> {
    const template = this.getTemplate(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    // Build variable map with defaults overridden by provided values
    const varMap: Record<string, string> = {};
    for (const v of template.variables) {
      varMap[v.name] = variables?.[v.name] ?? v.default;
    }

    return template.files.map((file) => ({
      path: resolvePath(file.path, varMap),
      content: substituteVariables(file.content, varMap),
    }));
  }

  /**
   * Register all built-in templates.
   */
  addBuiltInTemplates(): void {
    for (const template of BUILT_IN_TEMPLATES) {
      this.registerTemplate(template);
    }
  }
}

// ============================================================================
// Built-in Templates
// ============================================================================

const BUILT_IN_TEMPLATES: ModeTemplate[] = [
  // 1. React Component
  {
    id: 'react-component',
    name: 'React Component',
    description:
      'A React functional component with TypeScript, styled with CSS modules, and an associated test file.',
    icon: '⚛️',
    category: 'react',
    variables: [
      {
        name: 'name',
        default: 'Component',
        description: 'Name of the component (PascalCase)',
      },
      {
        name: 'dir',
        default: 'src/components',
        description: 'Directory to generate files in',
      },
    ],
    files: [
      {
        path: '{{dir}}/{{name}}/{{name}}.tsx',
        description: 'Main component file',
        content: `import React from 'react';
import styles from './{{name}}.module.css';

interface {{name}}Props {
  /** Optional className to apply to the root element */
  className?: string;
}

/**
 * {{name}} component description.
 */
export const {{name}}: React.FC<{{name}}Props> = ({ className }) => {
  return (
    <div className={\`\${styles.container} \${className || ''}\`}>
      <h1>{{name}}</h1>
    </div>
  );
};

export default {{name}};
`,
      },
      {
        path: '{{dir}}/{{name}}/{{name}}.module.css',
        description: 'CSS module styles',
        content: `.container {
  padding: 1rem;
  margin: 0.5rem 0;
}
`,
      },
      {
        path: '{{dir}}/{{name}}/{{name}}.test.tsx',
        description: 'Component test file',
        content: `import { render, screen } from '@testing-library/react';
import { {{name}} } from './{{name}}';

describe('{{name}}', () => {
  it('renders without crashing', () => {
    render(<{{name}} />);
    expect(screen.getByText('{{name}}')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<{{name}} className="custom-class" />);
    expect(container.firstChild).toHaveClass('custom-class');
  });
});
`,
      },
      {
        path: '{{dir}}/{{name}}/index.ts',
        description: 'Barrel export file',
        content: `export { {{name}} } from './{{name}}';
export { default } from './{{name}}';
`,
      },
    ],
  },

  // 2. API Endpoint
  {
    id: 'api-endpoint',
    name: 'API Endpoint',
    description:
      'An Express.js API endpoint with controller, service layer, and test file.',
    icon: '🔌',
    category: 'node',
    variables: [
      {
        name: 'name',
        default: 'users',
        description: 'Resource name (lowercase, plural)',
      },
      {
        name: 'dir',
        default: 'src/api',
        description: 'Directory to generate files in',
      },
    ],
    files: [
      {
        path: '{{dir}}/{{name}}/{{name}}.route.ts',
        description: 'Express router with route definitions',
        content: `import { Router } from 'express';
import * as {{name}}Controller from './{{name}}.controller.js';

const router = Router();

/**
 * @route   GET /api/{{name}}
 * @desc    Get all {{name}}
 */
router.get('/', {{name}}Controller.getAll);

/**
 * @route   GET /api/{{name}}/:id
 * @desc    Get {{name}} by ID
 */
router.get('/:id', {{name}}Controller.getById);

/**
 * @route   POST /api/{{name}}
 * @desc    Create a new {{name}}
 */
router.post('/', {{name}}Controller.create);

/**
 * @route   PUT /api/{{name}}/:id
 * @desc    Update a {{name}}
 */
router.put('/:id', {{name}}Controller.update);

/**
 * @route   DELETE /api/{{name}}/:id
 * @desc    Delete a {{name}}
 */
router.delete('/:id', {{name}}Controller.remove);

export default router;
`,
      },
      {
        path: '{{dir}}/{{name}}/{{name}}.controller.ts',
        description: 'Route handler/controller',
        content: `import type { Request, Response } from 'express';
import * as {{name}}Service from './{{name}}.service.js';

/**
 * GET /api/{{name}}
 */
export const getAll = async (req: Request, res: Response): Promise<void> => {
  try {
    const items = await {{name}}Service.getAll();
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch {{name}}' });
  }
};

/**
 * GET /api/{{name}}/:id
 */
export const getById = async (req: Request, res: Response): Promise<void> => {
  try {
    const item = await {{name}}Service.getById(req.params.id);
    if (!item) {
      res.status(404).json({ error: '{{name}} not found' });
      return;
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch {{name}}' });
  }
};

/**
 * POST /api/{{name}}
 */
export const create = async (req: Request, res: Response): Promise<void> => {
  try {
    const item = await {{name}}Service.create(req.body);
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create {{name}}' });
  }
};

/**
 * PUT /api/{{name}}/:id
 */
export const update = async (req: Request, res: Response): Promise<void> => {
  try {
    const item = await {{name}}Service.update(req.params.id, req.body);
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update {{name}}' });
  }
};

/**
 * DELETE /api/{{name}}/:id
 */
export const remove = async (req: Request, res: Response): Promise<void> => {
  try {
    await {{name}}Service.remove(req.params.id);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete {{name}}' });
  }
};
`,
      },
      {
        path: '{{dir}}/{{name}}/{{name}}.service.ts',
        description: 'Business logic service layer',
        content: `// TODO: Replace with actual data source
const store: Map<string, unknown> = new Map();

export interface {{Name}}Item {
  id: string;
  [key: string]: unknown;
}

/**
 * Get all items.
 */
export const getAll = async (): Promise<{{Name}}Item[]> => {
  return Array.from(store.values()) as {{Name}}Item[];
};

/**
 * Get item by ID.
 */
export const getById = async (id: string): Promise<{{Name}}Item | undefined> => {
  return store.get(id) as {{Name}}Item | undefined;
};

/**
 * Create a new item.
 */
export const create = async (data: Omit<{{Name}}Item, 'id'>): Promise<{{Name}}Item> => {
  const id = crypto.randomUUID();
  const item = { id, ...data } as {{Name}}Item;
  store.set(id, item);
  return item;
};

/**
 * Update an existing item.
 */
export const update = async (id: string, data: Partial<{{Name}}Item>): Promise<{{Name}}Item> => {
  const existing = store.get(id);
  if (!existing) {
    throw new Error('{{name}} not found');
  }
  const updated = { ...(existing as {{Name}}Item), ...data };
  store.set(id, updated);
  return updated;
};

/**
 * Delete an item.
 */
export const remove = async (id: string): Promise<void> => {
  store.delete(id);
};
`,
      },
      {
        path: '{{dir}}/{{name}}/{{name}}.test.ts',
        description: 'Test file for the endpoint',
        content: `import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as {{name}}Controller from './{{name}}.controller.js';
import * as {{name}}Service from './{{name}}.service.js';

vi.mock('./{{name}}.service.js');

describe('{{name}} Controller', () => {
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    mockReq = { params: {}, body: {} };
    mockRes = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
  });

  describe('getAll', () => {
    it('should return all items', async () => {
      const items = [{ id: '1', name: 'test' }];
      vi.mocked({{name}}Service.getAll).mockResolvedValue(items);

      await {{name}}Controller.getAll(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(items);
    });
  });

  describe('getById', () => {
    it('should return 404 if not found', async () => {
      vi.mocked({{name}}Service.getById).mockResolvedValue(undefined);
      mockReq.params.id = '1';

      await {{name}}Controller.getById(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });
  });
});
`,
      },
      {
        path: '{{dir}}/{{name}}/index.ts',
        description: 'Barrel export',
        content: `export { default } from './{{name}}.route.js';
export * as controller from './{{name}}.controller.js';
export * as service from './{{name}}.service.js';
`,
      },
    ],
  },

  // 3. CLI Command
  {
    id: 'cli-command',
    name: 'CLI Command',
    description: 'A CLI command module with handler and test file.',
    icon: '⌨️',
    category: 'typescript',
    variables: [
      {
        name: 'name',
        default: 'command',
        description: 'Command name (kebab-case)',
      },
      {
        name: 'dir',
        default: 'src/commands',
        description: 'Directory to generate files in',
      },
    ],
    files: [
      {
        path: '{{dir}}/{{name}}.ts',
        description: 'Command handler module',
        content: `import { Command } from 'commander';

export interface {{NameCommand}}Options {
  verbose?: boolean;
  output?: string;
}

/**
 * Register the {{name}} command with the CLI.
 */
export function register{{NameCommand}}(program: Command): void {
  program
    .command('{{name}}')
    .description('Execute the {{name}} command')
    .option('-v, --verbose', 'Enable verbose output')
    .option('-o, --output <path>', 'Output file path')
    .action(async (options: {{NameCommand}}Options) => {
      await handle{{NameCommand}}(options);
    });
}

/**
 * Handle the {{name}} command execution.
 */
export async function handle{{NameCommand}}(
  options: {{NameCommand}}Options,
): Promise<void> {
  if (options.verbose) {
    console.log('[{{name}}] Starting with options:', options);
  }

  // TODO: Implement command logic
  console.log('{{name}} command executed successfully.');
}
`,
      },
      {
        path: '{{dir}}/{{name}}.test.ts',
        description: 'Command test file',
        content: `import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handle{{NameCommand}} } from './{{name}}.js';

describe('{{name}} command', () => {
  let consoleLogSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should execute successfully with default options', async () => {
    await handle{{NameCommand}}({});
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '{{name}} command executed successfully.',
    );
  });

  it('should log verbose output when verbose option is set', async () => {
    await handle{{NameCommand}}({ verbose: true });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[{{name}}] Starting with options:'),
    );
  });
});
`,
      },
    ],
  },

  // 4. Test Suite
  {
    id: 'test-suite',
    name: 'Test Suite',
    description: 'A test file with describe/it blocks and common patterns.',
    icon: '🧪',
    category: 'test',
    variables: [
      {
        name: 'name',
        default: 'module',
        description: 'Name of the module being tested',
      },
      {
        name: 'dir',
        default: 'src/__tests__',
        description: 'Directory to generate the test file in',
      },
    ],
    files: [
      {
        path: '{{dir}}/{{name}}.test.ts',
        description: 'Test suite file',
        content: `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('{{name}}', () => {
  // Setup and teardown
  beforeEach(() => {
    // Setup before each test
  });

  afterEach(() => {
    // Cleanup after each test
  });

  describe('initialization', () => {
    it('should create an instance with default values', () => {
      // TODO: Write test
      expect(true).toBe(true);
    });

    it('should accept custom configuration', () => {
      // TODO: Write test
      expect(true).toBe(true);
    });
  });

  describe('core functionality', () => {
    it('should perform the expected operation', () => {
      // TODO: Write test
      expect(true).toBe(true);
    });

    it('should handle edge cases gracefully', () => {
      // TODO: Write test
      expect(true).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw an error for invalid input', () => {
      // TODO: Write test
      expect(true).toBe(true);
    });

    it('should handle async errors properly', async () => {
      // TODO: Write test
      await expect(Promise.reject(new Error('test'))).rejects.toThrow('test');
    });
  });
});
`,
      },
    ],
  },

  // 5. Docker Service
  {
    id: 'docker-service',
    name: 'Docker Service',
    description:
      'Dockerfile and docker-compose.yml for containerizing a service.',
    icon: '🐳',
    category: 'devops',
    variables: [
      {
        name: 'name',
        default: 'service',
        description: 'Service name',
      },
      {
        name: 'port',
        default: '3000',
        description: 'Port the service runs on',
      },
      {
        name: 'dir',
        default: '.',
        description: 'Directory to generate files in',
      },
    ],
    files: [
      {
        path: '{{dir}}/Dockerfile.{{name}}',
        description: 'Multi-stage Dockerfile for the service',
        content: `# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \\
    adduser -S nodejs -u 1001

USER nodejs

EXPOSE {{port}}

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\
  CMD wget -qO- http://localhost:{{port}}/health || exit 1

CMD ["node", "dist/index.js"]
`,
      },
      {
        path: '{{dir}}/docker-compose.{{name}}.yml',
        description: 'Docker Compose configuration for the service',
        content: `version: '3.8'

services:
  {{name}}:
    build:
      context: .
      dockerfile: Dockerfile.{{name}}
    ports:
      - "{{port}}:{{port}}"
    environment:
      - NODE_ENV=production
      - PORT={{port}}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:{{port}}/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - app-network

networks:
  app-network:
    driver: bridge
`,
      },
    ],
  },

  // 6. GitHub Action
  {
    id: 'github-action',
    name: 'GitHub Actions Workflow',
    description: 'A GitHub Actions workflow file for CI/CD.',
    icon: '🔄',
    category: 'devops',
    variables: [
      {
        name: 'name',
        default: 'ci',
        description: 'Workflow name',
      },
      {
        name: 'dir',
        default: '.github/workflows',
        description: 'Directory to generate files in',
      },
    ],
    files: [
      {
        path: '{{dir}}/{{name}}.yml',
        description: 'GitHub Actions workflow file',
        content: `name: {{name}}

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  NODE_VERSION: '20'

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run linter
        run: npm run lint

  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test -- --coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          file: ./coverage/lcov.info

  build:
    name: Build
    runs-on: ubuntu-latest
    needs: [lint, test]
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
`,
      },
    ],
  },
];

/**
 * Helper to convert a kebab-case or snake_case name to PascalCase.
 */
export function toPascalCase(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\s/g, '');
}

/**
 * Helper to convert a name to camelCase.
 */
export function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Helper to convert a name to CONSTANT_CASE.
 */
export function toConstantCase(name: string): string {
  return name.toUpperCase().replace(/[-_\s]/g, '_');
}
