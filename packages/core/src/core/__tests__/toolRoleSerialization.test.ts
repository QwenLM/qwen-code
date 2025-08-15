import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIContentGenerator } from '../openaiContentGenerator.js';
import { Config } from '../../config/config.js';

// Mock OpenAI client
vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor() {}
    chat = {
      completions: {
        create: vi.fn()
      }
    };
  }
}));

// Mock logger modules
vi.mock('../../telemetry/loggers.js', () => ({
  logApiResponse: vi.fn(),
}));

vi.mock('../../utils/openaiLogger.js', () => ({
  openaiLogger: {
    logInteraction: vi.fn(),
  },
}));

describe('Tool Role Serialization', () => {
  let generator: OpenAIContentGenerator;
  let mockConfig: Config;

  beforeEach(() => {
    // Mock config
    mockConfig = {
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'openai',
        enableOpenAILogging: false,
        timeout: 120000,
        maxRetries: 3,
      }),
    } as unknown as Config;

    // Create generator instance
    generator = new OpenAIContentGenerator('test-api-key', 'gpt-4', mockConfig);
  });

  it('should emit role "tool" for functionResponse parts', () => {
    // Access the private method for testing
    const convertMethod = (generator as any).convertToOpenAIFormat.bind(generator);
    
    const request = {
      contents: [
        // Assistant message with tool call (required for tool response to not be orphaned)
        {
          role: 'model' as const,
          parts: [
            {
              text: 'I will call a function.'
            },
            {
              functionCall: {
                id: 'call_test123',
                name: 'test_function',
                args: { input: 'test' }
              }
            }
          ]
        },
        // Function response
        {
          role: 'model' as const, // Function responses can have any role, detection is based on parts
          parts: [
            {
              functionResponse: {
                id: 'call_test123',
                name: 'test_function',
                response: { result: 'test data' }
              }
            }
          ]
        }
      ]
    };

    const result = convertMethod(request);
    
    // Should produce assistant message with tool call + tool response
    expect(result).toHaveLength(2);
    
    // First message should be assistant with tool call
    expect(result[0].role).toBe('assistant');
    expect(result[0]).toHaveProperty('tool_calls');
    
    // Second message should be tool response  
    expect(result[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_test123',
      content: JSON.stringify({ result: 'test data' })
    });
  });

  it('should not assign role "user" to tool-result content', () => {
    const convertMethod = (generator as any).convertToOpenAIFormat.bind(generator);
    
    const request = {
      contents: [
        // Assistant message with tool calls
        {
          role: 'model' as const,
          parts: [
            {
              text: 'I need to call a function.'
            },
            {
              functionCall: {
                id: 'call_abc123',
                name: 'read_file',
                args: { filename: 'test.txt' }
              }
            }
          ]
        },
        // Tool response (this should NOT get role: "user")
        {
          role: 'model' as const, // Role doesn't matter for function responses
          parts: [
            {
              functionResponse: {
                id: 'call_abc123',
                name: 'read_file',
                response: { content: 'file contents' }
              }
            }
          ]
        }
      ]
    };

    const result = convertMethod(request);
    
    // Verify no tool responses have role: "user"
    const toolResponses = result.filter((msg: any) => 
      'tool_call_id' in msg || 
      (msg.role === 'tool')
    );
    
    expect(toolResponses).toHaveLength(1);
    expect(toolResponses[0].role).toBe('tool');
    expect(toolResponses[0]).toHaveProperty('tool_call_id', 'call_abc123');
    
    // Verify no message with tool content has role: "user"
    const userMessages = result.filter((msg: any) => msg.role === 'user');
    expect(userMessages).toHaveLength(0);
  });

  it('should preserve genuine user messages with role "user"', () => {
    const convertMethod = (generator as any).convertToOpenAIFormat.bind(generator);
    
    const request = {
      contents: [{
        role: 'user' as const,
        parts: [
          {
            text: 'This is a genuine user message'
          }
        ]
      }]
    };

    const result = convertMethod(request);
    
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: 'This is a genuine user message'
    });
  });

  it('should handle mixed conversation with tools correctly', () => {
    const convertMethod = (generator as any).convertToOpenAIFormat.bind(generator);
    
    const request = {
      contents: [
        // User question
        {
          role: 'user' as const,
          parts: [{ text: 'Please read test.txt' }]
        },
        // Assistant with tool call
        {
          role: 'model' as const,
          parts: [
            { text: 'I will read the file for you.' },
            {
              functionCall: {
                id: 'call_read123',
                name: 'read_file',
                args: { filename: 'test.txt' }
              }
            }
          ]
        },
        // Tool response
        {
          role: 'model' as const, // Role doesn't matter for function responses
          parts: [
            {
              functionResponse: {
                id: 'call_read123', 
                name: 'read_file',
                response: { content: 'Hello world!' }
              }
            }
          ]
        },
        // Assistant final response
        {
          role: 'model' as const,
          parts: [{ text: 'The file contains: Hello world!' }]
        }
      ]
    };

    const result = convertMethod(request);
    
    expect(result).toHaveLength(4);
    
    // User message
    expect(result[0].role).toBe('user');
    expect(result[0]).toHaveProperty('content', 'Please read test.txt');
    
    // Assistant with tool call
    expect(result[1].role).toBe('assistant');
    expect(result[1]).toHaveProperty('tool_calls');
    
    // Tool response (NOT user!)
    expect(result[2].role).toBe('tool');
    expect(result[2]).toHaveProperty('tool_call_id', 'call_read123');
    expect(result[2]).toHaveProperty('content', JSON.stringify({ content: 'Hello world!' }));
    
    // Final assistant response
    expect(result[3].role).toBe('assistant');
    expect(result[3]).toHaveProperty('content', 'The file contains: Hello world!');
    
    // Critical: No tool responses should have role: "user"
    const userMessages = result.filter((msg: any) => msg.role === 'user');
    expect(userMessages).toHaveLength(1); // Only the genuine user message
  });

  it('should handle fallback roles correctly without assigning user to non-user content', () => {
    const convertMethod = (generator as any).convertToOpenAIFormat.bind(generator);
    
    const request = {
      contents: [
        // System-like content that should not get role: "user"
        {
          role: 'system' as const,
          parts: [{ text: 'This is system content' }]
        },
        // Unknown role content that should not get role: "user"
        {
          role: 'unknown' as const,
          parts: [{ text: 'This is unknown role content' }]
        }
      ]
    };

    const result = convertMethod(request);
    
    // Both should get role: "system" due to our fix
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('system');
    expect(result[1].role).toBe('system');
    
    // No messages should have role: "user"
    const userMessages = result.filter((msg: any) => msg.role === 'user');
    expect(userMessages).toHaveLength(0);
  });
});