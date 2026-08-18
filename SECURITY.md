# Security policy

This repository is an educational system-design practice and must not receive real user data, production credentials, or
confidential incident details.

## Reporting

Open a private GitHub security advisory for vulnerabilities in the repository. Include the affected commit, a minimal synthetic
reproduction, expected versus observed behavior, and impact. Do not include live tokens, database URLs, raw identities, message
content, or third-party confidential data.

Ordinary design disagreements and feature requests may use public issues. Do not rely on this repository for an emergency or a
production system.

## Supported version

Only the current default branch is maintained. No release or production support promise exists.

## Known exclusions

The repository does not provide TLS termination, production authentication, end-to-end encryption, credential storage/rotation,
rate limiting, abuse prevention, backup/restore, disaster recovery, privacy compliance, or deployment hardening. Read the
[threat model](docs/threat-model.md) before running the slice, and use synthetic data only.
