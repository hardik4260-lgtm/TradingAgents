import { prompt } from "@cursor/bdk";
import type { JsonObject, JsonValue } from "@cursor/bdk";
import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";

import { loadAuthorization, saveAuthorization, type StoredAuthorization } from "../lib/authorizations.js";
import { accountAccess, holdForAlerts, maskAccount } from "../lib/option-order.js";
import {
  accountsFromPayload,
  callRobinhood,
  jsonObject,
  orderChecks,
} from "../lib/robinhood.js";

const OPEN_REVIEW = "review_option_order";
const PLACE = "place_option_order";

export default defineTool({
  description: prompt`
    Send a previously authorized options order to Robinhood.
    Call this only after the user explicitly says to place, send, or submit that order.
    The call waits for human approval, then re-reads the live account and reviews the order.
    It does not send while review alerts are outstanding. Show those alerts and,
    only after the user accepts them, call again with acknowledge_alerts true.
  `,
  effect: "write",
  needsApproval: true,
  dryRunResult: ({ authorization_id }) => ({
    submitted: false,
    reason: "dry_run",
    authorization_id,
  }),
  inputSchema: z.object({
    authorization_id: z.string(),
    acknowledge_alerts: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    if (ctx.session.purpose === "eval") {
      return {
        submitted: false,
        reason: "eval_session",
        authorization_id: input.authorization_id,
      };
    }
    const loaded = await loadAuthorization(
      ctx.host.kv,
      ctx.session.id,
      input.authorization_id,
      Date.now(),
    );
    if (loaded.state === "missing") {
      return {
        submitted: false,
        reason: "unknown_authorization",
        detail: "Authorize the order again, then submit that authorization id.",
      };
    }
    if (loaded.state === "expired") {
      return {
        submitted: false,
        reason: "expired",
        detail: "The authorization expired. Authorize the order again.",
      };
    }
    const record = loaded.record;
    if (record.status === "placed" && record.place_result !== undefined) {
      return {
        submitted: true,
        reason: "already_submitted",
        authorization_id: record.authorization_id,
        ref_id: record.ref_id,
        result: record.place_result,
      };
    }

    const accounts = await callRobinhood(ctx, "get_accounts", {});
    if (!accounts.ok || accounts.payload === undefined) {
      return { submitted: false, reason: "account_lookup_failed", detail: accounts.detail ?? "get_accounts failed" };
    }
    const account = accountsFromPayload(accounts.payload).find(
      (candidate) => candidate.account_number === record.order.account_number,
    );
    if (account === undefined) {
      return {
        submitted: false,
        reason: "account_not_found",
        detail: `No brokerage account matched ${maskAccount(record.order.account_number)}.`,
      };
    }
    const access = accountAccess(account);
    if (!access.tradable) {
      return { submitted: false, reason: "account_ineligible", detail: access.reason ?? "Account cannot trade options." };
    }
    if (record.order.strategy === "multi_leg" && !access.multi_leg) {
      return {
        submitted: false,
        reason: "strategy_not_permitted",
        detail: access.reason ?? "This account cannot trade multi-leg options.",
      };
    }

    const review = await callRobinhood(ctx, OPEN_REVIEW, reviewArgs(record));
    if (!review.ok || review.payload === undefined) {
      return { submitted: false, reason: "review_failed", detail: review.detail ?? "review_option_order failed" };
    }
    if (!hasBody(review.payload)) {
      return { submitted: false, reason: "review_failed", detail: "review_option_order returned an empty payload." };
    }
    const alerts = orderChecks(review.payload);
    if (holdForAlerts(record.status, alerts.length, input.acknowledge_alerts)) {
      const next: StoredAuthorization = { ...record, status: "alerts", alerts };
      await saveAuthorization(ctx.host.kv, ctx.session.id, next);
      return {
        submitted: false,
        reason: "alerts",
        authorization_id: record.authorization_id,
        alerts,
        detail: "Show these alerts verbatim. Submit again with acknowledge_alerts true only after the user accepts them.",
      };
    }

    const placed = await callRobinhood(ctx, PLACE, placeArgs(record));
    if (!placed.ok || placed.payload === undefined) {
      return { submitted: false, reason: "place_failed", detail: placed.detail ?? "place_option_order failed" };
    }
    const result = asObject(placed.payload);
    if (result === undefined || Object.keys(result).length === 0) {
      return { submitted: false, reason: "place_failed", detail: "place_option_order returned an empty payload." };
    }
    await saveAuthorization(ctx.host.kv, ctx.session.id, {
      ...record,
      status: "placed",
      place_result: result,
    });
    return {
      submitted: true,
      reason: "submitted",
      authorization_id: record.authorization_id,
      ref_id: record.ref_id,
      result,
      detail: "Single-leg orders can still be waiting for the customer to approve them in the Robinhood app.",
    };
  },
});

function reviewArgs(record: StoredAuthorization): JsonObject {
  const order = record.order;
  return jsonObject({
    account_number: order.account_number,
    legs: order.legs.map((leg) =>
      jsonObject({
        option_id: leg.option_id,
        side: leg.side,
        position_effect: leg.position_effect,
        ratio_quantity: leg.ratio_quantity,
      }),
    ),
    quantity: order.quantity,
    type: order.type,
    price: order.price,
    stop_price: order.stop_price,
    direction: order.direction,
    time_in_force: order.time_in_force,
    market_hours: order.market_hours,
    chain_symbol: order.chain_symbol,
    underlying_type: order.underlying_type,
  });
}

function placeArgs(record: StoredAuthorization): JsonObject {
  const order = record.order;
  return jsonObject({
    account_number: order.account_number,
    legs: order.legs.map((leg) =>
      jsonObject({
        option_id: leg.option_id,
        side: leg.side,
        position_effect: leg.position_effect,
        ratio_quantity: leg.ratio_quantity,
      }),
    ),
    quantity: order.quantity,
    type: order.type,
    price: order.price,
    stop_price: order.stop_price,
    direction: order.direction,
    time_in_force: order.time_in_force,
    market_hours: order.market_hours,
    ref_id: record.ref_id,
  });
}

function hasBody(value: JsonValue): boolean {
  const record = asObject(value);
  return record !== undefined && Object.keys(record).length > 0;
}

function asObject(value: JsonValue): JsonObject | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return value;
}
