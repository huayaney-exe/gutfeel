# Security policy

gutfeel connects to MCP servers, can start local server processes, and sends text to model providers. We take those risks seriously.

## Reporting a vulnerability

Please **don't open a public issue.** Report privately through [GitHub's private vulnerability reporting](https://github.com/huayaney-exe/gutfeel/security/advisories/new), or by email to **hola@getprisma.lat**.

We acknowledge reports within 72 hours and keep you updated until the issue is fixed. Once the fix ships, we're glad to credit you.

## In scope

- Running arbitrary commands through `gutfeel -- <cmd>` beyond what the user asked for
- Prompt injection from tool descriptions or results that changes what the hands or the reasoner execute
- Live mode running a tool that isn't on the allowlist
- Secrets (tokens, headers, API keys) ending up in contracts, reports, caches or logs
- The hosted scanner being used to reach internal networks (SSRF)

## Design guarantees

The guarantees gutfeel is built to keep are listed in [DESIGN.md §12](docs/DESIGN.md#12-security). Any break in one of them counts as a vulnerability.
