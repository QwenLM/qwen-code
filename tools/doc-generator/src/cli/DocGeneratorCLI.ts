import { Config, GeminiChat, ReadFileTool, ShellTool } from '@qwen-code/qwen-code-core';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as glob from 'glob';
import chalk from 'chalk';
import { marked } from 'marked';
import { createServer } from 'http';
import { spawn } from 'child_process';

export interface DocOptions {
  type?: string;
  output?: string;
  format?: string;
  config?: string;
  force?: boolean;
  port?: string;
}

export interface DocConfig {
  projectName: string;
  description: string;
  includePatterns: string[];
  excludePatterns: string[];
  docTypes: string[];
  outputFormats: string[];
  templates: Record<string, string>;
  apiDoc: {
    includePrivate: boolean;
    includeExamples: boolean;
    groupBy: 'module' | 'type' | 'function';
  };
  readme: {
    includeTableOfContents: boolean;
    includeInstallation: boolean;
    includeExamples: boolean;
  };
}

export class DocGeneratorCLI {
  private config: Config;
  private chat: GeminiChat;
  private docConfig: DocConfig;

  constructor(config: Config) {
    this.config = config;
    this.chat = new GeminiChat(config);
    this.docConfig = this.getDefaultDocConfig();
  }

  async generate(options: DocOptions): Promise<void> {
    try {
      console.log(chalk.blue('📚 Starting documentation generation...'));
      
      const outputDir = path.resolve(options.output || './docs');
      await fs.ensureDir(outputDir);
      
      const projectFiles = await this.discoverProjectFiles();
      console.log(chalk.green(`Found ${projectFiles.length} project files`));
      
      if (options.type === 'all' || options.type === 'api') {
        await this.generateAPIDocs(projectFiles, outputDir, options);
      }
      
      if (options.type === 'all' || options.type === 'readme') {
        await this.generateReadme(projectFiles, outputDir, options);
      }
      
      if (options.type === 'all' || options.type === 'guides') {
        await this.generateGuides(projectFiles, outputDir, options);
      }
      
      console.log(chalk.green(`✅ Documentation generated successfully in ${outputDir}`));
      
    } catch (error) {
      console.error(chalk.red('Error generating documentation:'), error);
      process.exit(1);
    }
  }

  async update(options: DocOptions): Promise<void> {
    try {
      console.log(chalk.blue('🔄 Updating existing documentation...'));
      
      const outputDir = path.resolve(options.output || './docs');
      if (!await fs.pathExists(outputDir)) {
        console.log(chalk.yellow('No existing documentation found. Run generate first.'));
        return;
      }
      
      // Check for modified files and update relevant docs
      const modifiedFiles = await this.getModifiedFiles();
      if (modifiedFiles.length === 0 && !options.force) {
        console.log(chalk.green('No modified files found. Use --force to update all.'));
        return;
      }
      
      await this.generate(options);
      console.log(chalk.green('✅ Documentation updated successfully'));
      
    } catch (error) {
      console.error(chalk.red('Error updating documentation:'), error);
      process.exit(1);
    }
  }

  async serve(options: DocOptions): Promise<void> {
    try {
      const outputDir = path.resolve(options.output || './docs');
      const port = parseInt(options.port || '3000');
      
      if (!await fs.pathExists(outputDir)) {
        console.log(chalk.yellow('No documentation found. Run generate first.'));
        return;
      }
      
      console.log(chalk.blue(`🌐 Serving documentation on http://localhost:${port}`));
      console.log(chalk.gray('Press Ctrl+C to stop'));
      
      const server = createServer((req, res) => {
        let filePath = path.join(outputDir, req.url === '/' ? 'index.html' : req.url || '');
        
        if (!fs.existsSync(filePath)) {
          filePath = path.join(outputDir, 'index.html');
        }
        
        const ext = path.extname(filePath);
        const contentType = this.getContentType(ext);
        
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(fs.readFileSync(filePath));
      });
      
      server.listen(port, () => {
        console.log(chalk.green(`✅ Documentation server running on port ${port}`));
      });
      
      // Keep the process alive
      process.on('SIGINT', () => {
        console.log(chalk.yellow('\n🛑 Stopping documentation server...'));
        server.close(() => {
          console.log(chalk.green('✅ Server stopped'));
          process.exit(0);
        });
      });
      
    } catch (error) {
      console.error(chalk.red('Error serving documentation:'), error);
      process.exit(1);
    }
  }

  async configure(options: DocOptions): Promise<void> {
    try {
      if (options.show) {
        console.log(chalk.blue('📋 Current Documentation Configuration:'));
        console.log(JSON.stringify(this.docConfig, null, 2));
        return;
      }
      
      if (options.edit) {
        const configPath = path.join(process.cwd(), '.qwen-docs.json');
        await fs.writeJson(configPath, this.docConfig, { spaces: 2 });
        
        const editor = process.env.EDITOR || 'code';
        spawn(editor, [configPath], { stdio: 'inherit' });
        
        console.log(chalk.green(`✅ Configuration opened in ${editor}`));
        console.log(chalk.gray('Save the file and restart the tool to apply changes'));
        return;
      }
      
      console.log(chalk.blue('⚙️  Documentation Configuration'));
      console.log(chalk.gray('Use --show to view current config or --edit to modify'));
      
    } catch (error) {
      console.error(chalk.red('Error configuring documentation:'), error);
      process.exit(1);
    }
  }

  private async discoverProjectFiles(): Promise<string[]> {
    const patterns = this.docConfig.includePatterns;
    const excludePatterns = this.docConfig.excludePatterns;
    
    let allFiles: string[] = [];
    
    for (const pattern of patterns) {
      const files = glob.sync(pattern, { 
        ignore: excludePatterns,
        cwd: process.cwd(),
        absolute: true 
      });
      allFiles.push(...files);
    }
    
    // Filter by file size and type
    allFiles = allFiles.filter(file => {
      const stats = fs.statSync(file);
      return stats.isFile() && stats.size < 1024 * 1024; // 1MB limit
    });
    
    return allFiles;
  }

  private async generateAPIDocs(files: string[], outputDir: string, options: DocOptions): Promise<void> {
    console.log(chalk.cyan('📖 Generating API documentation...'));
    
    const apiDir = path.join(outputDir, 'api');
    await fs.ensureDir(apiDir);
    
    const apiDocs: any[] = [];
    
    for (const file of files) {
      if (this.isCodeFile(file)) {
        const content = await fs.readFile(file, 'utf-8');
        const doc = await this.analyzeCodeFile(file, content);
        apiDocs.push(doc);
      }
    }
    
    // Group by module
    const groupedDocs = this.groupAPIDocs(apiDocs);
    
    // Generate markdown
    const markdown = this.generateAPIMarkdown(groupedDocs);
    await fs.writeFile(path.join(apiDir, 'README.md'), markdown);
    
    // Generate index
    const index = this.generateAPIIndex(groupedDocs);
    await fs.writeFile(path.join(apiDir, 'index.md'), index);
  }

  private async generateReadme(files: string[], outputDir: string, options: DocOptions): Promise<void> {
    console.log(chalk.cyan('📝 Generating README...'));
    
    const projectInfo = await this.analyzeProject(files);
    const readme = this.generateReadmeContent(projectInfo);
    
    await fs.writeFile(path.join(outputDir, 'README.md'), readme);
  }

  private async generateGuides(files: string[], outputDir: string, options: DocOptions): Promise<void> {
    console.log(chalk.cyan('📚 Generating guides...'));
    
    const guidesDir = path.join(outputDir, 'guides');
    await fs.ensureDir(guidesDir);
    
    const guides = [
      { name: 'getting-started', title: 'Getting Started' },
      { name: 'installation', title: 'Installation' },
      { name: 'usage', title: 'Usage Examples' },
      { name: 'contributing', title: 'Contributing' }
    ];
    
    for (const guide of guides) {
      const content = await this.generateGuideContent(guide, files);
      await fs.writeFile(path.join(guidesDir, `${guide.name}.md`), content);
    }
    
    // Generate guides index
    const index = this.generateGuidesIndex(guides);
    await fs.writeFile(path.join(guidesDir, 'index.md'), index);
  }

  private async analyzeCodeFile(filePath: string, content: string): Promise<any> {
    const prompt = `Analyze this code file and extract API documentation:

File: ${path.basename(filePath)}
Content:
\`\`\`
${content}
\`\`\`

Please provide:
1. File purpose and overview
2. Exported functions/classes with signatures
3. Parameters and return types
4. Usage examples
5. Dependencies and imports
6. Any important notes or warnings

Format as structured data.`;

    const response = await this.chat.sendMessage(prompt);
    return {
      file: path.basename(filePath),
      path: filePath,
      content: response.text,
      timestamp: new Date().toISOString()
    };
  }

  private async analyzeProject(files: string[]): Promise<any> {
    const prompt = `Analyze this project structure and provide project information:

Files: ${files.map(f => path.basename(f)).join(', ')}

Please provide:
1. Project name and description
2. Main purpose and functionality
3. Key features
4. Technology stack
5. Project structure overview
6. Installation requirements
7. Usage examples
8. Contributing guidelines

Format as structured project information.`;

    const response = await this.chat.sendMessage(prompt);
    return {
      analysis: response.text,
      fileCount: files.length,
      timestamp: new Date().toISOString()
    };
  }

  private async generateGuideContent(guide: { name: string; title: string }, files: string[]): Promise<string> {
    const prompt = `Generate a comprehensive guide for: ${guide.title}

Based on the project files, create a detailed guide covering:
1. Introduction and overview
2. Step-by-step instructions
3. Code examples
4. Common issues and solutions
5. Best practices
6. Related resources

Make it practical and easy to follow.`;

    const response = await this.chat.sendMessage(prompt);
    return `# ${guide.title}\n\n${response.text}`;
  }

  private groupAPIDocs(docs: any[]): Record<string, any[]> {
    const grouped: Record<string, any[]> = {};
    
    for (const doc of docs) {
      const module = path.dirname(doc.file).split('/').pop() || 'root';
      if (!grouped[module]) {
        grouped[module] = [];
      }
      grouped[module].push(doc);
    }
    
    return grouped;
  }

  private generateAPIMarkdown(groupedDocs: Record<string, any[]>): string {
    let markdown = '# API Documentation\n\n';
    
    for (const [module, docs] of Object.entries(groupedDocs)) {
      markdown += `## ${module}\n\n`;
      
      for (const doc of docs) {
        markdown += `### ${doc.file}\n\n`;
        markdown += doc.content + '\n\n';
        markdown += `---\n\n`;
      }
    }
    
    return markdown;
  }

  private generateAPIIndex(groupedDocs: Record<string, any[]>): string {
    let index = '# API Index\n\n';
    
    for (const [module, docs] of Object.entries(groupedDocs)) {
      index += `## ${module}\n\n`;
      
      for (const doc of docs) {
        index += `- [${doc.file}](./README.md#${doc.file.toLowerCase().replace(/[^a-z0-9]/g, '-')})\n`;
      }
      index += '\n';
    }
    
    return index;
  }

  private generateReadmeContent(projectInfo: any): string {
    return `# Project Documentation

${projectInfo.analysis}

## Generated Documentation

This documentation was automatically generated using Qwen Code Documentation Generator.

- [API Reference](./api/)
- [Guides](./guides/)
- [Getting Started](./guides/getting-started.md)

## Last Updated

${new Date(projectInfo.timestamp).toLocaleDateString()}

---
*Generated with ❤️ by Qwen Code*`;
  }

  private generateGuidesIndex(guides: Array<{ name: string; title: string }>): string {
    let index = '# Guides\n\n';
    
    for (const guide of guides) {
      index += `## [${guide.title}](./${guide.name}.md)\n\n`;
    }
    
    return index;
  }

  private async getModifiedFiles(): Promise<string[]> {
    // This would integrate with git to find modified files
    // For now, return empty array
    return [];
  }

  private isCodeFile(filePath: string): boolean {
    const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.go', '.rs'];
    return codeExtensions.includes(path.extname(filePath));
  }

  private getContentType(ext: string): string {
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.md': 'text/markdown'
    };
    return types[ext] || 'text/plain';
  }

  private getDefaultDocConfig(): DocConfig {
    return {
      projectName: 'My Project',
      description: 'A project documented with Qwen Code',
      includePatterns: ['src/**/*', 'lib/**/*', '*.js', '*.ts', '*.py'],
      excludePatterns: ['node_modules/**', 'dist/**', 'build/**', '*.min.js'],
      docTypes: ['api', 'readme', 'guides'],
      outputFormats: ['markdown', 'html'],
      templates: {},
      apiDoc: {
        includePrivate: false,
        includeExamples: true,
        groupBy: 'module'
      },
      readme: {
        includeTableOfContents: true,
        includeInstallation: true,
        includeExamples: true
      }
    };
  }
}