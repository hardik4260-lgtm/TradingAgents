# Cloud deployment on Render

`render.yaml` prepares a Docker web service for the Python MCP engine. It does
not create a Render account, provision a server, provide API credentials, or
configure an OAuth authorization server. The 1 CPU / 2 GB plan is a starting
configuration, not a measured sizing guarantee; review its current paid price in
Render before creating it. LLM API usage and any OAuth hosting costs are separate.

## Deploy the prepared branch

1. Connect your Render account and grant repository access. Create a Blueprint
   from `hardik4260-lgtm/TradingAgents`, selecting `codex/chatgpt-mcp-engine`
   while PR #1 is unmerged, or `main` after merging it. Use `render.yaml`.
2. Review the single-service plan and cost. Configure the requested values in
   Render's secure environment settings. Never put API keys in Git or chat.
3. Set the two model IDs to models actually available in your provider account.
   The supplied Blueprint selects OpenAI; another provider requires changing
   `TRADINGAGENTS_LLM_PROVIDER` and adding that provider's credential variable.
4. Configure a real MCP-compatible OAuth issuer with discovery, authorization
   code/PKCE and the intended client's registration requirements. Supply its
   exact issuer URL, HTTPS JWKS URL and your owner subject ID. Grant the scope
   `tradingagents:analyze`. This engine does not create that issuer for you.
5. Set `TRADINGAGENTS_MCP_RESOURCE_URL` to the **actual assigned** HTTPS service
   URL plus `/mcp`. Bind the OAuth access-token audience to the same exact URL.
   If the URL is only assigned after service creation, set/update this value
   before the first successful deploy. The engine refuses to start without it.
6. Trigger a manual deploy and inspect build/startup logs. The container runs a
   single process, respects Render's `PORT`, and listens on `0.0.0.0`. Render
   terminates HTTPS. Automatic redeploys are disabled to avoid disrupting jobs.
7. Confirm an unauthenticated `/mcp` request gets HTTP 401 and that
   `/.well-known/oauth-protected-resource/mcp` advertises the configured issuer.
   Connect the actual deployed MCP URL in the intended ChatGPT/plugin host and
   complete OAuth login. Call `engine_status`, then test a user-input option
   calculation before starting a provider-billed stock analysis.

No unauthenticated analysis route is provided. The default TCP health check
does not call the paid engine and does not bypass MCP authentication. A passing
health check proves the process is listening, not that OAuth or provider access
works. Those require the connection and engine checks above.

## Persistence and restarts

The prepared Blueprint has no database or persistent disk. Jobs are in memory,
and logs/cache/engine memory use the ephemeral container filesystem. A restart
or redeploy loses them. Do not scale to multiple replicas: job polling would
reach different processes and engine state is not isolated for multiple users.
If durable engine memory is needed, provision a private persistent disk, verify
the non-root `engine` user can write its mount, and configure
`TRADINGAGENTS_RESULTS_DIR`, `TRADINGAGENTS_CACHE_DIR` and
`TRADINGAGENTS_MEMORY_LOG_PATH` under that mount. Disk persistence alone does not
make the job queue durable.

For engine behavior and OAuth verification rules, see [MCP setup](chatgpt-mcp.md).
Live option Greeks/flow and golden-cross premium backtests need additional data
integration and are not implemented by cloud hosting.

Official references:
- https://render.com/docs/blueprint-spec
- https://render.com/docs/health-checks
- https://render.com/docs/configure-environment-variables
- https://render.com/pricing
