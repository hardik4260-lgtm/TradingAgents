"""Cloud entry point: safe setup status until OAuth settings are supplied."""

import os

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route

from tradingagents.mcp_server import build_server

OAUTH_SETTINGS = (
    "TRADINGAGENTS_MCP_ISSUER",
    "TRADINGAGENTS_MCP_RESOURCE_URL",
    "TRADINGAGENTS_MCP_JWKS_URL",
    "TRADINGAGENTS_MCP_OWNER_SUBJECT",
)


def create_app():
    missing = [name for name in OAUTH_SETTINGS if not os.getenv(name)]
    if missing:
        async def health(request):
            return JSONResponse({"status": "setup_required", "analysis_enabled": False})

        async def setup(request):
            return PlainTextResponse(
                "TradingAgents server is online. OAuth configuration is required. "
                "Set the OAuth settings in Render, then restart. Analysis is disabled."
            )

        async def blocked(request):
            return JSONResponse({"error": "Authentication configuration required"},
                                status_code=503)

        return Starlette(routes=[Route("/", setup), Route("/health", health),
                                 Route("/mcp", blocked, methods=["GET", "POST", "DELETE"]),
                                 Route("/{path:path}", blocked, methods=["GET", "POST", "DELETE"])])

    server = build_server(http=True)

    @server.custom_route("/health", methods=["GET"])
    async def health(request):
        # Liveness only: neither tests provider access nor starts a paid analysis.
        return JSONResponse({"status": "online", "authentication_required": True})

    return server.streamable_http_app()


def main():
    uvicorn.run(create_app(), host=os.getenv("TRADINGAGENTS_MCP_HOST", "0.0.0.0"),
                port=int(os.getenv("PORT", "8000")))


if __name__ == "__main__":
    main()
