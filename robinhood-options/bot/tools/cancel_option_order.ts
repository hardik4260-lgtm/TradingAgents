import { prompt } from "@cursor/bdk";
import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";

import { accountAccess, canCancelOrder, maskAccount } from "../lib/option-order.js";
import { accountsFromPayload, callRobinhood, ordersFromPayload } from "../lib/robinhood.js";

export default defineTool({
  description: prompt`
    Cancel one open options order on Robinhood.
    Call this only after the user explicitly says to cancel that order.
    The call waits for human approval, then checks the live account and the order state.
  `,
  effect: "write",
  needsApproval: true,
  dryRunResult: ({ order_id }) => ({
    cancelled: false,
    reason: "dry_run",
    order_id,
  }),
  inputSchema: z.object({
    account_number: z.string(),
    order_id: z.string(),
  }),
  async execute(input, ctx) {
    if (ctx.session.purpose === "eval") {
      return { cancelled: false, reason: "eval_session", order_id: input.order_id };
    }
    const accounts = await callRobinhood(ctx, "get_accounts", {});
    if (!accounts.ok || accounts.payload === undefined) {
      return { cancelled: false, reason: "account_lookup_failed", detail: accounts.detail ?? "get_accounts failed" };
    }
    const account = accountsFromPayload(accounts.payload).find(
      (candidate) => candidate.account_number === input.account_number,
    );
    if (account === undefined) {
      return {
        cancelled: false,
        reason: "account_not_found",
        detail: `No brokerage account matched ${maskAccount(input.account_number)}.`,
      };
    }
    const access = accountAccess(account);
    if (!access.tradable) {
      return { cancelled: false, reason: "account_ineligible", detail: access.reason ?? "Account is not accessible." };
    }

    const listed = await callRobinhood(ctx, "get_option_orders", {
      account_number: input.account_number,
      order_id: input.order_id,
    });
    if (!listed.ok || listed.payload === undefined) {
      return { cancelled: false, reason: "order_lookup_failed", detail: listed.detail ?? "get_option_orders failed" };
    }
    const order = ordersFromPayload(listed.payload).find((candidate) => candidate.order_id === input.order_id);
    if (order === undefined) {
      return { cancelled: false, reason: "order_not_found", detail: "That order is not on this account." };
    }
    if (!canCancelOrder(order.state)) {
      return {
        cancelled: false,
        reason: "not_open",
        detail: `The order is ${order.state ?? "in an unknown state"} and was not cancelled.`,
      };
    }

    const cancelled = await callRobinhood(ctx, "cancel_option_order", {
      account_number: input.account_number,
      order_id: input.order_id,
    });
    if (!cancelled.ok) {
      return { cancelled: false, reason: "cancel_failed", detail: cancelled.detail ?? "cancel_option_order failed" };
    }
    return {
      cancelled: true,
      reason: "cancelled",
      order_id: input.order_id,
      account: maskAccount(input.account_number),
    };
  },
});
