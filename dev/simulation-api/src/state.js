export function createState() {
  return {
    blinkitScenario: {
      ackResponse: { mode: "success" },
      asnResponse: { mode: "accepted" },
      amendmentResponse: { mode: "success" },
      latencyMs: 0
    },
    received: {
      poWebhooks: [],
      poAcks: [],
      asns: [],
      amendments: []
    },
    erpScenarios: new Map(),
    erpPurchaseOrders: new Map(),
    erpPolls: new Map(),
    sheets: new Map(),
    sheetScenarios: new Map()
  };
}
