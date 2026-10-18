import type { JsonObject, JsonValue } from "@cursor/bdk";

import {
  ORDER_TTL_MS,
  type MarketHours,
  type OptionSide,
  type OrderDirection,
  type OrderDraft,
  type OrderLeg,
  type OrderType,
  type PositionEffect,
  type Strategy,
  type TimeInForce,
  type UnderlyingType,
} from "./option-order.js";

export type AuthorizationStatus = "authorized" | "alerts" | "placed";

export type StoredAuthorization = {
  authorization_id: string;
  ref_id: string;
  exp: number;
  status: AuthorizationStatus;
  order: OrderDraft;
  alerts?: JsonValue[];
  place_result?: JsonObject;
};

export type LoadedAuthorization =
  | { state: "missing" }
  | { state: "expired" }
  | { state: "ok"; record: StoredAuthorization };

type Kv = {
  get(key: string): Promise<JsonValue | undefined>;
  put(key: string, value: JsonValue): Promise<void>;
};

export function authorizationKey(sessionId: string, authorizationId: string): string {
  return `option-auth:${sessionId}:${authorizationId}`;
}

export function freshExpiry(now: number): number {
  return now + ORDER_TTL_MS;
}

export async function loadAuthorization(
  kv: Kv,
  sessionId: string,
  authorizationId: string,
  now: number,
): Promise<LoadedAuthorization> {
  const value = await kv.get(authorizationKey(sessionId, authorizationId));
  if (value === undefined) return { state: "missing" };
  const record = parseAuthorization(value);
  if (record === undefined) return { state: "missing" };
  if (record.exp <= now) return { state: "expired" };
  return { state: "ok", record };
}

export async function saveAuthorization(
  kv: Kv,
  sessionId: string,
  record: StoredAuthorization,
): Promise<void> {
  await kv.put(authorizationKey(sessionId, record.authorization_id), serialize(record));
}

function serialize(record: StoredAuthorization): JsonObject {
  const stored: JsonObject = {
    authorization_id: record.authorization_id,
    ref_id: record.ref_id,
    exp: record.exp,
    status: record.status,
    order: serializeOrder(record.order),
  };
  if (record.alerts !== undefined) stored.alerts = record.alerts;
  if (record.place_result !== undefined) stored.place_result = record.place_result;
  return stored;
}

function serializeOrder(order: OrderDraft): JsonObject {
  const stored: JsonObject = {
    account_number: order.account_number,
    legs: order.legs.map((leg) => ({
      option_id: leg.option_id,
      side: leg.side,
      position_effect: leg.position_effect,
      ratio_quantity: leg.ratio_quantity,
    })),
    quantity: order.quantity,
    type: order.type,
    time_in_force: order.time_in_force,
    market_hours: order.market_hours,
    strategy: order.strategy,
  };
  if (order.price !== undefined) stored.price = order.price;
  if (order.stop_price !== undefined) stored.stop_price = order.stop_price;
  if (order.direction !== undefined) stored.direction = order.direction;
  if (order.chain_symbol !== undefined) stored.chain_symbol = order.chain_symbol;
  if (order.underlying_type !== undefined) stored.underlying_type = order.underlying_type;
  return stored;
}

function parseAuthorization(value: JsonValue): StoredAuthorization | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const authorizationId = asString(record.authorization_id);
  const refId = asString(record.ref_id);
  const exp = record.exp;
  const status = asString(record.status);
  const order = parseOrder(record.order);
  if (
    authorizationId === undefined ||
    refId === undefined ||
    typeof exp !== "number" ||
    !isStatus(status) ||
    order === undefined
  ) {
    return undefined;
  }
  const stored: StoredAuthorization = {
    authorization_id: authorizationId,
    ref_id: refId,
    exp,
    status,
    order,
  };
  if (Array.isArray(record.alerts)) stored.alerts = record.alerts;
  const placeResult = asObject(record.place_result);
  if (placeResult !== undefined) stored.place_result = placeResult;
  return stored;
}

function parseOrder(value: JsonValue | undefined): OrderDraft | undefined {
  const record = asObject(value);
  if (record === undefined || !Array.isArray(record.legs)) return undefined;
  const legs: OrderLeg[] = [];
  for (const entry of record.legs) {
    const leg = asObject(entry);
    const optionId = leg === undefined ? undefined : asString(leg.option_id);
    const side = leg === undefined ? undefined : asString(leg.side);
    const effect = leg === undefined ? undefined : asString(leg.position_effect);
    const ratio = leg?.ratio_quantity;
    if (
      optionId === undefined ||
      !isSide(side) ||
      !isEffect(effect) ||
      typeof ratio !== "number"
    ) {
      return undefined;
    }
    legs.push({
      option_id: optionId,
      side,
      position_effect: effect,
      ratio_quantity: ratio,
    });
  }
  const accountNumber = asString(record.account_number);
  const quantity = asString(record.quantity);
  const type = asString(record.type);
  const timeInForce = asString(record.time_in_force);
  const marketHours = asString(record.market_hours);
  const strategy = asString(record.strategy);
  if (
    accountNumber === undefined ||
    quantity === undefined ||
    !isType(type) ||
    !isTif(timeInForce) ||
    !isSession(marketHours) ||
    !isStrategy(strategy) ||
    legs.length === 0
  ) {
    return undefined;
  }
  const order: OrderDraft = {
    account_number: accountNumber,
    legs,
    quantity,
    type,
    time_in_force: timeInForce,
    market_hours: marketHours,
    strategy,
  };
  const price = asString(record.price);
  const stopPrice = asString(record.stop_price);
  const direction = asString(record.direction);
  const chain = asString(record.chain_symbol);
  const underlying = asString(record.underlying_type);
  if (price !== undefined) order.price = price;
  if (stopPrice !== undefined) order.stop_price = stopPrice;
  if (isDirection(direction)) order.direction = direction;
  if (chain !== undefined) order.chain_symbol = chain;
  if (isUnderlying(underlying)) order.underlying_type = underlying;
  return order;
}

function isStatus(value: string | undefined): value is AuthorizationStatus {
  return value === "authorized" || value === "alerts" || value === "placed";
}
function isSide(value: string | undefined): value is OptionSide {
  return value === "buy" || value === "sell";
}
function isEffect(value: string | undefined): value is PositionEffect {
  return value === "open" || value === "close";
}
function isType(value: string | undefined): value is OrderType {
  return value === "limit" || value === "market" || value === "stop_limit" || value === "stop_market";
}
function isTif(value: string | undefined): value is TimeInForce {
  return value === "gfd" || value === "gtc";
}
function isSession(value: string | undefined): value is MarketHours {
  return (
    value === "regular_hours" ||
    value === "regular_curb_hours" ||
    value === "regular_curb_overnight_hours"
  );
}
function isStrategy(value: string | undefined): value is Strategy {
  return (
    value === "long_single" ||
    value === "short_premium" ||
    value === "close" ||
    value === "multi_leg"
  );
}
function isDirection(value: string | undefined): value is OrderDirection {
  return value === "debit" || value === "credit";
}
function isUnderlying(value: string | undefined): value is UnderlyingType {
  return value === "equity" || value === "index";
}
function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  return value;
}
