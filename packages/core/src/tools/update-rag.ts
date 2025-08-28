import { BaseTool, ToolResult, Kind } from './tools.js';
import { RAGService } from '../rag/RAGService.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import * as fs from 'fs';
import * as path from 'path';

export interface UpdateRAGParams {
  file_path?: string;
  directory_path?: string;
}

export class UpdateRAGTool extends BaseTool<UpdateRAGParams, ToolResult> {
  static readonly Name = 'update_rag';
  private ragService: RAGService;
  private fileDiscoveryService: FileDiscoveryService;

  constructor() {
    const description = `Updates the RAG system with the latest code from a file or directory.
Use this tool when you want to ensure the RAG system has the most up-to-date information about the codebase.`;

    const parameterSchema = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to a specific file to update in the RAG system',
        },
        directory_path: {
          type: 'string',
          description: 'The absolute path to a directory to update in the RAG system',
        },
      },
      oneOf: [
        { required: ['file_path'] },
        { required: ['directory_path'] }
      ]
    };

    super(
      UpdateRAGTool.Name,
      UpdateRAGTool.Name,
      description,
      Kind.Other,
      parameterSchema,
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );

    // Get Milvus address from config or use default
    const milvusAddress = 'localhost:19530'; // Default address
    this.ragService = new RAGService(milvusAddress);
    
    // Initialize file discovery service for gitignore support
    this.fileDiscoveryService = new FileDiscoveryService(process.cwd());
  }

  async execute(params: UpdateRAGParams): Promise<ToolResult> {
    try {
      if (params.file_path) {
        // Update a specific file
        const normalizedPath = path.resolve(params.file_path);
        
        // Check if file exists
        if (!fs.existsSync(normalizedPath)) {
          return {
            llmContent: `Error: File not found: ${normalizedPath}`,
            returnDisplay: `Error: File not found: ${normalizedPath}`,
          };
        }
        
        // Check if it's actually a file
        const stats = fs.statSync(normalizedPath);
        if (!stats.isFile()) {
          return {
            llmContent: `Error: Path is not a file: ${normalizedPath}`,
            returnDisplay: `Error: Path is not a file: ${normalizedPath}`,
          };
        }
        
        // Check if file should be ignored
        const relativePath = path.relative(process.cwd(), normalizedPath);
        if (this.shouldIgnoreFile(relativePath)) {
          return {
            llmContent: `Skipped: File is ignored by .gitignore or is in .git directory: ${normalizedPath}`,
            returnDisplay: `Skipped: File is ignored by .gitignore or is in .git directory: ${normalizedPath}`,
          };
        }
        
        // Check if file is likely binary
        if (this.isLikelyBinary(normalizedPath)) {
          return {
            llmContent: `Skipped: File appears to be binary: ${normalizedPath}`,
            returnDisplay: `Skipped: File appears to be binary: ${normalizedPath}`,
          };
        }
        
        // Read the file content
        const content = fs.readFileSync(normalizedPath, 'utf8');
        
        // Update the RAG system
        await this.ragService.addOrUpdateCode(normalizedPath, content);
        
        return {
          llmContent: `Successfully updated RAG system with file: ${normalizedPath}`,
          returnDisplay: `Successfully updated RAG system with file: ${normalizedPath}`,
        };
      } else if (params.directory_path) {
        // Update a directory
        const normalizedPath = path.resolve(params.directory_path);
        
        // Check if directory exists
        if (!fs.existsSync(normalizedPath)) {
          return {
            llmContent: `Error: Directory not found: ${normalizedPath}`,
            returnDisplay: `Error: Directory not found: ${normalizedPath}`,
          };
        }
        
        // Check if it's actually a directory
        const stats = fs.statSync(normalizedPath);
        if (!stats.isDirectory()) {
          return {
            llmContent: `Error: Path is not a directory: ${normalizedPath}`,
            returnDisplay: `Error: Path is not a directory: ${normalizedPath}`,
          };
        }
        
        // Check if directory should be ignored
        const relativePath = path.relative(process.cwd(), normalizedPath);
        if (this.shouldIgnoreFile(relativePath)) {
          return {
            llmContent: `Skipped: Directory is ignored by .gitignore or is .git directory: ${normalizedPath}`,
            returnDisplay: `Skipped: Directory is ignored by .gitignore or is .git directory: ${normalizedPath}`,
          };
        }
        
        // Recursively update all files in the directory
        const processedFiles = await this.updateDirectory(normalizedPath);
        
        return {
          llmContent: `Successfully updated RAG system with directory: ${normalizedPath} (${processedFiles} files processed)`,
          returnDisplay: `Successfully updated RAG system with directory: ${normalizedPath} (${processedFiles} files processed)`,
        };
      } else {
        return {
          llmContent: 'Error: Either file_path or directory_path must be provided',
          returnDisplay: 'Error: Either file_path or directory_path must be provided',
        };
      }
    } catch (error: any) {
      return {
        llmContent: `Error updating RAG system: ${error.message}`,
        returnDisplay: `Error updating RAG system: ${error.message}`,
      };
    }
  }

  private async updateDirectory(directoryPath: string): Promise<number> {
    const files = fs.readdirSync(directoryPath);
    let processedFiles = 0;
    
    // Configuration for performance optimization
    const MAX_FILE_SIZE = 1024 * 1024; // 1MB max file size
    const ALLOWED_EXTENSIONS = [
      '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
      '.py', '.pyx', '.pyi',
      '.java', '.kt', '.scala', '.groovy',
      '.go', '.rs', '.php', '.rb', '.swift',
      '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hxx',
      '.cs', '.fs', '.fsx',
      '.sh', '.bash', '.zsh', '.fish',
      '.yml', '.yaml', '.json', '.xml', '.toml', '.ini', '.env',
      '.md', '.txt', '.rst', '.adoc',
      '.sql', '.graphql', '.proto', '.thrift',
      '.html', '.htm', '.css', '.scss', '.sass', '.less',
      '.vue', '.svelte'
    ];
    
    // Filter files using file discovery service
    const relativePaths = files.map(file => path.relative(process.cwd(), path.join(directoryPath, file)));
    const filteredPaths = this.fileDiscoveryService.filterFiles(relativePaths);
    const filteredFiles = new Set(filteredPaths.map(p => path.basename(p)));
    
    // Process files in batches to prevent blocking
    const batchSize = 50;
    const fileBatches: string[][] = [];
    let currentBatch: string[] = [];
    
    for (const file of files) {
      if (!filteredFiles.has(file)) continue;
      
      const filePath = path.join(directoryPath, file);
      try {
        const stats = fs.statSync(filePath);
        
        // Skip directories, large files, and non-allowed extensions
        if (!stats.isFile()) continue;
        if (stats.size > MAX_FILE_SIZE) continue;
        
        const ext = path.extname(filePath).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) continue;
        
        // Skip binary files
        if (this.isLikelyBinary(filePath)) continue;
        
        currentBatch.push(filePath);
        
        if (currentBatch.length >= batchSize) {
          fileBatches.push(currentBatch);
          currentBatch = [];
        }
      } catch (error) {
        // Skip files that can't be accessed
        continue;
      }
    }
    
    if (currentBatch.length > 0) {
      fileBatches.push(currentBatch);
    }
    
    // Process batches asynchronously
    for (const batch of fileBatches) {
      await Promise.all(
        batch.map(async (filePath) => {
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            if (content.length > 0 && content.length < MAX_FILE_SIZE) {
              await this.ragService.addOrUpdateCode(filePath, content);
              processedFiles++;
            }
          } catch (error) {
            // Skip files that can't be read
          }
        })
      );
      
      // Add small delay between batches to prevent blocking
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // Process subdirectories with concurrency limit
    const subdirs = files.filter(file => {
      if (file === '.git') return false;
      const filePath = path.join(directoryPath, file);
      try {
        return fs.statSync(filePath).isDirectory();
      } catch {
        return false;
      }
    });
    
    for (const dir of subdirs) {
      const subDirPath = path.join(directoryPath, dir);
      const subDirProcessed = await this.updateDirectory(subDirPath);
      processedFiles += subDirProcessed;
    }
    
    return processedFiles;
  }

  private shouldIgnoreFile(relativePath: string): boolean {
    // Always ignore .git directories
    if (relativePath.startsWith('.git/') || relativePath === '.git') {
      return true;
    }
    
    // Use file discovery service to check gitignore
    return this.fileDiscoveryService.shouldIgnoreFile(relativePath);
  }

  private isLikelyBinary(filePath: string): boolean {
    try {
      const buffer = fs.readFileSync(filePath, { encoding: null });
      const chunk = buffer.slice(0, Math.min(512, buffer.length));
      
      // Check for null bytes which are common in binary files
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0) {
          return true;
        }
      }
      
      // Check for common binary file extensions
      const binaryExtensions = [
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.zip', '.tar', '.gz', '.rar', '.7z',
        '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv',
        '.exe', '.dll', '.so', '.dylib', '.class'
      ];
      
      const ext = path.extname(filePath).toLowerCase();
      if (binaryExtensions.includes(ext)) {
        return true;
      }
      
      return false;
    } catch (error) {
      // If we can't read the file, assume it's binary to be safe
      return true;
    }
  }
}