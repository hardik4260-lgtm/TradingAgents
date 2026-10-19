import { defineAgent } from "@cursor/bdk";

export default defineAgent({
  name: "Robinhood Options",
  description:
    "Researches option contracts on the signed-in Robinhood accounts and submits or cancels orders only after human approval.",
  model: {
    id: "grok-4.5",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
});
