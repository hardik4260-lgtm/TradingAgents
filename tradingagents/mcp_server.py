"""ChatGPT/Codex MCP adapter. Provider secrets never enter tool arguments."""

import argparse
import asyncio
import copy
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import uuid4
from zoneinfo import ZoneInfo

import jwt
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations

ANALYSTS = {"market", "news", "social", "fundamentals"}
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)


def today() -> date:
    return datetime.now(ZoneInfo("America/New_York")).date()


def validate_inputs(ticker: str, trade_date: str, analysts: list[str]):
    ticker = ticker.strip().upper()
    if not re.fullmatch(r"[A-Z0-9^][A-Z0-9.\-^=]{0,19}", ticker):
        raise ValueError("Invalid ticker")
    parsed = date.fromisoformat(trade_date)
    if parsed.isoformat() != trade_date or parsed > today():
        raise ValueError("Use YYYY-MM-DD, no later than today in New York")
    if not analysts or len(analysts) != len(set(analysts)) or not set(analysts) <= ANALYSTS:
        raise ValueError("Choose unique analysts from market, news, social, fundamentals")
    return ticker, trade_date, analysts


def option_plan(ticker: str, option_type: str, strike: float, expiration: str,
                premium: float, quantity: int = 1, stop_loss_pct: float = 25,
                profit_target_pct: float = 50) -> dict:
    ticker, _, _ = validate_inputs(ticker, today().isoformat(), ["market"])
    expiry = date.fromisoformat(expiration)
    if expiry.isoformat() != expiration or expiry < today():
        raise ValueError("Expiration must be YYYY-MM-DD, today or later")
    if option_type not in {"call", "put"}:
        raise ValueError("option_type must be call or put")
    numbers = [Decimal(str(v)) for v in (strike, premium, stop_loss_pct, profit_target_pct)]
    if not all(v.is_finite() for v in numbers):
        raise ValueError("Inputs must be finite numbers")
    strike_d, premium_d, stop, target = numbers
    if strike_d <= 0 or premium_d <= 0 or not 0 < stop < 100 or target <= 0:
        raise ValueError("Strike/premium/target must be positive; stop must be between 0 and 100")
    if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 1:
        raise ValueError("Quantity must be a positive integer")
    def money(value):
        return float(value.quantize(Decimal("0.01")))
    dte = (expiry - today()).days
    return {
        "ticker": ticker, "option_type": option_type, "strike": strike,
        "expiration": expiration, "calendar_dte": dte, "entry_premium": premium,
        "quantity": quantity, "contract_multiplier_assumed": 100,
        "debit_before_fees": money(premium_d * 100 * quantity),
        "first_profit_review_premium": money(premium_d * Decimal("1.30")),
        "profit_target_premium": money(premium_d * (1 + target / 100)),
        "stop_review_premium": money(premium_d * (1 - stop / 100)),
        "expiration_breakeven": money(strike_d + premium_d if option_type == "call"
                                     else strike_d - premium_d),
        "time_exit_review": dte <= 3,
        "data_source": "user inputs; no live option quotes",
        "notes": ["Long, standard 100-share option; adjusted contracts are unsupported.",
                  "Targets are review triggers, not placed orders or guaranteed fills.",
                  "Breakeven applies at expiration; excludes fees.",
                  "IV, Greeks, flow, liquidity and contract availability are unverified."],
    }


def run_engine(ticker, trade_date, analysts):
    # Lazy imports let health/options work without constructing LLM clients.
    from tradingagents.default_config import build_default_config
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    config = copy.deepcopy(build_default_config())
    graph = TradingAgentsGraph(selected_analysts=analysts, config=config)
    state, rating = graph.propagate(ticker, trade_date)
    keys = ("market_report", "news_report", "sentiment_report", "fundamentals_report",
            "investment_plan", "trader_investment_plan", "final_trade_decision")
    return {
        "ticker": ticker, "analysis_date": trade_date, "rating": str(rating),
        "reports": {key: state.get(key, "") for key in keys},
        "completed_at": datetime.now(ZoneInfo("UTC")).isoformat(),
        "data_status": "Provider-sourced; freshness varies. Historical runs are not a backtest.",
    }


class AnalysisJobs:
    """Bounded, process-local jobs; serialize engine access to shared config/memory."""

    def __init__(self, runner=run_engine, capacity=32):
        self.runner = runner
        self.capacity = capacity
        self.jobs = {}
        self.lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1)

    def start(self, owner, ticker, trade_date, analysts):
        ticker, trade_date, analysts = validate_inputs(ticker, trade_date, analysts)
        with self.lock:
            if any(j["owner"] == owner and j["status"] in {"queued", "running"}
                   for j in self.jobs.values()):
                raise ValueError("An analysis is already active. Poll it before starting another.")
            if len(self.jobs) >= self.capacity:
                finished = next((k for k, v in self.jobs.items()
                                 if v["status"] in {"completed", "failed"}), None)
                if finished is None:
                    raise ValueError("Analysis queue is full; retry later")
                del self.jobs[finished]
            job_id = str(uuid4())
            self.jobs[job_id] = {"owner": owner, "status": "queued", "ticker": ticker,
                                 "analysis_date": trade_date}
        self.executor.submit(self._run, job_id, ticker, trade_date, analysts)
        return {"job_id": job_id, "status": "queued", "next_tool": "get_analysis"}

    def _run(self, job_id, ticker, trade_date, analysts):
        with self.lock:
            self.jobs[job_id]["status"] = "running"
        try:
            result = self.runner(ticker, trade_date, analysts)
        except Exception:
            # Provider exceptions may contain URLs, headers or secrets; never echo them.
            with self.lock:
                self.jobs[job_id].update(status="failed", error="Analysis failed. Check server configuration, credentials and provider availability.")
        else:
            with self.lock:
                self.jobs[job_id].update(status="completed", result=result)

    def get(self, owner, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None or job["owner"] != owner:
                raise ValueError("Analysis not found")
            return copy.deepcopy({k: v for k, v in job.items() if k != "owner"})


class IssuerVerifier(TokenVerifier):
    """Validate external OAuth JWTs; restrict this private engine to one subject."""

    def __init__(self, issuer, audience, jwks_url, owner_subject):
        self.issuer, self.audience, self.owner_subject = issuer, audience, owner_subject
        self.jwks = jwt.PyJWKClient(jwks_url, timeout=5)

    async def verify_token(self, token):
        def decode():
            key = self.jwks.get_signing_key_from_jwt(token)
            return jwt.decode(token, key.key, algorithms=["RS256"], audience=self.audience,
                              issuer=self.issuer, options={"require": ["exp", "iss", "aud", "sub"]})
        try:
            claims = await asyncio.to_thread(decode)
        except (jwt.PyJWTError, ValueError, OSError):
            return None
        if claims["sub"] != self.owner_subject:
            return None
        scopes = claims.get("scope", "")
        if not isinstance(scopes, str):
            return None
        return AccessToken(token=token, client_id=str(claims.get("client_id", claims["sub"])),
                           subject=claims["sub"], scopes=scopes.split(),
                           expires_at=int(claims["exp"]))


def build_server(http=False):
    kwargs = {}
    if http:
        required = ["TRADINGAGENTS_MCP_ISSUER", "TRADINGAGENTS_MCP_RESOURCE_URL",
                    "TRADINGAGENTS_MCP_JWKS_URL", "TRADINGAGENTS_MCP_OWNER_SUBJECT"]
        missing = [name for name in required if not os.getenv(name)]
        if missing:
            raise ValueError("HTTP requires OAuth configuration: " + ", ".join(missing))
        issuer, resource, jwks_url, subject = [os.environ[name] for name in required]
        from urllib.parse import urlparse
        if any(urlparse(url).scheme != "https" or not urlparse(url).hostname
               for url in (issuer, resource, jwks_url)):
            raise ValueError("Issuer, resource and JWKS URLs must use HTTPS")
        kwargs = {
            "token_verifier": IssuerVerifier(issuer, resource, jwks_url, subject),
            "auth": AuthSettings(issuer_url=issuer, resource_server_url=resource,
                                 required_scopes=["tradingagents:analyze"],
                                 validate_token_resource=False),
            "transport_security": TransportSecuritySettings(
                enable_dns_rebinding_protection=True,
                allowed_hosts=[urlparse(resource).netloc, "127.0.0.1:*", "localhost:*"],
                allowed_origins=[f"https://{urlparse(resource).netloc}"],
            ),
        }
    server = FastMCP("TradingAgents", host=os.getenv("TRADINGAGENTS_MCP_HOST", "127.0.0.1"),
                     port=int(os.getenv("PORT", "8000")), stateless_http=True,
                     json_response=True, **kwargs)
    jobs = AnalysisJobs()

    def owner():
        if not http:
            return "local"
        token = get_access_token()
        if token is None or not token.subject:
            raise ValueError("Authentication required")
        return token.subject

    @server.tool(annotations=READ_ONLY)
    def engine_status() -> dict:
        """Check configuration without exposing keys or starting paid analyses."""
        owner()
        from tradingagents.default_config import build_default_config
        from tradingagents.llm_clients.api_key_env import get_api_key_env
        config = build_default_config()
        env_name = get_api_key_env(config["llm_provider"])
        return {"provider": config["llm_provider"], "quick_model": config["quick_think_llm"],
                "deep_model": config["deep_think_llm"],
                "provider_key_present": bool(os.getenv(env_name)) if env_name else None,
                "connectivity_verified": False, "trade_execution": False,
                "job_storage": "In memory; restart loses jobs; oldest completed jobs may be evicted"}

    @server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False,
                                           idempotentHint=False, openWorldHint=True))
    def analyze_stock(ticker: str, analysis_date: str | None = None,
                      analysts: list[str] | None = None) -> dict:
        """Start a provider-billed stock analysis. Poll get_analysis with returned job_id.

        Dates default to today in New York. Uses server-configured models and keys.
        Never places orders. Historical analysis alone is not a valid backtest.
        """
        return jobs.start(owner(), ticker, analysis_date or today().isoformat(),
                          analysts if analysts is not None else ["market", "news", "fundamentals"])

    @server.tool(annotations=READ_ONLY)
    def get_analysis(job_id: str) -> dict:
        """Read your queued/running/completed analysis; preserve data freshness caveats."""
        return jobs.get(owner(), job_id)

    @server.tool(annotations=READ_ONLY)
    def analyze_option(ticker: str, option_type: Literal["call", "put"], strike: float,
                       expiration: str, premium: float, quantity: int = 1,
                       stop_loss_pct: float = 25, profit_target_pct: float = 50) -> dict:
        """Calculate a long-option plan from user inputs; not live contract analysis.

        Combine with analyze_stock/get_analysis for the underlying thesis. Do not
        infer IV, Greeks, buying/selling flow or confidence scores from this output.
        """
        owner()
        return option_plan(ticker, option_type, strike, expiration, premium, quantity,
                           stop_loss_pct, profit_target_pct)

    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--transport", choices=["stdio", "streamable-http"], default="stdio")
    args = parser.parse_args()
    server = build_server(http=args.transport == "streamable-http")
    server.run(transport=args.transport)


if __name__ == "__main__":
    main()
