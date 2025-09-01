# Code Review Assistant

An AI-powered code review tool built on top of Qwen Code that automatically analyzes code changes, identifies potential issues, and provides actionable suggestions for improvement.

## Features

- **Automated Code Review**: Automatically review code changes in your repository
- **Multiple Input Sources**: Review git diffs, specific files, or pull requests
- **Intelligent Analysis**: Uses Qwen Code's AI capabilities to identify issues and suggest improvements
- **Flexible Output**: Output results in console, JSON, or Markdown formats
- **Dual Interface**: Both command-line and interactive GUI modes
- **Configurable**: Customize review settings and thresholds

## Installation

```bash
# Install dependencies
npm install

# Build the tool
npm run build

# Install globally (optional)
npm install -g .
```

## Usage

### Command Line Interface

```bash
# Review current repository changes
qwen-review review

# Review changes compared to a specific branch
qwen-review review -b develop

# Review specific files
qwen-review review -f src/main.ts,src/utils.ts

# Output in different formats
qwen-review review -o json
qwen-review review -o markdown

# Review a specific diff
qwen-review diff path/to/diff.patch

# Review a pull request
qwen-review pr 123
```

### GUI Mode

```bash
# Launch interactive GUI
qwen-review review -g
```

### Configuration

Create a configuration file at `~/.qwen/code-review.json`:

```json
{
  "maxFileSize": 1048576,
  "excludedPatterns": [
    "node_modules/**",
    "dist/**",
    "*.min.js"
  ],
  "severityThreshold": "medium",
  "outputFormats": ["console", "json", "markdown"],
  "autoFix": false,
  "reviewCategories": [
    "Code Quality",
    "Security",
    "Performance",
    "Maintainability"
  ]
}
```

## Review Categories

The tool analyzes code across several categories:

- **Code Quality**: Style, formatting, and best practices
- **Security**: Potential vulnerabilities and security issues
- **Performance**: Performance bottlenecks and optimization opportunities
- **Maintainability**: Code structure and readability
- **Best Practices**: Industry standards and recommendations

## Output Formats

### Console Output
Rich, colored output with clear categorization of issues and suggestions.

### JSON Output
Structured data for integration with other tools and CI/CD pipelines.

### Markdown Output
Formatted markdown suitable for documentation or pull request comments.

## Integration

### CI/CD Pipelines
```yaml
# GitHub Actions example
- name: Code Review
  run: |
    npm install -g @qwen-code/code-review-assistant
    qwen-review review -o json > review-results.json
```

### Pre-commit Hooks
```bash
#!/bin/sh
# .git/hooks/pre-commit
qwen-review review -o console
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT License - see LICENSE file for details.