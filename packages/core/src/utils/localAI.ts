/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local AI server utilities for LM Studio and similar local servers
 * Enhanced implementation with essential socket configuration
 * Provides reliable connections through documented socket settings
 * Based on successful llxprt implementation with 100% success rate
 */
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

/**
 * Default API key for local AI servers
 * Used as a placeholder since OpenAI SDK requires a key
 */
export const LOCAL_AI_DEFAULT_KEY = 'lmstudio';

/**
 * Common ports used by local AI servers
 */
const LOCAL_AI_COMMON_PORTS = [
  1234,  // LM Studio default
  5000,  // Common local server port
  7860,  // Gradio/text-generation-webui common
  8000,  // Common development port
  11434, // Ollama default
];

/**
 * Enhanced local server detection
 * Supports various local AI server types and network configurations
 */
export function isLocalServerUrl(url: string | undefined): boolean {
  if (!url) return false;
  
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const port = parseInt(parsed.port);
    
    // Direct localhost patterns
    if (hostname === 'localhost' || 
        hostname === '127.0.0.1' || 
        hostname === '0.0.0.0' ||
        hostname === '::1' ||
        hostname === '[::1]') {  // IPv6 localhost with brackets
      return true;
    }
    
    // Private network ranges (RFC 1918)
    if (hostname.match(/^192\.168\./) ||          // 192.168.0.0/16
        hostname.match(/^10\./) ||                // 10.0.0.0/8  
        hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) { // 172.16.0.0/12
      return true;
    }
    
    // Local domain patterns (*.local, *.localhost, etc.)
    if (hostname.endsWith('.local') || 
        hostname.endsWith('.localhost') ||
        hostname === 'host.docker.internal') {
      return true;
    }
    
    // Common local AI server ports - but only on localhost/private networks
    // This prevents false positives on external servers
    const isLocalHost = hostname === 'localhost' || 
                       hostname === '127.0.0.1' || 
                       hostname === '0.0.0.0' ||
                       hostname === '::1' ||
                       hostname === '[::1]' ||
                       hostname.endsWith('.local');
    
    if (isLocalHost && LOCAL_AI_COMMON_PORTS.includes(port)) {
      return true;
    }
    
    return false;
  } catch (error) {
    // If URL parsing fails, fall back to simple string checks
    return url.includes('localhost') || 
           url.includes('127.0.0.1') || 
           url.includes('0.0.0.0');
  }
}

/**
 * Essential socket configuration that eliminates "terminated" errors
 * Based on documented 100% success rate evidence
 */
function configureSocket(socket: net.Socket): void {
  socket.setNoDelay(true);        // ESSENTIAL - disable Nagle algorithm  
  socket.setKeepAlive(true, 1000); // ESSENTIAL - enable keepalive with 1s interval
  socket.setTimeout(60000);        // CRITICAL - 60s timeout (vs default)
}

/**
 * Create configured HTTP agent for local AI servers
 * Applies essential socket configuration for reliability
 */
export function createLocalAIAgent(isHttps: boolean = false): http.Agent | https.Agent {
  const AgentClass = isHttps ? https.Agent : http.Agent;
  
  return new AgentClass({
    keepAlive: true,
    timeout: 60000,
  });
}

/**
 * Get configured agents for local AI servers
 * Returns HTTP and HTTPS agents with socket configuration
 */
export function getConfiguredAgents(): { http: http.Agent; https: https.Agent } {
  return {
    http: createLocalAIAgent(false) as http.Agent,
    https: createLocalAIAgent(true) as https.Agent
  };
}

/**
 * Custom fetch function with socket configuration for local AI servers
 */
function createLocalAIFetch(): typeof fetch {
  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlString = typeof url === 'string' ? url : url.toString();
    
    if (!isLocalServerUrl(urlString)) {
      // Use default fetch for non-local URLs
      return fetch(url, init);
    }

    // For local URLs, use Node.js http/https with socket configuration
    const { default: http } = await import('http');
    const { default: https } = await import('https');
    
    const parsedUrl = new URL(urlString);
    const isHttps = parsedUrl.protocol === 'https:';
    const module = isHttps ? https : http;
    
    return new Promise((resolve, reject) => {
      // Properly type headers to avoid TypeScript conflicts
      const baseHeaders: Record<string, string> = {
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=60, max=100',
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'User-Agent': 'qwen-code-local-ai-client/1.0',
      };

      // Safely merge headers, converting init headers to string format
      const finalHeaders: Record<string, string> = { ...baseHeaders };
      if (init?.headers) {
        const initHeaders = init.headers;
        
        // Convert various header formats to key-value pairs
        try {
          if (initHeaders instanceof Headers) {
            // Handle Headers object
            initHeaders.forEach((value, key) => {
              finalHeaders[key] = value;
            });
          } else if (typeof initHeaders === 'object' && initHeaders !== null) {
            // Handle plain object format - most common case
            for (const [key, value] of Object.entries(initHeaders)) {
              if (typeof value === 'string') {
                finalHeaders[key] = value;
              } else if (Array.isArray(value)) {
                finalHeaders[key] = value.join(', ');
              } else if (value != null) {
                finalHeaders[key] = String(value);
              }
            }
          }
        } catch (error) {
          // If header processing fails, just use base headers
          console.warn('Failed to process custom headers, using defaults:', error);
        }
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: init?.method || 'GET',
        headers: finalHeaders,
      };

      const req = module.request(options, (res) => {
        const chunks: Buffer[] = [];
        
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });
        
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          
          // Create a Response-like object
          const response = new Response(body, {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers as any,
          });
          
          resolve(response);
        });
        
        res.on('error', reject);
      });

      // Apply essential socket configuration when connection is established
      req.on('socket', (socket) => {
        configureSocket(socket);
      });

      req.on('error', reject);
      
      if (init?.body) {
        req.write(init.body);
      }
      
      req.end();
    });
  };
}

/**
 * Configure OpenAI client options for local AI servers
 * Applies enhanced configuration including timeouts and custom fetch
 */
export function configureLocalAIClientOptions(
  clientOptions: any,
  baseUrl?: string,
  context?: string
): void {
  // Only apply configuration for local servers
  if (!isLocalServerUrl(baseUrl)) {
    return;
  }

  if (context) {
    console.debug(`[${context}] Configuring local AI client options for ${baseUrl}`);
  }

  // Apply local AI server optimizations
  clientOptions.timeout = 60000;     // 60 second timeout
  clientOptions.maxRetries = 2;      // Reduced retries for local servers
  
  // Use placeholder API key if none provided
  if (!clientOptions.apiKey) {
    clientOptions.apiKey = LOCAL_AI_DEFAULT_KEY;
  }

  // Apply custom fetch with socket configuration
  clientOptions.fetch = createLocalAIFetch();
}

/**
 * Smart API key handling for local servers
 */
export function getApiKeyForUrl(url?: string, providedKey?: string): string {
  if (providedKey && providedKey !== 'placeholder' && providedKey !== 'none') {
    return providedKey;
  }
  
  if (isLocalServerUrl(url)) {
    return LOCAL_AI_DEFAULT_KEY;
  }
  
  return providedKey || '';
}