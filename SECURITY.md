# Security policy

Security fixes target the current default branch. This is a personal project
with best-effort maintenance; older snapshots do not have separate support
windows. Operators need to update their own instances.

## Report a vulnerability

Use this repository's **Security → Advisories → Report a vulnerability** form
when it is available. This sends the report privately to the maintainers.
If the form is unavailable, open an issue titled **Private security contact
requested** with no vulnerability details; ask the maintainer for a private
reporting channel. GitHub documents both paths in its
[private reporting guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

In the private report, include the affected revision, impact, reproduction
steps and a minimal example using synthetic data. Redact credentials and
personal information. Keep exploit details, refresh/session tokens, env files
and database exports out of public issues and pull requests. If you exposed a
real credential, rotate it with its provider.

Please give the maintainer a chance to investigate and prepare a fix before
publishing details. There is no guaranteed response deadline or bug bounty.

## Security design and checks

- [Application security](docs/application-security.md): owner authorization,
  OAuth browser binding, request limits, deadlines and browser policy.
- [Publication checks](docs/security-checks.md): credentials, private paths,
  Git history and exact release-artifact scans.
- [Dependency guidance](docs/dependencies.md): toolchain updates and auditing.

GitHub's private-reporting feature must be enabled by the repository owner
when the public repository is created; this file alone does not enable it.
