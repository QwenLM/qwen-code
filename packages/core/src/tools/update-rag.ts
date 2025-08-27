import { BaseTool, ToolResult, Kind } from './tools.js';
import { RAGService } from '../rag/RAGService.js';
import * as fs from 'fs';
import * as path from 'path';

export interface UpdateRAGParams {
  file_path?: string;
  directory_path?: string;
}

export class UpdateRAGTool extends BaseTool<UpdateRAGParams, ToolResult> {
  static readonly Name = 'update_rag';
  private ragService: RAGService;

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
        
        // Recursively update all files in the directory
        await this.updateDirectory(normalizedPath);
        
        return {
          llmContent: `Successfully updated RAG system with directory: ${normalizedPath}`,
          returnDisplay: `Successfully updated RAG system with directory: ${normalizedPath}`,
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

  private async updateDirectory(directoryPath: string): Promise<void> {
    const files = fs.readdirSync(directoryPath);
    
    for (const file of files) {
      const filePath = path.join(directoryPath, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isFile()) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          await this.ragService.addOrUpdateCode(filePath, content);
        } catch (error) {
          console.error(`Error updating file ${filePath} in RAG system:`, error);
        }
      } else if (stats.isDirectory()) {
        // Recursively update subdirectories
        await this.updateDirectory(filePath);
      }
    }
  }
}