# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `main` (latest snapshot) | Yes |
| Older tags / forks | Best-effort only |

This repository is an open snapshot. Security fixes land on `main` first.

## Reporting a vulnerability

Please report vulnerabilities privately to the repository maintainers through
GitHub's private vulnerability reporting feature. Do not open a public issue
containing credentials, personal data, exploit details, or production
infrastructure information.

Include the affected version, reproducible steps, expected impact, and any
suggested mitigation. Maintainers will acknowledge a complete report as soon
as practical and coordinate disclosure after a fix is available.

## Deployment responsibilities

This project includes administrative, SSH, cloud-account, billing, and remote
execution features. Operators are responsible for:

- replacing every example secret before deployment;
- keeping `.env`, encryption keys, database backups, and cloud credentials out
  of source control;
- enforcing HTTPS, network access controls, and least-privilege accounts;
- reviewing third-party integrations before enabling them;
- applying dependency and container-image updates.

Example configuration values are not suitable for production.
