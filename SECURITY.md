# Security Policy

## Supported versions

| Component | Supported |
|---|---|
| Web app and API at [markasso.it](https://markasso.it) | The deployed version (it follows `main`) |
| MCP server [`@markasso/mcp`](https://www.npmjs.com/package/@markasso/mcp) | The latest published release |

Older MCP releases do not get fixes: update with `npx -y @markasso/mcp@latest`.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report it privately through GitHub: [Security > Report a vulnerability](https://github.com/AlbertoBarrago/markasso/security/advisories/new). Include what is affected, how to reproduce it, and the impact you expect.

You can expect an acknowledgement within 3 working days and a first assessment within 7. Once a fix is released, the advisory is published and you are credited, unless you prefer not to be.

## Scope

In scope: the web app, the Cloudflare worker (share links, cloud boards, live sessions, licence checks) and the MCP server in [`mcp/`](mcp/).

Out of scope: denial of service through volume alone, findings that need a compromised device or browser, and issues in third-party services (Cloudflare, Polar, npm) that should go to their vendors.
