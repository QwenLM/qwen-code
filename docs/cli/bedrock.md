# Amazon Bedrock Support

Qwen Code now supports using Qwen3-Coder models via Amazon Bedrock, allowing you to leverage AWS infrastructure and security policies while using Qwen models.

## Prerequisites

1. **AWS Account** with access to Amazon Bedrock
2. **Model Access**: Request access to Qwen models in the [AWS Bedrock Console](https://console.aws.amazon.com/bedrock/)
3. **AWS Credentials**: Configure AWS credentials on your machine

## Available Models

Amazon Bedrock provides access to Qwen models. Model availability varies by region:

### us-east-1

- `qwen.qwen3-coder-30b-a3b-v1:0` - Qwen3-Coder-30B-A3B-Instruct (code generation)
- `qwen.qwen3-32b-v1:0` - Qwen3 32B dense (general purpose)

### us-west-2

- `qwen.qwen3-coder-480b-a35b-v1:0` - Qwen3 Coder 480B A35B Instruct (code generation)
- `qwen.qwen3-235b-a22b-2507-v1:0` - Qwen3 235B A22B 2507 (general purpose)
- `qwen.qwen3-coder-30b-a3b-v1:0` - Qwen3-Coder-30B-A3B-Instruct (code generation)
- `qwen.qwen3-32b-v1:0` - Qwen3 32B dense (general purpose)

Check the [AWS Bedrock Console](https://console.aws.amazon.com/bedrock/) for the latest available models in your region.

## Setup

### 1. Configure AWS Credentials

Qwen Code uses the standard AWS credential chain. Choose one of the following methods:

#### Option A: Environment Variables

```bash
export AWS_ACCESS_KEY_ID=your_access_key_id
export AWS_SECRET_ACCESS_KEY=your_secret_access_key
export AWS_REGION=us-east-1  # Optional, defaults to us-east-1
```

#### Option B: AWS Profile

```bash
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-east-1  # Optional
```

#### Option C: AWS Credentials File

The AWS SDK will automatically use credentials from `~/.aws/credentials`:

```ini
[default]
aws_access_key_id = your_access_key_id
aws_secret_access_key = your_secret_access_key
region = us-east-1
```

### 2. Select Bedrock in Qwen Code

When starting Qwen Code, select "Amazon Bedrock" from the authentication menu using `/auth` command.

### 3. (Optional) Configure Model

By default, Qwen Code uses `qwen.qwen3-coder-30b-a3b-v1:0` (Qwen3-Coder-30B). You can override this with environment variables or in settings:

```bash
# Via environment variable - use the exact Bedrock model ID
export BEDROCK_MODEL=qwen.qwen3-32b-v1:0
```

```json
// Or in ~/.qwen/settings.json - use the exact Bedrock model ID
{
  "authType": "bedrock",
  "model": "qwen.qwen3-coder-30b-a3b-v1:0"
}
```

## Configuration Options

### Environment Variables

| Variable                | Description              | Default                         |
| ----------------------- | ------------------------ | ------------------------------- |
| `AWS_REGION`            | AWS region for Bedrock   | `us-east-1`                     |
| `AWS_PROFILE`           | Named AWS profile to use | None                            |
| `AWS_ACCESS_KEY_ID`     | AWS access key           | None                            |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key           | None                            |
| `BEDROCK_MODEL`         | Full Bedrock model ID    | `qwen.qwen3-coder-30b-a3b-v1:0` |

**Note**: You must use the exact Bedrock model ID (e.g., `qwen.qwen3-coder-30b-a3b-v1:0`). Model name shortcuts are not supported.
