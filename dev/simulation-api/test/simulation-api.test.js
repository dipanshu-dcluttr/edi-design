import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/app.js";

const API_KEY = "dev-api-key";

async function withServer(fn) {
  const { server } = createServer({ apiKey: API_KEY });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

test("health endpoint returns simulator service names", async () => {
  await withServer(async (baseUrl) => {
    const { response, body } = await request(baseUrl, "/health");

    assert.equal(response.status, 200);
    assert.deepEqual(body.services, ["sim-blinkit-api", "sim-erp-api", "sim-sheet-api"]);
  });
});

test("Blinkit platform endpoints require Api-Key header", async () => {
  await withServer(async (baseUrl) => {
    const { response, body } = await request(baseUrl, "/webhook/public/v1/po/acknowledgement", {
      method: "POST",
      body: JSON.stringify({ success: true })
    });

    assert.equal(response.status, 401);
    assert.equal(body.success, false);
    assert.equal(body.message, "Unauthorized");
  });
});

test("PO acknowledgement endpoint stores request and returns documented acknowledgement response", async () => {
  await withServer(async (baseUrl) => {
    const payload = {
      success: true,
      message: "PO synced completed.",
      timestamp: "2025-04-17T10:30:00Z",
      data: {
        po_status: "ACCEPTED",
        po_number: "PO-1001",
        errors: [],
        warnings: []
      }
    };

    const { response, body } = await request(baseUrl, "/webhook/public/v1/po/acknowledgement", {
      method: "POST",
      headers: { "Api-Key": API_KEY },
      body: JSON.stringify(payload)
    });
    const received = await request(baseUrl, "/sim/blinkit/received/po-acks", {
      headers: { "Api-Key": API_KEY }
    });

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.message, "Successfully Acknowledged.");
    assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(received.body.length, 1);
    assert.deepEqual(received.body[0].body, payload);
  });
});

test("Blinkit PO webhook simulator returns documented PO creation payload when no target URL is provided", async () => {
  await withServer(async (baseUrl) => {
    const { response, body } = await request(baseUrl, "/sim/blinkit/po-webhooks", {
      method: "POST",
      headers: { "Api-Key": API_KEY },
      body: JSON.stringify({ poNumber: "2264110001440", tenant: "HYPERPURE" })
    });

    assert.equal(response.status, 201);
    assert.equal(body.sent, false);
    assert.equal(body.payload.type, "PO_CREATION");
    assert.equal(body.payload.po_number, "2264110001440");
    assert.equal(body.payload.tenant, "HYPERPURE");
    assert.equal(body.payload.details.po_number, "2264110001440");
    assert.equal(body.payload.details.outlet_id, 12543);
    assert.equal(body.payload.details.item_data[0].item_id, 10016623);
    assert.equal(body.payload.details.item_data[0].uom.unit, "ml");
  });
});

test("ASN endpoint returns accepted response by default and rejected response from scenario", async () => {
  await withServer(async (baseUrl) => {
    await request(baseUrl, "/sim/blinkit/scenarios", {
      method: "POST",
      headers: { "Api-Key": API_KEY },
      body: JSON.stringify({
        asnResponse: {
          mode: "rejected",
          errors: [{ code: "E108", level: "asn", message: "Invoice date cannot be before PO issue date" }]
        }
      })
    });

    const { response, body } = await request(baseUrl, "/webhook/public/v1/asn", {
      method: "POST",
      headers: { "Api-Key": API_KEY },
      body: JSON.stringify({
        po_number: "PO-1001",
        invoice_number: "INV-1001",
        items: [{ item_id: "10016623", quantity: 3 }]
      })
    });

    assert.equal(response.status, 400);
    assert.equal(body.successful, false);
    assert.equal(body.asn_sync_status, "REJECTED");
    assert.equal(body.po_number, "PO-1001");
    assert.equal(body.invoice_number, "INV-1001");
    assert.equal(body.error_count, 1);
    assert.equal(body.data.errors[0].code, "E108");
  });
});

test("PO amendment endpoint returns updated_items in documented shape", async () => {
  await withServer(async (baseUrl) => {
    const { response, body } = await request(baseUrl, "/webhook/public/v1/po/amendment", {
      method: "POST",
      headers: { "Api-Key": API_KEY },
      body: JSON.stringify({
        request_data: [
          {
            item_id: "100001",
            variants: [
              {
                upc: "8900000000001",
                mrp: 99.99,
                uom: { type: "STANDARD", value: "250", unit: "g" },
                po_numbers: ["PO12345"]
              }
            ]
          }
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.message, "Items updated successfully");
    assert.equal(body.updated_items[0].item_id, "100001");
    assert.equal(body.updated_items[0].variants[0].po_numbers[0], "PO12345");
    assert.ok(body.updated_items[0].variants[0].variant_id);
  });
});

test("ERP simulator stores punched PO and makes ASN ready after configured polls", async () => {
  await withServer(async (baseUrl) => {
    await request(baseUrl, "/sim/erp/scenarios", {
      method: "POST",
      headers: { "Api-Key": API_KEY },
      body: JSON.stringify({
        poNumber: "PO-2001",
        punchPo: { mode: "success", externalReference: "ERP-PO-2001" },
        asnDetails: { mode: "ready", readyAfterPolls: 2 }
      })
    });

    const punch = await request(baseUrl, "/sim/erp/purchase-orders", {
      method: "POST",
      headers: { "Api-Key": API_KEY, "Idempotency-Key": "idem-po-2001" },
      body: JSON.stringify({ po_number: "PO-2001", item_data: [] })
    });
    const firstPoll = await request(baseUrl, "/sim/erp/asn-details/PO-2001", {
      headers: { "Api-Key": API_KEY }
    });
    const secondPoll = await request(baseUrl, "/sim/erp/asn-details/PO-2001", {
      headers: { "Api-Key": API_KEY }
    });

    assert.equal(punch.response.status, 201);
    assert.equal(punch.body.externalReference, "ERP-PO-2001");
    assert.equal(firstPoll.response.status, 202);
    assert.equal(firstPoll.body.status, "not_ready");
    assert.equal(secondPoll.response.status, 200);
    assert.equal(secondPoll.body.status, "ready");
    assert.equal(secondPoll.body.asn.po_number, "PO-2001");
  });
});

test("Sheet simulator stores rows by sheet id", async () => {
  await withServer(async (baseUrl) => {
    const row = { po_number: "PO-3001", status: "ACCEPTED" };

    const write = await request(baseUrl, "/sim/sheets/seller-123-po-sync/rows", {
      method: "POST",
      headers: { "Api-Key": API_KEY },
      body: JSON.stringify(row)
    });
    const read = await request(baseUrl, "/sim/sheets/seller-123-po-sync/rows", {
      headers: { "Api-Key": API_KEY }
    });

    assert.equal(write.response.status, 201);
    assert.equal(write.body.sheetId, "seller-123-po-sync");
    assert.deepEqual(read.body.rows[0].data, row);
  });
});
