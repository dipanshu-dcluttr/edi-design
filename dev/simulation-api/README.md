# EDI Simulation API

Local simulator for EDI application development.

Full curl docs: [CURLS.md](./CURLS.md)

## Run

```bash
npm start --prefix dev/simulation-api
```

Defaults:

- URL: `http://127.0.0.1:4500`
- API key: `dev-api-key`
- Override key: `SIM_API_KEY=<key>`
- Override port: `PORT=4501`

## Blinkit partnersbiz simulation

Auth and content type follow PDFs:

- Header: `Api-Key: <key>`
- Content-Type: `application/json`

Exact platform endpoints:

- `POST /webhook/public/v1/po/acknowledgement`
- `POST /webhook/public/v1/asn`
- `POST /webhook/public/v1/po/amendment`

Inspection and scenarios:

- `POST /sim/blinkit/scenarios`
- `POST /sim/blinkit/po-webhooks`
- `GET /sim/blinkit/received/po-webhooks`
- `GET /sim/blinkit/received/po-acks`
- `GET /sim/blinkit/received/asns`
- `GET /sim/blinkit/received/amendments`

Scenario example:

```json
{
  "asnResponse": {
    "mode": "rejected",
    "errors": [
      {
        "code": "E108",
        "level": "asn",
        "message": "Invoice date cannot be before PO issue date"
      }
    ]
  }
}
```

PO webhook generator:

```json
{
  "poNumber": "2264110001440",
  "tenant": "HYPERPURE",
  "targetUrl": "http://127.0.0.1:3000/webhooks/blinkit/po",
  "apiKey": "vendor-ingress-key"
}
```

## ERP simulation

- `POST /sim/erp/purchase-orders`
- `GET /sim/erp/purchase-orders/{poNumber}`
- `GET /sim/erp/asn-details/{poNumber}`
- `POST /sim/erp/scenarios`

Scenario example:

```json
{
  "poNumber": "PO-1001",
  "punchPo": {
    "mode": "success",
    "externalReference": "ERP-PO-9001"
  },
  "asnDetails": {
    "mode": "ready",
    "readyAfterPolls": 3
  }
}
```

## Sheet simulation

- `POST /sim/sheets/{sheetId}/rows`
- `GET /sim/sheets/{sheetId}/rows`
- `POST /sim/sheets/{sheetId}/scenarios`

Rows are stored in memory for local assertions.
