# Robinhood Options

Options desk for the Robinhood accounts connected to the signed-in Cursor account. It looks up chains, quotes, positions, and buying power, then sends or cancels an order only after a person approves that action.

This is a research and execution assistant. It is not financial, investment, or trading advice.

## What it can trade

The agent uses the Robinhood connector named `Robinhood` on the Cursor account. Research tools are visible to the model. `place_option_order` and `cancel_option_order` are not. Those writes go through:

- `authorize_option_order` checks the order shape and saves it for 15 minutes.
- `submit_option_order` waits for approval, re-reads the live account, reviews the order, and only then sends it. The same idempotency key is reused for that authorization.
- `cancel_option_order` waits for approval, then cancels an order that is still open.

Level 2 accounts can trade single-leg options. Level 3 accounts can also trade multi-leg orders, except cash and retirement accounts. An account this agent cannot act on is refused.

A single-leg order can still wait for approval in the Robinhood app after this agent submits it.

## Run

From this directory, with Node 22:

```bash
npx @cursor/bdk login
npx @cursor/bdk dev
```

Connect Robinhood under the Cursor account's MCP connectors before the first trade. `login` is what lets the agent use that connector. Without it, research tools are omitted and order tools stop before sending.

```bash
npx @cursor/bdk validate --dir .
npx @cursor/bdk info --dir . --json
npm run check
npm run check:policy
```

Model turns and evals need the same Cursor credential:

```bash
npx @cursor/bdk eval --dir . --list
npx @cursor/bdk eval --dir . --tag smoke
```
