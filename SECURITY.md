# Security policy

## Reporting a vulnerability

Report privately through
[GitHub security advisories](https://github.com/shaznishiraz/repo-cloak/security/advisories/new).
Do not open a public issue. Include the version, your platform and the steps to reproduce it.
Do not include real source code or secrets.

## Supported versions

Only the latest published 2.x release receives security fixes.

## What repo-cloak protects, and what it does not

It keeps selected names and secrets out of a working copy that you share with an AI agent, using
rules you choose. The local dashboard and stored mappings are protected from other users and from
web pages.

It does not protect against code running as your own user, and it does not prove that a working
copy is clean. See "Security limits" in the [README](README.md) and the
[hardening design](docs/design/hardening-65-enterprise.md).

## Certification

Neither the project nor its maintainers hold ISO/IEC 27001, SOC 2 or similar certification.
