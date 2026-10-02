# ruff: noqa: E402 -- skip optional integration dependencies before importing them
import asyncio
import json
import sys
from datetime import timedelta
from types import SimpleNamespace

import pytest

pytest.importorskip("mcp")
jwt = pytest.importorskip("jwt")

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from starlette.testclient import TestClient

from tradingagents.mcp_server import (
    AnalysisJobs,
    IssuerVerifier,
    build_server,
    option_plan,
    today,
    validate_inputs,
)


def test_long_option_plan():
    expiry = (today() + timedelta(days=10)).isoformat()
    call = option_plan("pltr", "call", 185, expiry, 2, 3)
    assert call["debit_before_fees"] == 600
    assert call["first_profit_review_premium"] == 2.6
    assert call["profit_target_premium"] == 3
    assert call["stop_review_premium"] == 1.5
    assert call["expiration_breakeven"] == 187
    assert call["calendar_dte"] == 10
    put = option_plan("PLTR", "put", 185, today().isoformat(), 2)
    assert put["expiration_breakeven"] == 183
    assert put["time_exit_review"] is True


@pytest.mark.parametrize("premium", [0, -1, float("nan"), float("inf")])
def test_invalid_premium(premium):
    with pytest.raises(ValueError):
        option_plan("PLTR", "call", 185, today().isoformat(), premium)


@pytest.mark.parametrize("ticker,day,analysts", [
    ("../../PLTR", today().isoformat(), ["market"]),
    ("PLTR", (today() + timedelta(days=1)).isoformat(), ["market"]),
    ("PLTR", "2026-1-1", ["market"]),
    ("PLTR", today().isoformat(), []),
    ("PLTR", today().isoformat(), ["market", "market"]),
    ("PLTR", today().isoformat(), ["untrusted"]),
])
def test_validation(ticker, day, analysts):
    with pytest.raises(ValueError):
        validate_inputs(ticker, day, analysts)


def test_job_results_and_owner_isolation():
    jobs = AnalysisJobs(runner=lambda *_: {"rating": "Hold"}, capacity=1)
    job = jobs.start("alice", "PLTR", today().isoformat(), ["market"])
    jobs.executor.shutdown(wait=True)
    assert jobs.get("alice", job["job_id"])["result"] == {"rating": "Hold"}
    with pytest.raises(ValueError, match="not found"):
        jobs.get("bob", job["job_id"])


def test_provider_exception_is_sanitized():
    def runner(*_):
        raise RuntimeError("Authorization: Bearer SUPER_SECRET")
    jobs = AnalysisJobs(runner=runner)
    job = jobs.start("alice", "PLTR", today().isoformat(), ["market"])
    jobs.executor.shutdown(wait=True)
    result = jobs.get("alice", job["job_id"])
    assert result["status"] == "failed"
    assert "SUPER_SECRET" not in str(result)


def test_http_fails_closed_without_oauth(monkeypatch):
    monkeypatch.delenv("TRADINGAGENTS_MCP_ISSUER", raising=False)
    with pytest.raises(ValueError, match="OAuth"):
        build_server(http=True)


def test_oauth_owner_audience_and_expiry(monkeypatch):
    # Exercise real JWT validation without fetching an external JWKS endpoint.
    import time

    from cryptography.hazmat.primitives.asymmetric import rsa

    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    verifier = IssuerVerifier("https://issuer.example/", "https://engine.example/mcp",
                              "https://issuer.example/jwks", "alice")
    monkeypatch.setattr(verifier.jwks, "get_signing_key_from_jwt",
                        lambda _: SimpleNamespace(key=private.public_key()))
    claims = {"iss": verifier.issuer, "aud": verifier.audience, "sub": "alice",
              "exp": int(time.time()) + 600, "scope": "tradingagents:analyze"}

    def verify(overrides):
        return asyncio.run(verifier.verify_token(jwt.encode(claims | overrides, private,
                                                            algorithm="RS256")))

    assert verify({}).subject == "alice"
    assert verify({"aud": "https://another.example/mcp"}) is None
    assert verify({"sub": "bob"}) is None
    assert verify({"exp": 1}) is None


def test_http_requires_authentication(monkeypatch):
    for name, value in {
        "ISSUER": "https://issuer.example/", "RESOURCE_URL": "https://engine.example/mcp",
        "JWKS_URL": "https://issuer.example/jwks", "OWNER_SUBJECT": "alice",
    }.items():
        monkeypatch.setenv("TRADINGAGENTS_MCP_" + name, value)
    server = build_server(http=True)
    with TestClient(server.streamable_http_app(), base_url="https://engine.example") as client:
        result = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1,
                                            "method": "tools/list"})
        assert result.status_code == 401
        assert "resource_metadata" in result.headers["www-authenticate"]
        metadata = client.get("/.well-known/oauth-protected-resource/mcp").json()
        assert metadata["resource"] == "https://engine.example/mcp"


def test_tool_discovery_and_option_call():
    async def check():
        server = build_server()
        tools = await server.list_tools()
        assert {t.name for t in tools} == {
            "engine_status", "analyze_stock", "get_analysis", "analyze_option"}
        result = await server.call_tool("analyze_option", {
            "ticker": "PLTR", "option_type": "call", "strike": 185,
            "expiration": today().isoformat(), "premium": 2,
        })
        assert json.loads(result[0].text)["profit_target_premium"] == 3
    asyncio.run(check())


def test_stdio_client_roundtrip():
    async def check():
        params = StdioServerParameters(command=sys.executable,
                                       args=["-m", "tradingagents.mcp_server"])
        async with stdio_client(params) as (read, write), ClientSession(read, write) as client:
            await client.initialize()
            tools = await client.list_tools()
            assert len(tools.tools) == 4
            status = await client.call_tool("engine_status", {})
            assert not status.isError
            assert json.loads(status.content[0].text)["trade_execution"] is False
            plan = await client.call_tool("analyze_option", {
                "ticker": "PLTR", "option_type": "put", "strike": 185,
                "expiration": today().isoformat(), "premium": 2,
            })
            assert not plan.isError
            assert json.loads(plan.content[0].text)["expiration_breakeven"] == 183
    asyncio.run(check())
