# TradingAgents in ChatGPT or Codex

This adapter runs the actual `TradingAgentsGraph`, rather than reproducing its
prompts in chat. It provides four MCP tools:

| Tool | Purpose |
| --- | --- |
| `engine_status` | Report model configuration and key presence; no secrets or paid calls |
| `analyze_stock` | Queue a stock analysis using server-configured LLMs and data vendors |
| `get_analysis` | Poll your job and retrieve the engine's rating and reports |
| `analyze_option` | Calculate a long-option plan from your contract inputs |

The adapter never places orders. `analyze_stock` can incur LLM provider charges.
The options calculation does not fetch quotes, IV, Greeks or option flow, verify
listed contracts, or invent a confidence score. Supply a real expiration date;
calendar DTE alone does not prove a listed contract exists. A past-date stock
analysis is not a premium-series options backtest.

## Local smoke test

From the repository, with Python 3.11 or newer:

```bash
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
python -m pip install -e ".[mcp]"
tradingagents-mcp
```

This starts stdio MCP for a local MCP client, not a public ChatGPT endpoint.
Configure your client to launch the absolute path to the installed
`tradingagents-mcp` executable. It uses the same environment and `.env` loading
as the CLI. Set provider/model variables according to `.env.example`; configure
model IDs available to your provider account. No provider credentials belong in
tool arguments or plugin source. `engine_status` checks presence only; it does
not verify provider access or model availability.

Example tool arguments:

```json
{"ticker":"PLTR","analysts":["market","news","fundamentals"]}
```

Call `analyze_stock`, retain its `job_id`, then call `get_analysis` until completed
or failed. Poll at reasonable intervals (for example 5–10 seconds); avoid tight
loops. Preserve the engine's exact rating, supporting reports, dates and caveats.

For a long PLTR call purchased at $2.00, `analyze_option` returns a first +30%
review level of $2.60, a default +50% target of $3.00 and a default -25% stop
review level of $1.50. These are user-adjustable review triggers. They do not
create orders or ensure fills, and the stock rating is not an options signal.

## Remote ChatGPT/plugin connection

The engine requires a Python runtime. A static website or a JavaScript Worker
alone cannot run its Python/LangGraph dependencies. Host this repository on a
Python-capable server/container with outbound access to the selected providers
and vendors, behind an HTTPS reverse proxy.

HTTP mode fails closed unless all four settings exist:

```env
TRADINGAGENTS_MCP_ISSUER=https://your-oauth-issuer.example/
TRADINGAGENTS_MCP_RESOURCE_URL=https://your-engine.example/mcp
TRADINGAGENTS_MCP_JWKS_URL=https://your-oauth-issuer.example/jwks
TRADINGAGENTS_MCP_OWNER_SUBJECT=your-user-subject-from-the-issuer
```

These are placeholders, not working endpoints. Use an actual OAuth authorization
server compatible with the intended MCP host. Configure its discovery,
authorization-code/PKCE flow and supported client registration. This adapter is
an OAuth resource server, not a login provider: it advertises the issuer through
protected-resource metadata and verifies RS256 JWT signatures, expiration,
issuer, audience and owner subject. Tokens need the `tradingagents:analyze` scope
and an audience exactly equal to `TRADINGAGENTS_MCP_RESOURCE_URL`. Only the
configured owner can use the engine; adding more users requires isolating
engine memory, caches, logs and credentials per user.

Start the server:

```bash
tradingagents-mcp --transport streamable-http
```

It listens on `127.0.0.1:8000` by default. For a container set
`TRADINGAGENTS_MCP_HOST=0.0.0.0` and restrict network access to the reverse proxy;
set `PORT` when needed. Forward the original public Host header and expose
`/mcp` and `/.well-known/oauth-protected-resource/mcp`. Keep HTTPS termination
and the issuer available. Configure provider credentials as host secrets.
Provider API keys remain on the server and are separate from OAuth access tokens.

`Dockerfile.mcp` is a Python container entry point:

```bash
docker build -f Dockerfile.mcp -t tradingagents-mcp .
# Use your hosting provider's secret injection for the required runtime values.
```

Connect the **verified deployed** HTTPS `/mcp` endpoint through your ChatGPT
plugin/app's supported remote MCP connection flow, then complete issuer login.
This source change does not publish a server, create/install a ChatGPT plugin,
or supply an LLM API key. Check discovery and call `engine_status` after connecting
before starting a paid analysis. If a host requires capabilities your issuer
does not offer, complete that OAuth integration before exposing analysis.

## Operational limits

- Use **one server process/replica**. Jobs are process-local, bounded to 32 retained
  entries, with one running engine task at a time. Restart loses jobs. Oldest
  finished entries are evicted at capacity. There is no durable queue or cancel
  endpoint; provider timeouts and billing limits should be configured on the host.
- Each owner can have only one queued/running analysis. Shared engine configuration
  and memory are serialized. Engine logs/cache/memory remain on the server's
  filesystem and should use a private persistent volume.
- Provider errors return a sanitized failure instead of raw exception text.
  Protect server logs and the host filesystem; upstream libraries may write logs.
- Ratings and reports are generated analysis, not guaranteed forecasts. Market
  freshness depends on vendors; preserve timestamps and label missing data.
- Golden-cross option backtests, live flow classification, contract comparison,
  and unattended alerts require additional data/workflows and are not implemented
  by this adapter.

## Verification

```bash
python -m pip install -e ".[mcp,dev]"
python -m pytest tests/test_mcp_server.py
ruff check tradingagents/mcp_server.py tests/test_mcp_server.py
```

The tests cover option arithmetic, input validation, job ownership, failure
sanitization, OAuth validation, unauthenticated HTTP rejection, tool discovery
and option tool execution. A full paid engine run and ChatGPT OAuth handshake
require a configured provider account, actual issuer and deployed server.
