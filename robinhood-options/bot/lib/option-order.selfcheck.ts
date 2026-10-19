/**
 * Deterministic checks for the order gate. Run with:
 * `node --experimental-strip-types bot/lib/option-order.selfcheck.ts`
 */

import {
  accountAccess,
  assessOrder,
  canCancelOrder,
  holdForAlerts,
  type AssessInput,
  type BrokerageAccount,
} from "./option-order.ts";

const failures: string[] = [];

function check(name: string, condition: boolean): void {
  if (!condition) failures.push(name);
}

const leg = {
  option_id: "11111111-1111-4111-8111-111111111111",
  side: "buy",
  position_effect: "open",
};

const valid: AssessInput = {
  account_number: "400000001",
  legs: [leg],
  quantity: "1",
  type: "limit",
  price: "1.25",
  chain_symbol: "AAPL",
  underlying_type: "equity",
};

const allowed = assessOrder(valid);
check("single leg limit allowed", allowed.ok && allowed.order.strategy === "long_single");

const invented = assessOrder({ ...valid, price: undefined });
check("missing limit price blocked", !invented.ok);

const marketPrice = assessOrder({ ...valid, type: "market", price: undefined });
check("single market allowed", marketPrice.ok && marketPrice.order.type === "market");

const marketWithPrice = assessOrder({ ...valid, type: "market" });
check("market with price blocked", !marketWithPrice.ok);

const stopBuy = assessOrder({
  ...valid,
  type: "stop_market",
  price: undefined,
  stop_price: "1.00",
});
check("stop market buy blocked", !stopBuy.ok);

const putId = "22222222-2222-4222-8222-222222222222";
const spread = assessOrder({
  ...valid,
  direction: "debit",
  legs: [
    leg,
    { option_id: putId, side: "sell", position_effect: "open", ratio_quantity: 2 },
  ],
});
check("1:2 spread allowed", spread.ok && spread.order.strategy === "multi_leg");

const doubled = assessOrder({
  ...valid,
  direction: "debit",
  legs: [
    { ...leg, ratio_quantity: 2 },
    { option_id: putId, side: "sell", position_effect: "open", ratio_quantity: 4 },
  ],
});
check("2:4 ratios blocked", !doubled.ok);

const noDirection = assessOrder({
  ...valid,
  legs: [leg, { option_id: putId, side: "sell", position_effect: "open" }],
});
check("multi-leg without direction blocked", !noDirection.ok);

const masked = assessOrder({ ...valid, account_number: "••••0001" });
check("masked account blocked", !masked.ok);

function access(overrides: Partial<BrokerageAccount>) {
  return accountAccess({
    account_number: "400000001",
    agentic_allowed: true,
    option_level: "option_level_2",
    brokerage_account_type: "individual",
    type: "margin",
    state: "active",
    deactivated: false,
    ...overrides,
  });
}

const level2 = access({});
check("level 2 single leg", level2.tradable && !level2.multi_leg);

const level3 = access({ option_level: "option_level_3" });
check("level 3 spreads", level3.tradable && level3.multi_leg);

const ira = access({ option_level: "option_level_3", brokerage_account_type: "ira_roth" });
check("retirement blocks spreads", ira.tradable && !ira.multi_leg);

const cash = access({ option_level: "option_level_3", type: "cash" });
check("cash blocks spreads", cash.tradable && !cash.multi_leg);

const closed = access({ agentic_allowed: false, option_level: "option_level_3" });
check("non-agent account refused", !closed.tradable);

const unenrolled = access({ option_level: "" });
check("empty options level refused", !unenrolled.tradable);

const trust = access({
  brokerage_account_type: "trust_revocable",
  option_level: "option_level_3",
});
check("trust without user level refused", !trust.tradable);

const trustUser = access({
  brokerage_account_type: "trust_revocable",
  option_level: "option_level_3",
  user_option_level: "option_level_2",
});
check("user level overrides account level", trustUser.tradable && !trustUser.multi_leg);

const inactive = access({ state: "inactive", option_level: "option_level_3" });
check("inactive account refused", !inactive.tradable);

check("first alerts are held", holdForAlerts("authorized", 1, true));
check("accepted alerts can send", !holdForAlerts("alerts", 1, true));
check("unaccepted alerts stay held", holdForAlerts("alerts", 1, false));
check("no alerts do not hold", !holdForAlerts("authorized", 0, false));
check("open order can be cancelled", canCancelOrder("confirmed"));
check("filled order cannot be cancelled", !canCancelOrder("filled"));

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("option-order selfcheck ok");
