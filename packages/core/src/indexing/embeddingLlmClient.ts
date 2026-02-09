import { OpenAI } from 'openai';
/**
 * Simple LLM client for generating embeddings within the worker.
 * This is a minimal implementation that directly calls the embedding API.
 */
export class EmbeddingLlmClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private client: OpenAI;

  totalUsedTokens: number = 0;

  constructor(config: { apiKey: string; baseUrl?: string; model?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl =
      config.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    this.model = config.model ?? 'text-embedding-v4';

    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
    });
  }

  /**
   * Generates embeddings for a batch of texts.
   */
  async generateEmbedding(texts: string[]): Promise<number[][]> {
    try {
      const completion = await this.client.embeddings.create({
        model: this.model,
        input: texts,
      });
      this.totalUsedTokens += completion.usage.total_tokens;

      return completion.data
        .sort((a, b) => a.index - b.index)
        .map((v) => v.embedding);
    } catch (error) {
      throw new Error(`Embedding API error: ${error}`);
    }

    // const data = await response.json() as {
    //   data: Array<{ embedding: number[]; index: number }>;
    // };

    // // Sort by index to ensure correct order
    // const sorted = data.data.sort((a, b) => a.index - b.index);
    // return sorted.map((item) => item.embedding);
  }

  resetTokenCount() {
    this.totalUsedTokens = 0;
  }
}
