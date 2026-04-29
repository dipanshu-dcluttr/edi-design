import http from "node:http";
import { randomUUID } from "node:crypto";
import { createState } from "./state.js";

const DEFAULT_API_KEY = "dev-api-key";

export function createServer(options = {}) {
  const state = options.state || createState();
  const apiKey = options.apiKey || process.env.SIM_API_KEY || DEFAULT_API_KEY;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const route = `${req.method || "GET"} ${url.pathname}`;

      if (route === "GET /health") {
        return sendJson(res, 200, {
          ok: true,
          services: ["sim-blinkit-api", "sim-erp-api", "sim-sheet-api"]
        });
      }

      if (requiresAuth(url.pathname) && req.headers["api-key"] !== apiKey) {
        return sendJson(res, 401, { success: false, message: "Unauthorized", timestamp: now() });
      }

      if (route === "POST /sim/blinkit/scenarios") {
        const body = await readJson(req);
        state.blinkitScenario = mergeScenario(state.blinkitScenario, body);
        return sendJson(res, 200, state.blinkitScenario);
      }

      if (route === "GET /sim/blinkit/received/po-acks") {
        return sendJson(res, 200, state.received.poAcks);
      }

      if (route === "GET /sim/blinkit/received/po-webhooks") {
        return sendJson(res, 200, state.received.poWebhooks);
      }

      if (route === "GET /sim/blinkit/received/asns") {
        return sendJson(res, 200, state.received.asns);
      }

      if (route === "GET /sim/blinkit/received/amendments") {
        return sendJson(res, 200, state.received.amendments);
      }

      if (route === "POST /webhook/public/v1/po/acknowledgement") {
        const body = await readJson(req);
        state.received.poAcks.push(receivedCall(req, body));
        await maybeDelay(state.blinkitScenario.latencyMs);
        return sendJson(res, 200, platformAckResponse());
      }

      if (route === "POST /sim/blinkit/po-webhooks") {
        const body = await readJson(req);
        const payload = poCreationPayload(body.poNumber || body.po_number || "2264110001440", body.tenant || "HYPERPURE");
        const record = {
          id: randomUUID(),
          targetUrl: body.targetUrl || null,
          payload,
          sentAt: null,
          targetResponseStatus: null,
          targetResponseBody: null,
          createdAt: now()
        };
        if (body.targetUrl) {
          const targetResponse = await fetch(body.targetUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Api-Key": body.apiKey || apiKey
            },
            body: JSON.stringify(payload)
          });
          record.sentAt = now();
          record.targetResponseStatus = targetResponse.status;
          const text = await targetResponse.text();
          record.targetResponseBody = text ? parseMaybeJson(text) : null;
        }
        state.received.poWebhooks.push(record);
        return sendJson(res, 201, { sent: Boolean(body.targetUrl), ...record });
      }

      if (route === "POST /webhook/public/v1/asn") {
        const body = await readJson(req);
        state.received.asns.push(receivedCall(req, body));
        await maybeDelay(state.blinkitScenario.latencyMs);
        const result = platformAsnResponse(body, state.blinkitScenario.asnResponse);
        return sendJson(res, result.httpStatus, result.body);
      }

      if (route === "POST /webhook/public/v1/po/amendment") {
        const body = await readJson(req);
        state.received.amendments.push(receivedCall(req, body));
        await maybeDelay(state.blinkitScenario.latencyMs);
        const result = platformAmendmentResponse(body, state.blinkitScenario.amendmentResponse);
        return sendJson(res, result.httpStatus, result.body);
      }

      if (route === "POST /sim/erp/scenarios") {
        const body = await readJson(req);
        if (!body.poNumber) {
          return sendJson(res, 400, { success: false, message: "poNumber is required" });
        }
        state.erpScenarios.set(body.poNumber, mergeScenario(defaultErpScenario(body.poNumber), body));
        return sendJson(res, 200, state.erpScenarios.get(body.poNumber));
      }

      if (route === "POST /sim/erp/purchase-orders") {
        const body = await readJson(req);
        const poNumber = body.po_number || body.poNumber;
        if (!poNumber) {
          return sendJson(res, 400, { success: false, message: "po_number is required" });
        }
        const scenario = state.erpScenarios.get(poNumber) || defaultErpScenario(poNumber);
        if (scenario.punchPo?.mode === "failure") {
          return sendJson(res, 422, {
            success: false,
            code: "ERP_MAPPING_ERROR",
            message: "ERP rejected purchase order"
          });
        }
        const record = {
          poNumber,
          externalReference: scenario.punchPo?.externalReference || `ERP-${poNumber}`,
          idempotencyKey: req.headers["idempotency-key"] || null,
          body,
          createdAt: now()
        };
        state.erpPurchaseOrders.set(poNumber, record);
        return sendJson(res, 201, { success: true, poNumber, externalReference: record.externalReference });
      }

      const erpPoMatch = url.pathname.match(/^\/sim\/erp\/purchase-orders\/([^/]+)$/);
      if (req.method === "GET" && erpPoMatch) {
        const poNumber = decodeURIComponent(erpPoMatch[1]);
        const record = state.erpPurchaseOrders.get(poNumber);
        if (!record) {
          return sendJson(res, 404, { success: false, message: "Purchase order not found" });
        }
        return sendJson(res, 200, record);
      }

      const erpAsnMatch = url.pathname.match(/^\/sim\/erp\/asn-details\/([^/]+)$/);
      if (req.method === "GET" && erpAsnMatch) {
        const poNumber = decodeURIComponent(erpAsnMatch[1]);
        const scenario = state.erpScenarios.get(poNumber) || defaultErpScenario(poNumber);
        const count = (state.erpPolls.get(poNumber) || 0) + 1;
        state.erpPolls.set(poNumber, count);
        const readyAfterPolls = scenario.asnDetails?.readyAfterPolls ?? 1;
        if (scenario.asnDetails?.mode === "incomplete") {
          return sendJson(res, 422, { status: "data_incomplete", missingFields: scenario.asnDetails.missingFields || [] });
        }
        if (count < readyAfterPolls) {
          return sendJson(res, 202, { status: "not_ready", pollCount: count, nextPollAfterSeconds: 60 });
        }
        return sendJson(res, 200, { status: "ready", pollCount: count, asn: erpAsnPayload(poNumber) });
      }

      const sheetScenarioMatch = url.pathname.match(/^\/sim\/sheets\/([^/]+)\/scenarios$/);
      if (req.method === "POST" && sheetScenarioMatch) {
        const sheetId = decodeURIComponent(sheetScenarioMatch[1]);
        const body = await readJson(req);
        state.sheetScenarios.set(sheetId, mergeScenario({ syncPo: { mode: "success" } }, body));
        return sendJson(res, 200, { sheetId, scenario: state.sheetScenarios.get(sheetId) });
      }

      const sheetRowsMatch = url.pathname.match(/^\/sim\/sheets\/([^/]+)\/rows$/);
      if (sheetRowsMatch) {
        const sheetId = decodeURIComponent(sheetRowsMatch[1]);
        if (req.method === "GET") {
          return sendJson(res, 200, { sheetId, rows: state.sheets.get(sheetId) || [] });
        }
        if (req.method === "POST") {
          const scenario = state.sheetScenarios.get(sheetId) || { syncPo: { mode: "success" } };
          if (scenario.syncPo?.mode === "permission_error") {
            return sendJson(res, 403, { success: false, message: "Sheet permission denied" });
          }
          const body = await readJson(req);
          const rows = state.sheets.get(sheetId) || [];
          const row = { rowId: randomUUID(), data: body, createdAt: now() };
          rows.push(row);
          state.sheets.set(sheetId, rows);
          return sendJson(res, 201, { success: true, sheetId, row });
        }
      }

      return sendJson(res, 404, { success: false, message: "Not found" });
    } catch (error) {
      return sendJson(res, 500, {
        success: false,
        message: "Internal simulator error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return { server, state };
}

function requiresAuth(pathname) {
  return pathname.startsWith("/webhook/public/") || pathname.startsWith("/sim/");
}

function now() {
  return new Date().toISOString();
}

function mergeScenario(base, patch) {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    output[key] = isObject(value) && isObject(base[key]) ? mergeScenario(base[key], value) : value;
  }
  return output;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function receivedCall(req, body) {
  return {
    id: randomUUID(),
    headers: req.headers,
    body,
    receivedAt: now()
  };
}

function platformAckResponse() {
  return {
    success: true,
    message: "Successfully Acknowledged.",
    timestamp: now()
  };
}

function poCreationPayload(poNumber, tenant) {
  return {
    type: "PO_CREATION",
    po_number: poNumber,
    tenant,
    details: {
      po_number: poNumber,
      outlet_id: 12543,
      issue_date: "2025-04-20T00:00:00.000Z",
      expiry_date: "2025-04-20T00:00:00.000Z",
      delivery_date: "2025-04-25T00:00:00.000Z",
      vehicle_details: { license_number: "DL-311/431" },
      buyer_details: {
        name: "Buyer name",
        gstin: "27ABCDE1234F1Z5",
        destination_address: {
          line1: "123, Street",
          line2: "Ghatkopar",
          city: "Mumbai",
          state: "Maharashtra",
          postal_code: "400077",
          country: "India"
        },
        registered_address: {
          line1: "Plot 45, MIDC",
          line2: "Andheri East",
          city: "Mumbai",
          state: "Maharashtra",
          postal_code: "400093",
          country: "India"
        },
        contact_details: [{ name: "Warehouse Manager", phone: "9876543210", email: "wh.manager@company.com" }]
      },
      supplier_details: {
        id: "67890",
        name: "ABC Suppliers Pvt Ltd",
        gstin: "27ABCDE1234F1Z5",
        pan: "ABCDE1234F",
        shipping_address: {
          line1: "123, Vendor Street",
          line2: "Ghatkopar",
          city: "Mumbai",
          state: "Maharashtra",
          postal_code: "400077",
          country: "India"
        },
        registered_address: {
          line1: "Unit 12, Industrial Estate",
          line2: "Sion",
          city: "Mumbai",
          state: "Maharashtra",
          postal_code: "400022",
          country: "India"
        },
        contact_details: [{ name: "Vendor Sales Rep", phone: "9123456789", email: "sales@abcvendors.com" }]
      },
      item_data: [
        {
          item_id: 10016623,
          sku_code: "",
          line_number: 0,
          units_ordered: 240,
          landing_price: 32.56,
          basic_price: 31.01,
          tax_details: {
            cgst_percentage: 2.5,
            sgst_percentage: 2.5,
            igst_percentage: null,
            cess_percentage: null,
            additional_cess_value: null
          },
          crates_config: { crates_ordered: 14, crate_size: 10 },
          name: "Name of Item 0",
          mrp: 42,
          upc: "8901774002349",
          uom: { unit: "ml", value: 12 }
        }
      ],
      total_sku: 1,
      total_qty: 240,
      total_amount: 42,
      custom_attributes: [{ name: "", value: "" }]
    }
  };
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function platformAsnResponse(payload, scenario = {}) {
  const mode = scenario.mode || "accepted";
  const errors = scenario.errors || [];
  const items = Array.isArray(payload.items) ? payload.items : [];
  const rejected = mode === "rejected";
  const partial = mode === "partial_success";
  return {
    httpStatus: rejected ? 400 : 200,
    body: {
      successful: !rejected,
      success_count: partial ? Math.max(items.length - errors.length, 0) : rejected ? 0 : items.length,
      error_count: errors.length,
      asn_sync_status: rejected ? "REJECTED" : partial ? "PARTIALLY_ACCEPTED" : "ACCEPTED",
      invoice_number: payload.invoice_number || payload.invoiceNumber || null,
      po_number: payload.po_number || payload.poNumber || null,
      asn_id: rejected ? null : `Blinkit_${randomUUID()}`,
      message: rejected
        ? "ASN rejected."
        : partial
          ? "ASN accepted partially. Some items were rejected."
          : "ASN accepted successfully.",
      timestamp: now(),
      data: { errors }
    }
  };
}

function platformAmendmentResponse(payload, scenario = {}) {
  if (scenario.mode === "failure") {
    return { httpStatus: 422, body: { success: false, message: "Items update failed", updated_items: [] } };
  }
  const updatedItems = (payload.request_data || []).map((item) => ({
    item_id: item.item_id,
    variants: (item.variants || []).map((variant) => ({
      ...variant,
      variant_id: randomUUID(),
      tax: 5,
      cost_price: Number((Number(variant.mrp || 0) * 0.95).toFixed(2)),
      landing_price: Number(variant.mrp || 0),
      quantity: 2,
      margin_percentage: null
    }))
  }));
  return { httpStatus: 200, body: { success: true, message: "Items updated successfully", updated_items: updatedItems } };
}

function defaultErpScenario(poNumber) {
  return {
    poNumber,
    punchPo: { mode: "success", externalReference: `ERP-${poNumber}` },
    asnDetails: { mode: "ready", readyAfterPolls: 1, missingFields: [] }
  };
}

function erpAsnPayload(poNumber) {
  return {
    po_number: poNumber,
    invoice_number: `INV-${poNumber}`,
    invoice_date: "2025-07-07",
    delivery_date: "2025-07-07",
    total_additional_cess_value: 0,
    tax_distribution: [],
    basic_price: "100",
    landing_price: "110",
    box_count: "1",
    quantity: "1",
    case_config: 1,
    item_count: "1",
    po_status: "PO_FULFILLED",
    supplier_details: {
      name: "Simulator Supplier",
      gstin: "22ABCDE1234F1Z5",
      supplier_address: {
        address_line_1: "123 Market Street",
        address_line_2: "Suite 45B",
        city: "Mumbai",
        country: "India",
        phone: "+91-9876543210",
        postal_code: "400001",
        state: "Maharashtra"
      }
    },
    buyer_details: { gstin: "22ABCDE1234F1Z5" },
    shipment_details: {
      e_way_bill_number: "12345",
      delivery_type: "COURIER",
      delivery_partner: "BlueDart",
      delivery_tracking_code: "123456",
      license_number: "DL-311/431",
      driver_phone_number: "7703862000"
    },
    items: [
      {
        item_id: "10016623",
        sku_code: "SKU_CODE2",
        batch_number: "DIA013A",
        sku_description: "SKU Description",
        upc: "8901023019258",
        quantity: 1,
        mrp: 990,
        hsn_code: "38089199",
        tax_distribution: {
          cgst_percentage: 9,
          sgst_percentage: 9,
          igst_percentage: 18,
          ugst_percentage: 4,
          cess_percentage: 2,
          additional_cess_value: 0
        },
        unit_discount_amount: "0",
        unit_discount_percentage: "0",
        unit_basic_price: 100,
        unit_landing_price: "110",
        expiry_date: "2025-07-07",
        mfg_date: "2025-01-01",
        uom: { unit: "ml", value: 12 },
        no_of_packages: "1",
        code_category: "QR",
        codes: [randomUUID()],
        case_configuration: [{ level: "outer_case", type: "CRATE", value: 12 }]
      }
    ]
  };
}

async function maybeDelay(latencyMs) {
  if (!latencyMs) return;
  await new Promise((resolve) => setTimeout(resolve, latencyMs));
}
