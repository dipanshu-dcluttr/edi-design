# EDI Simulation API Curl Docs

Complete curl guide for local simulator APIs.

## Setup

Start simulator:

```bash
npm start --prefix dev/simulation-api
```

Set reusable variables:

```bash
export SIM_BASE_URL="http://127.0.0.1:4500"
export SIM_API_KEY="dev-api-key"
```

All `/sim/*` and `/webhook/public/*` APIs require:

```bash
-H "Api-Key: $SIM_API_KEY"
```

## Health

No auth required.

```bash
curl -s "$SIM_BASE_URL/health" | jq
```

Expected shape:

```json
{
  "ok": true,
  "services": ["sim-blinkit-api", "sim-erp-api", "sim-sheet-api"]
}
```

## Direction Map

`Blinkit hits us`:

- Real world: Blinkit sends PO creation webhook to our app.
- Local simulator: call `POST /sim/blinkit/po-webhooks` with your app ingress `targetUrl`; simulator sends the PDF-shaped PO creation payload to your app.

`We hit Blinkit`:

- Our app sends PO ack to `POST /webhook/public/v1/po/acknowledgement`.
- Our app sends ASN to `POST /webhook/public/v1/asn`.
- Our app sends PO amendment to `POST /webhook/public/v1/po/amendment`.

`We hit ERP`:

- Our app punches PO to `POST /sim/erp/purchase-orders`.
- Our app polls ASN source at `GET /sim/erp/asn-details/{poNumber}`.

`We hit Sheet`:

- Our app syncs rows to `POST /sim/sheets/{sheetId}/rows`.

## Blinkit Hits Us: Send PO Creation Webhook To Our App

Use this when your app has an ingress/webhook endpoint running.

```bash
curl -s -X POST "$SIM_BASE_URL/sim/blinkit/po-webhooks" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "poNumber": "2264110001440",
    "tenant": "HYPERPURE",
    "targetUrl": "http://127.0.0.1:3000/webhooks/blinkit/po",
    "apiKey": "vendor-ingress-api-key"
  }' | jq
```

What happens:

- Simulator builds Blinkit PO creation payload from PDF contract.
- Simulator sends it to `targetUrl`.
- Header sent to your app: `Api-Key: vendor-ingress-api-key`.
- Response includes target HTTP status and response body.

Generate PO creation payload without sending to your app:

```bash
curl -s -X POST "$SIM_BASE_URL/sim/blinkit/po-webhooks" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "poNumber": "2264110001440",
    "tenant": "HYPERPURE"
  }' | jq
```

Inspect generated/sent PO webhooks:

```bash
curl -s "$SIM_BASE_URL/sim/blinkit/received/po-webhooks" \
  -H "Api-Key: $SIM_API_KEY" | jq
```

## We Hit Blinkit: Configure Platform Scenario

Set ASN rejection:

```bash
curl -s -X POST "$SIM_BASE_URL/sim/blinkit/scenarios" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "asnResponse": {
      "mode": "rejected",
      "errors": [
        {
          "code": "E108",
          "level": "asn",
          "message": "Invoice date cannot be before PO issue date",
          "error_params": {
            "po_number": "PO-1001",
            "invoice_number": "INV-1001"
          }
        }
      ]
    }
  }' | jq
```

Set ASN partial success:

```bash
curl -s -X POST "$SIM_BASE_URL/sim/blinkit/scenarios" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "asnResponse": {
      "mode": "partial_success",
      "errors": [
        {
          "code": "E112",
          "level": "item",
          "message": "Item IDs are incorrect",
          "error_params": {
            "item_ids": ["10016623"]
          }
        }
      ]
    },
    "latencyMs": 250
  }' | jq
```

Reset Blinkit scenario to accepted ASN:

```bash
curl -s -X POST "$SIM_BASE_URL/sim/blinkit/scenarios" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "asnResponse": {
      "mode": "accepted",
      "errors": []
    },
    "latencyMs": 0
  }' | jq
```

## We Hit Blinkit: PO Acknowledgement

Endpoint matches partnersbiz PDF path:

```text
POST /webhook/public/v1/po/acknowledgement
```

Curl:

```bash
curl -s -X POST "$SIM_BASE_URL/webhook/public/v1/po/acknowledgement" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "success": true,
    "message": "PO synced completed.",
    "timestamp": "2025-04-17T10:30:00Z",
    "data": {
      "po_status": "ACCEPTED",
      "po_number": "PO-1001",
      "errors": [],
      "warnings": []
    }
  }' | jq
```

Expected response shape:

```json
{
  "success": true,
  "message": "Successfully Acknowledged.",
  "timestamp": "2026-04-29T..."
}
```

Inspect received PO acknowledgements:

```bash
curl -s "$SIM_BASE_URL/sim/blinkit/received/po-acks" \
  -H "Api-Key: $SIM_API_KEY" | jq
```

## We Hit Blinkit: ASN Sync

Endpoint matches partnersbiz PDF path:

```text
POST /webhook/public/v1/asn
```

Curl:

```bash
curl -s -X POST "$SIM_BASE_URL/webhook/public/v1/asn" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "po_number": "PO-1001",
    "invoice_number": "INV-1001",
    "invoice_date": "2025-07-07",
    "delivery_date": "2025-07-07",
    "total_additional_cess_value": 0,
    "tax_distribution": [
      {
        "gst_type": "CGST",
        "gst_percentage": 12,
        "gst_total": 1816.92,
        "taxable_value": "11972.45"
      }
    ],
    "basic_price": "20188",
    "landing_price": "449.21",
    "box_count": "2",
    "quantity": "50",
    "case_config": 25,
    "item_count": "1",
    "po_status": "PO_FULFILLED",
    "supplier_details": {
      "name": "supplierLegalName",
      "gstin": "22ABCDE1234F1Z5",
      "supplier_address": {
        "address_line_1": "123 Market Street",
        "address_line_2": "Suite 45B",
        "city": "Mumbai",
        "country": "India",
        "phone": "+91-9876543210",
        "postal_code": "400001",
        "state": "Maharashtra"
      }
    },
    "buyer_details": {
      "gstin": "22ABCDE1234F1Z5"
    },
    "shipment_details": {
      "e_way_bill_number": "12345",
      "delivery_type": "COURIER",
      "delivery_partner": "BlueDart",
      "delivery_tracking_code": "123456",
      "license_number": "DL-311/431",
      "driver_phone_number": "7703862000"
    },
    "items": [
      {
        "item_id": "10016623",
        "sku_code": "SKU_CODE2",
        "batch_number": "DIA013A",
        "sku_description": "SKU Description",
        "upc": "8901023019258",
        "quantity": 3,
        "mrp": 990,
        "hsn_code": "38089199",
        "tax_distribution": {
          "cgst_percentage": 9,
          "sgst_percentage": 9,
          "igst_percentage": 18,
          "ugst_percentage": 4,
          "cess_percentage": 2,
          "additional_cess_value": 0
        },
        "unit_discount_amount": "100",
        "unit_discount_percentage": "25",
        "unit_basic_price": 311.91,
        "unit_landing_price": "506",
        "expiry_date": "2025-07-07",
        "mfg_date": "2025-01-01",
        "uom": {
          "unit": "ml",
          "value": 12
        },
        "no_of_packages": "2",
        "code_category": "QR",
        "codes": ["c2a468ac-2f17-4d6b-a52f-faa2678feaee"],
        "case_configuration": [
          {
            "level": "outer_case",
            "type": "CRATE",
            "value": 12
          }
        ]
      }
    ]
  }' | jq
```

Inspect received ASNs:

```bash
curl -s "$SIM_BASE_URL/sim/blinkit/received/asns" \
  -H "Api-Key: $SIM_API_KEY" | jq
```

## We Hit Blinkit: PO Amendment

Endpoint matches partnersbiz PDF path:

```text
POST /webhook/public/v1/po/amendment
```

Curl:

```bash
curl -s -X POST "$SIM_BASE_URL/webhook/public/v1/po/amendment" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "request_data": [
      {
        "item_id": "100001",
        "variants": [
          {
            "upc": "8900000000001",
            "mrp": 99.99,
            "uom": {
              "type": "STANDARD",
              "value": "250",
              "unit": "g"
            },
            "po_numbers": ["PO12345"]
          }
        ]
      }
    ]
  }' | jq
```

Inspect received amendments:

```bash
curl -s "$SIM_BASE_URL/sim/blinkit/received/amendments" \
  -H "Api-Key: $SIM_API_KEY" | jq
```

## We Hit ERP: Configure Scenario

Ready after two ASN polls:

```bash
curl -s -X POST "$SIM_BASE_URL/sim/erp/scenarios" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "poNumber": "PO-2001",
    "punchPo": {
      "mode": "success",
      "externalReference": "ERP-PO-2001"
    },
    "asnDetails": {
      "mode": "ready",
      "readyAfterPolls": 2
    }
  }' | jq
```

ERP permanent mapping failure:

```bash
curl -s -X POST "$SIM_BASE_URL/sim/erp/scenarios" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "poNumber": "PO-FAIL-1",
    "punchPo": {
      "mode": "failure"
    }
  }' | jq
```

ASN data incomplete:

```bash
curl -s -X POST "$SIM_BASE_URL/sim/erp/scenarios" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "poNumber": "PO-INCOMPLETE-ASN",
    "asnDetails": {
      "mode": "incomplete",
      "missingFields": ["invoice_number", "shipment_details.e_way_bill_number"]
    }
  }' | jq
```

## We Hit ERP: Punch Purchase Order

```bash
curl -s -X POST "$SIM_BASE_URL/sim/erp/purchase-orders" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Idempotency-Key: idem-po-2001" \
  -H "Content-Type: application/json" \
  -d '{
    "po_number": "PO-2001",
    "tenant": "HYPERPURE",
    "supplier_id": "seller_123",
    "item_data": [
      {
        "item_id": "10016623",
        "units_ordered": 240,
        "landing_price": 32.56
      }
    ]
  }' | jq
```

Fetch stored ERP PO:

```bash
curl -s "$SIM_BASE_URL/sim/erp/purchase-orders/PO-2001" \
  -H "Api-Key: $SIM_API_KEY" | jq
```

## We Hit ERP: Poll ASN Details

First poll may return `202 not_ready` if `readyAfterPolls` not reached:

```bash
curl -s -i "$SIM_BASE_URL/sim/erp/asn-details/PO-2001" \
  -H "Api-Key: $SIM_API_KEY"
```

Second poll for scenario above returns ready ASN payload:

```bash
curl -s "$SIM_BASE_URL/sim/erp/asn-details/PO-2001" \
  -H "Api-Key: $SIM_API_KEY" | jq
```

## We Hit Sheet: Configure Scenario

Default is success. Permission failure:

```bash
curl -s -X POST "$SIM_BASE_URL/sim/sheets/seller-123-po-sync/scenarios" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "syncPo": {
      "mode": "permission_error"
    }
  }' | jq
```

Reset to success:

```bash
curl -s -X POST "$SIM_BASE_URL/sim/sheets/seller-123-po-sync/scenarios" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "syncPo": {
      "mode": "success",
      "duplicatePolicy": "update_existing"
    }
  }' | jq
```

## We Hit Sheet: Add Row

```bash
curl -s -X POST "$SIM_BASE_URL/sim/sheets/seller-123-po-sync/rows" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "po_number": "PO-3001",
    "tenant": "HYPERPURE",
    "seller_id": "seller_123",
    "status": "ACCEPTED",
    "total_qty": 240,
    "total_amount": 42
  }' | jq
```

Fetch sheet rows:

```bash
curl -s "$SIM_BASE_URL/sim/sheets/seller-123-po-sync/rows" \
  -H "Api-Key: $SIM_API_KEY" | jq
```

## Auth Failure Example

```bash
curl -s -i -X POST "$SIM_BASE_URL/webhook/public/v1/po/acknowledgement" \
  -H "Content-Type: application/json" \
  -d '{"success": true}'
```

Expected:

```text
HTTP/1.1 401 Unauthorized
```

Body:

```json
{
  "success": false,
  "message": "Unauthorized",
  "timestamp": "..."
}
```

## End-To-End Local Smoke Flow

1. Configure ERP.

```bash
curl -s -X POST "$SIM_BASE_URL/sim/erp/scenarios" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "poNumber": "PO-SMOKE-1",
    "punchPo": {
      "mode": "success",
      "externalReference": "ERP-PO-SMOKE-1"
    },
    "asnDetails": {
      "mode": "ready",
      "readyAfterPolls": 1
    }
  }' | jq
```

2. Generate Blinkit PO payload.

```bash
curl -s -X POST "$SIM_BASE_URL/sim/blinkit/po-webhooks" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "poNumber": "PO-SMOKE-1",
    "tenant": "HYPERPURE"
  }' | jq
```

3. Punch PO into ERP.

```bash
curl -s -X POST "$SIM_BASE_URL/sim/erp/purchase-orders" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Idempotency-Key: idem-po-smoke-1" \
  -H "Content-Type: application/json" \
  -d '{
    "po_number": "PO-SMOKE-1",
    "item_data": []
  }' | jq
```

4. Send PO ack to Blinkit simulator.

```bash
curl -s -X POST "$SIM_BASE_URL/webhook/public/v1/po/acknowledgement" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "success": true,
    "message": "PO synced completed.",
    "timestamp": "2025-04-17T10:30:00Z",
    "data": {
      "po_status": "ACCEPTED",
      "po_number": "PO-SMOKE-1",
      "errors": [],
      "warnings": []
    }
  }' | jq
```

5. Poll ERP ASN.

```bash
curl -s "$SIM_BASE_URL/sim/erp/asn-details/PO-SMOKE-1" \
  -H "Api-Key: $SIM_API_KEY" | jq
```

6. Send ASN to Blinkit simulator.

```bash
curl -s -X POST "$SIM_BASE_URL/webhook/public/v1/asn" \
  -H "Api-Key: $SIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "po_number": "PO-SMOKE-1",
    "invoice_number": "INV-PO-SMOKE-1",
    "items": [
      {
        "item_id": "10016623",
        "quantity": 1
      }
    ]
  }' | jq
```

7. Inspect calls captured by Blinkit simulator.

```bash
curl -s "$SIM_BASE_URL/sim/blinkit/received/po-acks" \
  -H "Api-Key: $SIM_API_KEY" | jq

curl -s "$SIM_BASE_URL/sim/blinkit/received/asns" \
  -H "Api-Key: $SIM_API_KEY" | jq
```

