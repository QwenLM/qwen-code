/**
 * Simple Timeout Analysis for Streaming API
 * 
 * This file provides a simple approach to understanding and solving
 * the streaming API timeout issue in Qwen Code.
 */

// Simple function to enhance timeout error messages
export function enhanceTimeoutErrorMessage(
  baseMessage: string,
  requestSize?: number,
  complexity?: number
): string {
  let enhancedMessage = `${baseMessage}\n\nStreaming setup timeout troubleshooting:`;
  
  // Add general troubleshooting tips
  enhancedMessage += "\n- Reduce input length or complexity";
  enhancedMessage += "\n- Increase timeout in config: contentGenerator.timeout";
  enhancedMessage += "\n- Check network connectivity and firewall settings";
  enhancedMessage += "\n- Consider using non-streaming mode for very long inputs";
  
  // Add size-specific recommendations
  if (requestSize && requestSize > 100) {
    enhancedMessage += `\n\nAdditional recommendations for large requests (${requestSize} MB):`;
    enhancedMessage += "\n- Consider breaking your request into smaller chunks";
    enhancedMessage += "\n- Use progressive summarization for context";
    enhancedMessage += "\n- Enable checkpointing if available";
  }
  
  // Add complexity-specific recommendations
  if (complexity && complexity > 7) {
    enhancedMessage += `\n\nAdditional recommendations for complex requests (complexity ${complexity}/10):`;
    enhancedMessage += "\n- Simplify request structure if possible";
    enhancedMessage += "\n- Use more specific prompts";
    enhancedMessage += "\n- Consider using tool-based approaches for complex tasks";
  }
  
  // Add configuration suggestions
  enhancedMessage += "\n\nConfiguration suggestions:";
  enhancedMessage += "\n- Set contentGenerator.timeout to at least 120000ms for large requests";
  enhancedMessage += "\n- Consider setting contentGenerator.maxRetries to 3 for retry behavior";
  enhancedMessage += "\n- Monitor system resources during long-running requests";
  
  return enhancedMessage;
}

// Simple function to suggest timeout configuration
export function suggestTimeoutConfig(
  requestSize?: number,
  complexity?: number
): number {
  // Start with base timeout
  let suggestedTimeout = 64000; // 64 seconds
  
  // Increase timeout based on request characteristics
  if (requestSize) {
    // Add 1 second per 10 MB of data
    suggestedTimeout += Math.min(requestSize * 100, 200000); // Cap at 200 seconds additional
  }
  
  if (complexity) {
    // Add 2 seconds per complexity unit
    suggestedTimeout += Math.min(complexity * 2000, 100000); // Cap at 100 seconds additional
  }
  
  // Ensure minimum timeout
  suggestedTimeout = Math.max(suggestedTimeout, 64000);
  
  // Cap at reasonable maximum
  suggestedTimeout = Math.min(suggestedTimeout, 300000); // Cap at 5 minutes
  
  return suggestedTimeout;
}