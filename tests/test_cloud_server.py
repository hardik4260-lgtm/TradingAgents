# ruff: noqa: E402 -- optional dependency checks precede application imports
import pytest

pytest.importorskip("mcp")
pytest.importorskip("jwt")
from starlette.testclient import TestClient

from tradingagents.cloud_server import OAUTH_SETTINGS, create_app


def test_setup_mode_blocks_analysis(monkeypatch):
    for key in OAUTH_SETTINGS:
        monkeypatch.delenv(key, raising=False)
    with TestClient(create_app()) as client:
        assert client.get("/health").json()["analysis_enabled"] is False
        assert client.get("/").status_code == 200
        assert client.post("/mcp", json={"method": "tools/call"}).status_code == 503
        assert client.get("/private-data").status_code == 503


def test_configured_mode_requires_oauth(monkeypatch):
    values = ("https://issuer.example/", "https://engine.example/mcp",
              "https://issuer.example/jwks", "alice")
    for key, value in zip(OAUTH_SETTINGS, values, strict=True):
        monkeypatch.setenv(key, value)
    with TestClient(create_app(), base_url="https://engine.example") as client:
        assert client.get("/health").status_code == 200
        assert client.post("/mcp", json={"method": "tools/list"}).status_code == 401
