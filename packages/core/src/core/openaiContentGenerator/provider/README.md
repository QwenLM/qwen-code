# Provider Structure

This folder contains the different provider implementations for the Qwen Code refactor system.

## File Structure

- `constants.ts` - Common constants used across all providers
- `types.ts` - Type definitions and interfaces for providers
- `default.ts` - Default provider for standard OpenAI-compatible APIs
- `dashscope.ts` - DashScope (Qwen) specific provider implementation
- `index.ts` - Main export file for all providers

## Provider Types

### Default Provider

The `DefaultOpenAICompatibleProvider` is the fallback provider for standard OpenAI-compatible APIs. It provides basic functionality without special enhancements and passes through all request parameters. It also merges `customHeaders` from `ContentGeneratorConfig`, which is how providers like OpenRouter and Requesty declare their attribution headers — via `customHeaders` in their preset `ProviderConfig`, no provider class needed.

### DashScope Provider

The `DashScopeOpenAICompatibleProvider` handles DashScope (Qwen) specific features like cache control and metadata.

## When to create a new provider class

Only create a new provider class when the provider has **request-level behavioral differences** (e.g., custom `buildRequest` logic, cache control injection, response transformation). Providers that only need custom HTTP headers should declare them via `customHeaders` in their `ProviderConfig` preset — the `DefaultOpenAICompatibleProvider` already merges `customHeaders` into outgoing requests.

## Adding a New Provider

To add a new provider with only header differences:

1. Add a preset in `packages/core/src/providers/presets/`
2. Set `customHeaders` in the preset config
3. Register it in `all-providers.ts` and `index.ts`

To add a new provider with request-level behavioral differences:

1. Create a new file (e.g., `newprovider.ts`) in this folder
2. Extend `DefaultOpenAICompatibleProvider`
3. Override `buildRequest()` or `buildClient()` as needed
4. Add a static method to identify if a config belongs to this provider
5. Export the class from `index.ts`
6. Add dispatch logic in `openaiContentGenerator/index.ts`

## Provider Interface

All providers must implement:

- `buildHeaders()` - Build HTTP headers for the provider
- `buildClient()` - Create and configure the OpenAI client
- `buildRequest()` - Transform requests before sending to the provider
