# Provider Structure

This folder contains the different provider implementations for the Qwen Code refactor system.

## File Structure

- `constants.ts` - Common constants used across all providers
- `types.ts` - Type definitions and interfaces for providers
- `default.ts` - Default provider for standard OpenAI-compatible APIs
- `dashscope.ts` - DashScope (Qwen) specific provider implementation
- `openrouter.ts` - OpenRouter specific provider implementation
- `index.ts` - Main export file for all providers

## Provider Types

### Default Provider

The `DefaultOpenAICompatibleProvider` is the fallback provider for standard OpenAI-compatible APIs. It provides basic functionality without special enhancements and passes through all request parameters.

### DashScope Provider

The `DashScopeOpenAICompatibleProvider` handles DashScope (Qwen) specific features like cache control and metadata.

### OpenRouter Provider

The `OpenRouterOpenAICompatibleProvider` handles OpenRouter specific headers and configurations.

## Adding a New Provider

To add a new provider:

1. Create a new file (e.g., `newprovider.ts`) in this folder
2. Implement the `OpenAICompatibleProvider` interface
3. Add a static method to identify if a config belongs to this provider
4. Export the class from `index.ts`
5. The main `provider.ts` file will automatically re-export it

## Provider Interface

All providers must implement:

- `buildHeaders()` - Build HTTP headers for the provider
- `buildClient()` - Create and configure the OpenAI client
- `buildRequest()` - Transform requests before sending to the provider

## Example

```typescript
export class NewProviderOpenAICompatibleProvider
  implements OpenAICompatibleProvider
{
  // Implementation...

  static isNewProviderProvider(
    contentGeneratorConfig: ContentGeneratorConfig,
  ): boolean {
    // Logic to identify this provider
    return true;
  }
}
```
