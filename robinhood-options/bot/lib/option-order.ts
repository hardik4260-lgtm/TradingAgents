/**
 * Structural checks for an options order and the live-account rules that
 * decide whether that order may be sent. Submit re-reads the brokerage
 * account and applies `accountAccess` again; this module never calls
 * Robinhood.
 */

export const ORDER_TTL_MS = 15 * 60 * 1000;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRICE = /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/;
const QUANTITY = /^[1-9]\d*$/;
const ACCOUNT_NUMBER = /^[A-Za-z0-9]{4,32}$/;
const CHAIN_SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

export type OptionSide = "buy" | "sell";
export type PositionEffect = "open" | "close";
export type OrderType = "limit" | "market" | "stop_limit" | "stop_market";
export type OrderDirection = "debit" | "credit";
export type TimeInForce = "gfd" | "gtc";
export type MarketHours =
  | "regular_hours"
  | "regular_curb_hours"
  | "regular_curb_overnight_hours";
export type UnderlyingType = "equity" | "index";
export type Strategy = "long_single" | "short_premium" | "close" | "multi_leg";

export type OrderLeg = {
  option_id: string;
  side: OptionSide;
  position_effect: PositionEffect;
  ratio_quantity: number;
};

export type OrderDraft = {
  account_number: string;
  legs: OrderLeg[];
  quantity: string;
  type: OrderType;
  price?: string;
  stop_price?: string;
  direction?: OrderDirection;
  time_in_force: TimeInForce;
  market_hours: MarketHours;
  chain_symbol?: string;
  underlying_type?: UnderlyingType;
  strategy: Strategy;
};

export type AssessInput = {
  account_number: string;
  legs: Array<{
    option_id: string;
    side: string;
    position_effect: string;
    ratio_quantity?: number;
  }>;
  quantity: string;
  type?: string;
  price?: string;
  stop_price?: string;
  direction?: string;
  time_in_force?: string;
  market_hours?: string;
  chain_symbol?: string;
  underlying_type?: string;
};

export type AssessResult =
  | { ok: true; order: OrderDraft }
  | { ok: false; strategy: Strategy | "unclassified"; blockers: string[] };

export type BrokerageAccount = {
  account_number: string;
  agentic_allowed: boolean;
  option_level: string;
  user_option_level?: string;
  brokerage_account_type?: string;
  type?: string;
  state?: string;
  deactivated?: boolean;
};

export type AccountAccess = {
  tradable: boolean;
  multi_leg: boolean;
  level: number;
  reason?: string;
};

const SIDES = new Set<OptionSide>(["buy", "sell"]);
const EFFECTS = new Set<PositionEffect>(["open", "close"]);
const TYPES = new Set<OrderType>(["limit", "market", "stop_limit", "stop_market"]);
const DIRECTIONS = new Set<OrderDirection>(["debit", "credit"]);
const TIFS = new Set<TimeInForce>(["gfd", "gtc"]);
const SESSIONS = new Set<MarketHours>([
  "regular_hours",
  "regular_curb_hours",
  "regular_curb_overnight_hours",
]);
const UNDERLYINGS = new Set<UnderlyingType>(["equity", "index"]);

export function holdForAlerts(
  status: "authorized" | "alerts" | "placed",
  alertCount: number,
  acknowledge: boolean | undefined,
): boolean {
  if (alertCount <= 0) return false;
  return !(status === "alerts" && acknowledge === true);
}

export function canCancelOrder(state: string | undefined): boolean {
  return state === "queued" || state === "confirmed" || state === "partially_filled";
}

export function maskAccount(accountNumber: string): string {
  const tail = accountNumber.slice(-4);
  return `••••${tail}`;
}

export function accountAccess(account: BrokerageAccount): AccountAccess {
  if (account.deactivated === true || (account.state !== undefined && account.state !== "active")) {
    return { tradable: false, multi_leg: false, level: 0, reason: "This account is not active." };
  }
  if (account.agentic_allowed !== true) {
    return {
      tradable: false,
      multi_leg: false,
      level: 0,
      reason: "This account is not accessible to this agent.",
    };
  }
  const brokerage = account.brokerage_account_type ?? "";
  if (brokerage === "trust_revocable" && !account.user_option_level) {
    return {
      tradable: false,
      multi_leg: false,
      level: 0,
      reason: "This trust account has no options level for this user.",
    };
  }
  const level = optionsLevel(account.user_option_level || account.option_level);
  if (level < 2) {
    return {
      tradable: false,
      multi_leg: false,
      level,
      reason: "This account is not approved for options.",
    };
  }
  const retirement = isRetirement(brokerage);
  const cash = account.type === "cash";
  if (level >= 3 && !retirement && !cash) {
    return { tradable: true, multi_leg: true, level };
  }
  if (level >= 3) {
    return {
      tradable: true,
      multi_leg: false,
      level,
      reason: "Multi-leg orders are not available on this account type.",
    };
  }
  return {
    tradable: true,
    multi_leg: false,
    level,
    reason: "This account can trade single-leg options only.",
  };
}

export function assessOrder(input: AssessInput): AssessResult {
  const blockers: string[] = [];
  const accountNumber = input.account_number.trim();
  if (!ACCOUNT_NUMBER.test(accountNumber) || accountNumber.toLowerCase() === "default") {
    blockers.push("account_number must be the brokerage account number, not a label or a masked value.");
  }

  const legs: OrderLeg[] = [];
  if (input.legs.length < 1 || input.legs.length > 4) {
    blockers.push("An options order has 1 to 4 legs.");
  }
  const seen = new Set<string>();
  for (const raw of input.legs) {
    const optionId = raw.option_id.trim();
    if (!UUID.test(optionId)) {
      blockers.push(`option_id must be the contract UUID from get_option_instruments (${optionId || "missing"}).`);
    }
    if (seen.has(optionId)) {
      blockers.push("Each leg must be a different contract.");
    }
    seen.add(optionId);
    if (!SIDES.has(raw.side as OptionSide)) {
      blockers.push("Each leg side must be buy or sell.");
    }
    if (!EFFECTS.has(raw.position_effect as PositionEffect)) {
      blockers.push("Each leg position_effect must be open or close.");
    }
    const ratio = raw.ratio_quantity ?? 1;
    if (!Number.isInteger(ratio) || ratio < 1) {
      blockers.push("ratio_quantity must be a positive integer.");
    }
    if (SIDES.has(raw.side as OptionSide) && EFFECTS.has(raw.position_effect as PositionEffect) && Number.isInteger(ratio) && ratio >= 1) {
      legs.push({
        option_id: optionId,
        side: raw.side as OptionSide,
        position_effect: raw.position_effect as PositionEffect,
        ratio_quantity: ratio,
      });
    }
  }
  if (legs.length === 1 && legs[0] !== undefined && legs[0].ratio_quantity !== 1) {
    blockers.push("A single-leg order must use ratio_quantity 1.");
  }
  if (legs.length > 1 && !lowestTerms(legs.map((leg) => leg.ratio_quantity))) {
    blockers.push("Leg ratios must be in lowest terms (1:2, not 2:4).");
  }

  const strategy = classify(legs);
  const type = input.type ?? "limit";
  if (!TYPES.has(type as OrderType)) {
    blockers.push("type must be limit, market, stop_limit, or stop_market.");
  }
  const timeInForce = input.time_in_force ?? "gfd";
  if (!TIFS.has(timeInForce as TimeInForce)) {
    blockers.push("time_in_force must be gfd or gtc.");
  }
  const marketHours = input.market_hours ?? "regular_hours";
  if (!SESSIONS.has(marketHours as MarketHours)) {
    blockers.push("market_hours is not a supported session.");
  }
  if (!QUANTITY.test(input.quantity.trim())) {
    blockers.push("quantity must be a positive integer contract count.");
  }

  const price = blankToUndefined(input.price);
  const stopPrice = blankToUndefined(input.stop_price);
  if (price !== undefined && !validPrice(price)) {
    blockers.push("price must be a positive decimal with at most 4 places.");
  }
  if (stopPrice !== undefined && !validPrice(stopPrice)) {
    blockers.push("stop_price must be a positive decimal with at most 4 places.");
  }

  const orderType = TYPES.has(type as OrderType) ? (type as OrderType) : undefined;
  if (orderType === "limit" && price === undefined) {
    blockers.push("A limit order needs a price. Ask for it; do not invent one.");
  }
  if (orderType === "stop_limit" && (price === undefined || stopPrice === undefined)) {
    blockers.push("A stop_limit order needs both price and stop_price.");
  }
  if ((orderType === "market" || orderType === "stop_market") && price !== undefined) {
    blockers.push("Omit price on market and stop_market orders.");
  }
  if (orderType === "market" && stopPrice !== undefined) {
    blockers.push("Omit stop_price on a market order.");
  }
  if (orderType === "stop_market" && stopPrice === undefined) {
    blockers.push("A stop_market order needs stop_price.");
  }
  if (orderType === "limit" && stopPrice !== undefined) {
    blockers.push("Omit stop_price on a limit order.");
  }
  if ((orderType === "market" || orderType === "stop_market") && legs.length !== 1) {
    blockers.push("market, stop_market, and stop_limit are single-leg only.");
  }
  if (orderType === "stop_limit" && legs.length !== 1) {
    blockers.push("market, stop_market, and stop_limit are single-leg only.");
  }
  if (orderType === "stop_market") {
    const leg = legs[0];
    if (leg === undefined || leg.side !== "sell" || leg.position_effect !== "close") {
      blockers.push("stop_market is sell-to-close only.");
    }
  }
  if ((orderType === "market" || orderType === "stop_market") && timeInForce !== "gfd") {
    blockers.push("Market and stop_market orders must be gfd.");
  }
  if ((orderType === "market" || orderType === "stop_market" || orderType === "stop_limit") && marketHours !== "regular_hours") {
    blockers.push("Only limit orders can use an extended-hours session.");
  }
  if (legs.length >= 2 && orderType !== undefined && orderType !== "limit") {
    blockers.push("Multi-leg orders are limit orders.");
  }

  let direction: OrderDirection | undefined;
  if (legs.length >= 2) {
    if (input.direction === undefined) {
      blockers.push("Multi-leg orders need direction debit or credit. Get the net price from the user.");
    } else if (!DIRECTIONS.has(input.direction as OrderDirection)) {
      blockers.push("direction must be debit or credit.");
    } else {
      direction = input.direction as OrderDirection;
    }
  } else if (input.direction !== undefined) {
    blockers.push("Omit direction on a single-leg order.");
  }

  const chain = blankToUndefined(input.chain_symbol)?.toUpperCase();
  const underlying = blankToUndefined(input.underlying_type);
  if ((chain === undefined) !== (underlying === undefined)) {
    blockers.push("Pass chain_symbol and underlying_type together, or omit both.");
  }
  if (chain !== undefined && !CHAIN_SYMBOL.test(chain)) {
    blockers.push("chain_symbol must be the underlying ticker.");
  }
  if (underlying !== undefined && !UNDERLYINGS.has(underlying as UnderlyingType)) {
    blockers.push("underlying_type must be equity or index.");
  }

  if (blockers.length > 0 || orderType === undefined || !TIFS.has(timeInForce as TimeInForce) || !SESSIONS.has(marketHours as MarketHours) || legs.length === 0 || strategy === "unclassified") {
    return { ok: false, strategy, blockers: unique(blockers) };
  }

  const order: OrderDraft = {
    account_number: accountNumber,
    legs,
    quantity: input.quantity.trim(),
    type: orderType,
    time_in_force: timeInForce as TimeInForce,
    market_hours: marketHours as MarketHours,
    strategy,
  };
  if (price !== undefined && (orderType === "limit" || orderType === "stop_limit")) {
    order.price = price;
  }
  if (stopPrice !== undefined && (orderType === "stop_limit" || orderType === "stop_market")) {
    order.stop_price = stopPrice;
  }
  if (direction !== undefined) {
    order.direction = direction;
  }
  if (chain !== undefined && underlying !== undefined && UNDERLYINGS.has(underlying as UnderlyingType)) {
    order.chain_symbol = chain;
    order.underlying_type = underlying as UnderlyingType;
  }
  return { ok: true, order };
}

export function optionsLevel(level: string | undefined): number {
  if (level === undefined || level.trim() === "") return 0;
  const match = /^option_level_(\d+)$/.exec(level.trim());
  if (match === null || match[1] === undefined) return 0;
  return Number(match[1]);
}

function classify(legs: OrderLeg[]): Strategy | "unclassified" {
  if (legs.length >= 2) return "multi_leg";
  const leg = legs[0];
  if (leg === undefined) return "unclassified";
  if (leg.position_effect === "close") return "close";
  if (leg.side === "buy" && leg.position_effect === "open") return "long_single";
  if (leg.side === "sell" && leg.position_effect === "open") return "short_premium";
  return "unclassified";
}

function lowestTerms(ratios: number[]): boolean {
  return ratios.reduce((left, right) => gcd(left, right), 0) === 1;
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function validPrice(value: string): boolean {
  if (!PRICE.test(value)) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isRetirement(brokerage: string): boolean {
  const value = brokerage.toLowerCase();
  return value.startsWith("ira") || value.includes("retirement");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
