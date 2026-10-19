import { defineConnection } from "@cursor/bdk/connections";

export default defineConnection({
  description: "Robinhood order path used only by submit_option_order and cancel_option_order.",
  cursorAccount: true,
  servers: ["Robinhood"],
  tools: [
    "get_accounts",
    "review_option_order",
    "place_option_order",
    "get_option_orders",
    "cancel_option_order",
  ],
});
