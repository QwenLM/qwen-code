# Qwen Code: Terms of Service and Privacy Notice

Qwen Code is an open-source AI coding assistant tool maintained by the Qwen Code team. This document outlines the terms of service and privacy policies that apply when using Qwen Code's authentication methods and AI model services.

## How to determine your authentication method

Qwen Code supports four authentication methods to access AI models. Your authentication method determines which terms of service and privacy policies apply to your usage:

1. **Qwen OAuth** — Log in with your qwen.ai account (free tier discontinued 2026-04-15)
2. **Alibaba Cloud Coding Plan** — Use an API key from Alibaba Cloud
3. **API Key** — Bring your own API key
4. **Vertex AI** — Use Google Cloud Vertex AI

For each authentication method, different Terms of Service and Privacy Notices may apply depending on the underlying service provider.

| Authentication Method     | Provider          | Terms of Service                                                   | Privacy Notice                                                     |
| :------------------------ | :---------------- | :----------------------------------------------------------------- | :----------------------------------------------------------------- |
| Qwen OAuth                | Qwen AI           | [Qwen Terms of Service](https://qwen.ai/termsservice)              | [Qwen Privacy Policy](https://qwen.ai/privacypolicy)               |
| Alibaba Cloud Coding Plan | Alibaba Cloud     | See [details below](#2-if-you-are-using-alibaba-cloud-coding-plan) | See [details below](#2-if-you-are-using-alibaba-cloud-coding-plan) |
| API Key                   | Various Providers | Depends on your chosen API provider (OpenAI, Anthropic, etc.)      | Depends on your chosen API provider                                |
| Vertex AI                 | Google Cloud      | [Google Cloud Terms](https://cloud.google.com/terms)               | [Google Cloud Privacy](https://cloud.google.com/privacy)           |

## 1. If you are using Qwen OAuth Authentication

When you authenticate using your qwen.ai account, these Terms of Service and Privacy Notice documents apply:

- **Terms of Service:** Your use is governed by the [Qwen Terms of Service](https://qwen.ai/termsservice).
- **Privacy Notice:** The collection and use of your data is described in the [Qwen Privacy Policy](https://qwen.ai/privacypolicy).

For details about authentication setup, quotas, and supported features, see [Authentication Setup](../configuration/settings).

## 2. If you are using Alibaba Cloud Coding Plan

When you authenticate using an API key from Alibaba Cloud, the applicable Terms of Service and Privacy Notice from Alibaba Cloud apply.

Alibaba Cloud Coding Plan is available in two regions:

- **阿里云百炼 (aliyun.com)** — [bailian.console.aliyun.com](https://bailian.console.aliyun.com)
- **Alibaba Cloud (alibabacloud.com)** — [bailian.console.alibabacloud.com](https://bailian.console.alibabacloud.com)

> [!important]
>
> When using Alibaba Cloud Coding Plan, you are subject to Alibaba Cloud's terms and privacy policies. Please review their documentation for specific details about data usage, retention, and privacy practices.

## 3. If you are using your own API Key

When you authenticate using API keys from other providers, the applicable Terms of Service and Privacy Notice depend on your chosen provider.

> [!important]
>
> When using your own API key, you are subject to the terms and privacy policies of your chosen API provider, not Qwen Code's terms. Please review your provider's documentation for specific details about data usage, retention, and privacy practices.

Qwen Code supports various OpenAI-compatible providers. Please refer to your specific provider's terms of service and privacy policy for detailed information.

## 4. If you are using Vertex AI

When you authenticate with Google Cloud Vertex AI, the applicable Terms of Service and Privacy Notice are Google Cloud's.

> [!important]
>
> When using Vertex AI, you are subject to [Google Cloud's Terms of Service](https://cloud.google.com/terms) and [Google Cloud Privacy Notice](https://cloud.google.com/privacy), not Qwen Code's terms. Please review Google Cloud's documentation for specific details about data usage, retention, and privacy practices.

## Chrome extension and Browser Use

The Qwen Code Chrome extension connects Chrome to Qwen Code running on your computer. Its side panel displays the local Qwen Code web application, and Browser Use exchanges browser commands and results through a local Native Messaging host. The following describes data handled for browser tasks, separately from the optional usage statistics described below.

### Browser data used for your tasks

Browser tools can access open HTTP(S) tab titles and URLs, page text and structure, screenshots, browser interaction results, and debugging information such as console messages, network activity, and cookies. Explicit browser-history searches return matching URLs, page titles, and visit times within the requested query limits. Depending on the pages and tasks you choose, these results may contain personal identifiers, health information, financial or payment information, authentication information, personal communications, and location information. The extension also uses navigation-source information to associate new pages opened by a recent assistant action with the same browser session.

These capabilities support the browser tasks and web development work you request from Qwen Code. Browser tools operate in your Chrome profile, including pages where you are signed in. Choose the pages and tasks you share with the assistant accordingly.

### Local processing and AI providers

The extension sends browser commands and results to Qwen Code on the same computer. Qwen Code may include those results in conversation context and transmit them to the AI provider configured for that session. The provider's privacy, retention, and model-training terms apply as described elsewhere in this notice. The extension's local connection is one part of this data flow; subsequent processing may take place at your chosen AI provider.

### Stored data and user controls

The extension stores connection preferences, an optional local daemon authentication token, and a persistent browser-instance identifier in Chrome extension local storage. It also stores tab and session ownership state in Chrome session storage to support cleanup after its background service worker restarts.

Browser results included in Qwen Code conversations or saved by browser tools may remain in local conversation records, screenshots, downloads, or other output files. Manage these records using the applicable Qwen Code and filesystem controls. AI-provider retention is governed separately by the selected provider.

You can disable or uninstall the Chrome extension in Chrome's extension manager to stop its browser integration. Clearing extension storage removes its saved preferences, token, and instance identifier. Removing the extension leaves the separately installed Qwen Code application, its Native Messaging host, local conversations and files, and copies already sent to an AI provider to be managed separately.

### Limited use of browser data

Qwen Code's use and transfer of data received through the Chrome extension adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data), including its Limited Use requirements. Browser data is used to provide the extension's single purpose: connecting Chrome to Qwen Code for user-requested browser assistance. It is not sold, used for advertising, or used to determine creditworthiness or lending eligibility. Transfers are limited to providing that functionality, including processing by the AI provider you configure, and other uses permitted by that policy.

For questions about browser data handling, contact the team through the [Qwen Code issue tracker](https://github.com/QwenLM/qwen-code/issues). Share only the details needed to explain the question; remove credentials and private page content from public reports.

## Usage Statistics and Telemetry

Qwen Code may collect anonymous usage statistics and [telemetry](../../developers/development/telemetry) data to improve the user experience and product quality. This data collection is optional and can be controlled through configuration settings.

### What Data is Collected

When enabled, Qwen Code may collect:

- Anonymous usage statistics (commands run, performance metrics)
- Error reports and crash data
- Feature usage patterns

### Data Collection by Authentication Method

- **Qwen OAuth:** Usage statistics are governed by Qwen's privacy policy. You can opt-out through Qwen Code's configuration settings.
- **Alibaba Cloud Coding Plan:** Usage statistics are governed by Alibaba Cloud's privacy policy. You can opt-out through Qwen Code's configuration settings.
- **API Key:** No additional data is collected by Qwen Code beyond what your chosen API provider collects.
- **Vertex AI:** Usage statistics are governed by Google Cloud's privacy policy. No additional data is collected by Qwen Code beyond what Google Cloud collects.

## Frequently Asked Questions (FAQ)

### 1. Is my code, including prompts and answers, used to train AI models?

Whether your code, including prompts and answers, is used to train AI models depends on your authentication method and the specific AI service provider you use:

- **Qwen OAuth**: Data usage is governed by [Qwen's Privacy Policy](https://qwen.ai/privacypolicy). Please refer to their policy for specific details about data collection and model training practices.

- **Alibaba Cloud Coding Plan**: Data usage is governed by Alibaba Cloud's privacy policy. Please refer to their policy for specific details about data collection and model training practices.

- **API Key**: Data usage depends entirely on your chosen API provider. Each provider has their own data usage policies. Please review the privacy policy and terms of service of your specific provider.

- **Vertex AI**: Data usage is governed by [Google Cloud's Terms of Service](https://cloud.google.com/terms) and [Privacy Notice](https://cloud.google.com/privacy). Please review Google Cloud's policies for specific details about data collection and model training practices.

**Important**: Qwen Code itself does not use your prompts, code, or responses for model training. Any data usage for training purposes would be governed by the policies of the AI service provider you authenticate with.

### 2. What are Usage Statistics and what does the opt-out control?

The **Usage Statistics** setting controls optional data collection by Qwen Code for improving the user experience and product quality.

When enabled, Qwen Code may collect:

- Anonymous telemetry (commands run, performance metrics, feature usage)
- Error reports and crash data
- General usage patterns

**What is NOT collected as usage statistics:**

- Your code content
- Prompts sent to AI models
- Responses from AI models
- Personal information

The Usage Statistics setting only controls data collection by Qwen Code itself. It does not affect what data your chosen AI service provider (Qwen, OpenAI, etc.) may collect according to their own privacy policies.

### 3. How do I switch between authentication methods?

You can switch between Qwen OAuth, Alibaba Cloud Coding Plan, your own API key, and Vertex AI at any time:

1. **During startup**: Choose your preferred authentication method when prompted
2. **Within the CLI**: Use the `/auth` command to reconfigure your authentication method
3. **Environment variables**: Set up `.env` files for automatic API key authentication

For detailed instructions, see the [Authentication Setup](../configuration/auth.md) documentation.
