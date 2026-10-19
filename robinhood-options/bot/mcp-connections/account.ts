import { defineConnection } from "@cursor/bdk/connections";

const READ_TOOLS = [
  "get_accounts",
  "get_portfolio",
  "get_option_chains",
  "get_option_instruments",
  "get_option_quotes",
  "get_option_historicals",
  "get_option_positions",
  "get_option_orders",
  "get_option_watchlist",
  "get_option_level_upgrade_info",
  "get_equity_positions",
  "get_equity_quotes",
  "review_option_order",
];

export default defineConnection({
  description: "Read-only Robinhood options research for the signed-in Cursor account.",
  cursorAccount: true,
  servers: ["Robinhood"],
  advertiseTools: true,
  optional: true,
  tools: READ_TOOLS,
});
