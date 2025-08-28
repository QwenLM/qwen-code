import { BaseTool, ToolResult, Kind } from './tools.js';
import { RAGService } from '../rag/RAGService.js';
import { Config } from '../config/config.js';

export interface RetrieveCodeParams {
  query: string;
  limit?: number;
}

export class RetrieveCodeTool extends BaseTool<RetrieveCodeParams, ToolResult> {
  static readonly Name = 'retrieve_code';
  private ragService: RAGService;

  constructor(config: Config) {
    const description = `Retrieves relevant code snippets from the codebase based on a query. 
Use this tool when you need to find specific code related to a functionality or feature.`;

    const parameterSchema = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The query to search for relevant code snippets',
        },
        limit: {
          type: 'number',
          description: 'The maximum number of code snippets to retrieve (default: 5)',
          minimum: 1,
          maximum: 20,
        },
      },
      required: ['query'],
    };

    super(
      RetrieveCodeTool.Name,
      RetrieveCodeTool.Name,
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

  async execute(params: RetrieveCodeParams): Promise<ToolResult> {
    try {
      const limit = params.limit || 5;
      const relevantCode = await this.ragService.retrieveRelevantCode(params.query, limit);
      
      return {
        llmContent: relevantCode,
        returnDisplay: relevantCode,
      };
    } catch (error: any) {
      return {
        llmContent: `Error retrieving code: ${error.message}`,
        returnDisplay: `Error retrieving code: ${error.message}`,
      };
    }
  }
}