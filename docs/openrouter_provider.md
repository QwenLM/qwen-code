# OpenRouter Provider Support

This feature adds support for OpenRouter's provider preferences, allowing you to control how your requests are routed across different AI model providers.

## Configuration

### Environment Variables

You can configure provider preferences using environment variables:

```bash
# Provider order - comma-separated list of provider slugs
OPENROUTER_PROVIDER_ORDER=anthropic,openai,deepinfra

# Allow fallbacks to other providers (true/false)
OPENROUTER_ALLOW_FALLBACKS=true

# Require providers to support all parameters (true/false)
OPENROUTER_REQUIRE_PARAMETERS=false

# Data collection preference (allow/deny)
OPENROUTER_DATA_COLLECTION=allow

# Only use these providers - comma-separated list
OPENROUTER_PROVIDER_ONLY=anthropic,openai

# Ignore these providers - comma-separated list
OPENROUTER_PROVIDER_IGNORE=deepinfra

# Quantization levels - comma-separated list (int4, int8, fp4, fp6, fp8, fp16, bf16, fp32)
OPENROUTER_QUANTIZATIONS=fp16,bf16

# Sort providers by (price/throughput/latency)
OPENROUTER_SORT=throughput

# Maximum price constraints (JSON format)
OPENROUTER_MAX_PRICE='{"prompt": 1, "completion": 2}'
```

### Configuration File

You can also configure provider preferences in your settings.json or when initializing the Config:

```javascript
const config = new Config({
  // ... other config options
  providerPreferences: {
    order: ['anthropic', 'openai'],
    allow_fallbacks: true,
    require_parameters: false,
    data_collection: 'allow',
    only: ['anthropic', 'openai'],
    ignore: ['deepinfra'],
    quantizations: ['fp16', 'bf16'],
    sort: 'throughput',
    max_price: {
      prompt: 1,
      completion: 2
    }
  }
});
```

## How It Works

When using the OpenAI auth type with OpenRouter, the provider preferences are automatically included in the API request body as a `provider` object. This allows OpenRouter to route your requests according to your preferences.

### Priority

1. Environment variables take precedence over configuration file settings
2. Any provider preferences set will be included in requests to OpenRouter
3. If no preferences are set, OpenRouter will use its default routing strategy

## Examples

### Prioritize Specific Providers

```bash
# Use Anthropic first, then OpenAI, with no fallbacks
OPENROUTER_PROVIDER_ORDER=anthropic,openai
OPENROUTER_ALLOW_FALLBACKS=false
```

### Optimize for Performance

```bash
# Sort by throughput for fastest responses
OPENROUTER_SORT=throughput
```

### Budget Constraints

```bash
# Limit costs to $1 per million prompt tokens, $2 per million completion tokens
OPENROUTER_MAX_PRICE='{"prompt": 1, "completion": 2}'
OPENROUTER_SORT=price
```

### Privacy-Focused

```bash
# Only use providers that don't collect data
OPENROUTER_DATA_COLLECTION=deny
```

### Specific Quantization

```bash
# Only use FP16 or BF16 models
OPENROUTER_QUANTIZATIONS=fp16,bf16
```

## Shortcuts

The implementation also supports OpenRouter's shortcuts:

- Append `:nitro` to model names to sort by throughput
- Append `:floor` to model names to sort by price

These shortcuts work automatically without any additional configuration.