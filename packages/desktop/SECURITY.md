# Security Policy

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in OpenWork, please report it responsibly.

### How to Report

Please do not publish exploit details in public GitHub issues.

OpenWork does not currently maintain a dedicated security email address. If GitHub private vulnerability reporting is available for this repository, use that channel. Otherwise, open a minimal public issue that requests maintainer contact without including exploit details, secrets, or proof-of-concept code.

Include the following information:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any suggested fixes (optional)

### What to Expect

Maintainers will review reports on a best-effort basis. Response and resolution timelines depend on maintainer availability and the severity of the issue.

### Scope

This policy applies to:

- The OpenWork desktop application
- OpenWork server and shared packages
- Official OpenWork repositories

### Out of Scope

- Third-party dependencies (report to their maintainers)
- Social engineering attacks
- Denial of service attacks

## Supported Versions

| Version  | Supported          |
| -------- | ------------------ |
| Latest   | :white_check_mark: |
| < Latest | :x:                |

We currently provide security updates for the latest version only. Please keep your installation up to date.

## Security Best Practices

When using OpenWork:

1. **Keep credentials secure**: Never commit `.env` files or credentials
2. **Use environment variables**: Store secrets in environment variables
3. **Review permissions**: Be cautious with "Execute" permission mode
4. **Update regularly**: Keep the application updated

## Acknowledgments

We appreciate responsible disclosure and will acknowledge security researchers who report valid vulnerabilities (with their permission).
