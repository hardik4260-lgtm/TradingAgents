import { prompt } from "@cursor/bdk";
import { defineTool } from "@cursor/bdk/tools";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";

import { freshExpiry, saveAuthorization } from "../lib/authorizations.js";
import { assessOrder } from "../lib/option-order.js";

const leg = z.object({
  option_id: z.string(),
  side: z.enum(["buy", "sell"]),
  position_effect: z.enum(["open", "close"]),
  ratio_quantity: z.number().int().positive().optional(),
});

export default defineTool({
  description: prompt`
    Check an options order and save it for submit_option_order.
    This does not look up the account and does not send the order.
    Call it after the contract UUIDs and the limit are known.
    Pass the price the user stated. Do not invent a price or a net debit.
  `,
  effect: "write",
  dryRunResult: () => ({
    allowed: false,
    strategy: "unclassified",
    blockers: ["Dry run does not authorize live orders."],
  }),
  inputSchema: z.object({
    account_number: z.string(),
    legs: z.array(leg).min(1).max(4),
    quantity: z.string(),
    type: z.enum(["limit", "market", "stop_limit", "stop_market"]).optional(),
    price: z.string().optional(),
    stop_price: z.string().optional(),
    direction: z.enum(["debit", "credit"]).optional(),
    time_in_force: z.enum(["gfd", "gtc"]).optional(),
    market_hours: z
      .enum(["regular_hours", "regular_curb_hours", "regular_curb_overnight_hours"])
      .optional(),
    chain_symbol: z.string().optional(),
    underlying_type: z.enum(["equity", "index"]).optional(),
  }),
  async execute(input, ctx) {
    const assessed = assessOrder(input);
    if (!assessed.ok) {
      return {
        allowed: false,
        strategy: assessed.strategy,
        blockers: assessed.blockers,
      };
    }
    const authorizationId = randomUUID();
    const exp = freshExpiry(Date.now());
    await saveAuthorization(ctx.host.kv, ctx.session.id, {
      authorization_id: authorizationId,
      ref_id: randomUUID(),
      exp,
      status: "authorized",
      order: assessed.order,
    });
    return {
      allowed: true,
      strategy: assessed.order.strategy,
      authorization_id: authorizationId,
      expires_at: new Date(exp).toISOString(),
      blockers: [],
    };
  },
});
