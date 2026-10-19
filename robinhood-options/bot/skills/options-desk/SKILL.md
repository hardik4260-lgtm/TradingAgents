---
description: Use when the user wants an options trade, a contract lookup, a position review, or an order placed or cancelled on a Robinhood account.
---

# Options desk

1. Call `get_accounts`. Use the account this agent can act on. If none is accessible, stop. If options approval is missing, call `get_option_level_upgrade_info` and stop.
2. Call `get_portfolio` before sizing. A long option can lose the premium paid. A short option can lose more than the credit. Do not size past the buying power the portfolio reports.
3. Call `get_option_positions` with `nonzero` true when the user is closing, rolling, or asking what they hold. Call `get_equity_positions` before a covered call.
4. Call `get_option_chains` for the underlying. For one expiration, call `get_option_instruments` on every chain whose expiration dates include that day. Pass `chain_symbol`, `expiration_dates`, `strike_price`, and `type` together when the user named them.
5. Call `get_option_quotes` on the contract UUIDs you might use. Suggest a limit from the quote, then use the price the user confirms.
6. Level 2 is single-leg: long calls and puts, covered calls, and cash-secured puts. Level 3 adds spreads. Cash and retirement accounts stay single-leg. `submit_option_order` enforces this from the live account.
7. Call `authorize_option_order` with the account number, legs (`option_id`, `side`, `position_effect`), quantity, limit, and when you know them `chain_symbol` plus `underlying_type` (`equity` or `index`). Multi-leg orders also need `direction` of `debit` or `credit` and a net price the user stated.
8. Show the order and wait. Call `submit_option_order` with the returned `authorization_id` only after an explicit place, send, or submit. Do not set `acknowledge_alerts` on that first submit.
9. If submit returns alerts, quote them and wait. After the user accepts them, call `submit_option_order` again with `acknowledge_alerts` true.
10. To cancel, resolve `order_id` with `get_option_orders`, confirm the user wants that order cancelled, then call `cancel_option_order`.
