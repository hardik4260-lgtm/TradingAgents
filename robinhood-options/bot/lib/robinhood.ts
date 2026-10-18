/**
 * Host-side Robinhood calls. The model never sees place or cancel; the
 * write tools in `bot/tools/` are the only path that reaches them.
 */

import type { HostMcpCallResult, JsonObject, JsonValue } from "@cursor/bdk";

import { type BrokerageAccount } from "./option-order.js";

export const ROBINHOOD_HOST = "robinhood";

export type RobinhoodPayload = {
  ok: boolean;
  payload?: JsonValue;
  detail?: string;
};

type McpCaller = {
  host: {
    mcp: {
      callTool(
        connectionName: string,
        toolName: string,
        args?: Record<string, unknown>,
      ): Promise<HostMcpCallResult>;
    };
  };
};

export async function callRobinhood(
  ctx: McpCaller,
  toolName: string,
  args: JsonObject,
): Promise<RobinhoodPayload> {
  try {
    const result = await ctx.host.mcp.callTool(ROBINHOOD_HOST, toolName, args);
    if (result.isError === true) {
      return { ok: false, detail: textOf(result).slice(0, 500) || `${toolName} failed` };
    }
    const payload = payloadOf(result);
    if (payload === undefined) {
      return { ok: false, detail: `${toolName} returned no JSON payload` };
    }
    return { ok: true, payload };
  } catch (error) {
    const message = error instanceof Error ? error.message : `${toolName} failed`;
    return { ok: false, detail: message.slice(0, 500) };
  }
}

export function accountsFromPayload(payload: JsonValue | undefined): BrokerageAccount[] {
  const list = arrayAt(payload, "accounts") ?? arrayAt(objectAt(payload, "data"), "accounts") ?? [];
  const accounts: BrokerageAccount[] = [];
  for (const entry of list) {
    const record = asObject(entry);
    const accountNumber = stringAt(record, "account_number");
    if (record === undefined || accountNumber === undefined) continue;
    const account: BrokerageAccount = {
      account_number: accountNumber,
      agentic_allowed: record.agentic_allowed === true,
      option_level: stringAt(record, "option_level") ?? "",
    };
    const userLevel = stringAt(record, "user_option_level");
    const brokerage = stringAt(record, "brokerage_account_type");
    const type = stringAt(record, "type");
    const state = stringAt(record, "state");
    if (userLevel !== undefined) account.user_option_level = userLevel;
    if (brokerage !== undefined) account.brokerage_account_type = brokerage;
    if (type !== undefined) account.type = type;
    if (state !== undefined) account.state = state;
    if (typeof record.deactivated === "boolean") account.deactivated = record.deactivated;
    accounts.push(account);
  }
  return accounts;
}

export function orderChecks(payload: JsonValue | undefined): JsonValue[] {
  const found = findKey(payload, "order_checks", 0);
  return Array.isArray(found) ? found.filter(isJsonValue) : [];
}

export type ListedOrder = {
  order_id: string;
  state?: string;
};

export function ordersFromPayload(payload: JsonValue | undefined): ListedOrder[] {
  const list = arrayAt(payload, "orders") ?? arrayAt(objectAt(payload, "data"), "orders") ?? [];
  const orders: ListedOrder[] = [];
  for (const entry of list) {
    const record = asObject(entry);
    if (record === undefined) continue;
    const orderId = stringAt(record, "order_id") ?? stringAt(record, "id");
    if (orderId === undefined) continue;
    const order: ListedOrder = { order_id: orderId };
    const state = stringAt(record, "state");
    if (state !== undefined) order.state = state;
    orders.push(order);
  }
  return orders;
}

export function jsonObject(value: Record<string, JsonValue | undefined>): JsonObject {
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

function payloadOf(result: HostMcpCallResult): JsonValue | undefined {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result).trim();
  if (text === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function textOf(result: HostMcpCallResult): string {
  return result.content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function findKey(value: JsonValue | undefined, key: string, depth: number): JsonValue | undefined {
  if (value === undefined || depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findKey(entry, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asObject(value);
  if (record === undefined) return undefined;
  if (key in record) return record[key];
  for (const entry of Object.values(record)) {
    const found = findKey(entry, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function arrayAt(value: JsonValue | undefined, key: string): JsonValue[] | undefined {
  const record = asObject(value);
  const entry = record?.[key];
  return Array.isArray(entry) ? entry.filter(isJsonValue) : undefined;
}

function objectAt(value: JsonValue | undefined, key: string): JsonValue | undefined {
  const record = asObject(value);
  return record?.[key];
}

function stringAt(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}
