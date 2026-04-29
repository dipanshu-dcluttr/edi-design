# EDI Production Database and Queue Schema

This is the production persistence and queue contract in operator-friendly form. It intentionally avoids DDL and shows tables, columns, examples, and how one PO event flows to completion.

## 1. Flow Model

We run two executable workflows and show one business journey.

```text
PO webhook
-> raw_events
-> purchase_order document/version
-> PO workflow
-> schedule_asn_tracking action
-> asn_tracking_jobs
-> ASN source poller
-> advance_shipment_notice document/version
-> ASN workflow
-> Blinkit ASN sync
```

Core decision:

| Decision | Choice |
|---|---|
| PO workflow | Validates PO, punches/syncs destination, sends PO ack, schedules ASN tracking. |
| ASN tracking | Durable job/timer, not a long-running action. |
| ASN workflow | Starts only after ASN source data creates an ASN document/version. |
| User view | One PO-to-ASN journey graph stitched from linked rows. |

## 2. Aggregate Key

`aggregate_key` is the readable business identity for one ordered lane. It is not a universal industry string format, but the concept is standard: aggregate id, business key, correlation key, message key, or partition key.

Use both readable key and hash:

| Field | Example | Why |
|---|---|---|
| `aggregate_key` | `blinkit:seller_123:purchase_order:PO-1001` | Human-readable logs, support, audit, UI search. |
| `aggregate_key_hash` | `sha256:7b8f4e...` | Compact lock key, queue routing key, high-cardinality index. |

Do not use only Base64. Base64 is encoding, not identity. Do not use only hash. Hash is compact but painful for async debugging.

Recommended construction:

```text
aggregate_key = platform_code + ":" + seller_id + ":" + document_type + ":" + external_document_id
aggregate_key_hash = sha256(canonical aggregate key input)
```

If any part can contain `:`, hash from canonical JSON and keep display key escaped:

```json
{"platform":"blinkit","sellerId":"seller_123","documentType":"purchase_order","externalDocumentId":"PO-1001"}
```

### 2.1 External Identity Resolution

Blinkit does not send our internal `vendor_id`, `seller_id`, or `brand_id`. Blinkit sends partner-side identifiers such as `tenant`, `details.supplier_details.id`, `details.supplier_details.gstin`, `details.outlet_id`, and line-level `details.item_data[].item_id`.

Resolve external identifiers at ingestion, then store internal ids on runtime rows:

```text
Blinkit tenant + supplier_details.id + optional GSTIN/outlet
-> platform_accounts
-> vendor_id + seller_id

Blinkit item_id / sku_code / upc
-> seller_item_mappings
-> brand_id
```

Keep Blinkit account identity in `platform_accounts`. Keep Blinkit item identity in `seller_item_mappings`. Store resolved `vendor_id` and `seller_id` on `raw_events`, `documents`, workflow rows, jobs, and audit rows. Use `brand_id` only as internal product/brand enrichment unless a partner API explicitly requires it.

## 3. Table Groups

| Group | Tables |
|---|---|
| Platform/shared config | `brands` |
| Vendor/config | `vendors`, `sellers`, `seller_locations`, `seller_contacts`, `seller_tax_profiles`, `seller_item_mappings`, `platform_accounts`, `credentials` |
| Ingestion/document | `raw_events`, `idempotency_keys`, `documents`, `document_versions`, `document_links` |
| Workflow design/runtime | `workflow_templates`, `workflow_versions`, `workflow_nodes`, `workflow_edges`, `workflow_layouts`, `workflow_assignments`, `workflow_runs`, `workflow_node_runs` |
| Actions/results | `action_attempts`, `approval_tasks`, `validation_results`, `partner_messages` |
| Rules/config | `rule_definitions`, `ruleset_versions`, `ruleset_rules`, `ruleset_assignments`, `action_plugin_configs`, `approval_policy_versions`, `retry_policy_versions`, `resolved_config_snapshots`, `plugin_registry` |
| ASN build/config | `asn_source_configs`, `asn_build_snapshots` |
| Async/audit | `outbox`, `asn_tracking_jobs`, `asn_tracking_job_attempts`, `domain_events`, `state_transitions`, `dead_letters`, `audit_log` |

### 3.1 Config vs State For ASN

ASN creation should not copy onboarding config blindly at send time without traceability. The system should resolve config, build canonical ASN, then freeze the build inputs in `asn_build_snapshots`.

| Field/Concern | Store As | Tables |
|---|---|---|
| Vendor/customer identity | Onboarding config | `vendors` |
| Seller legal entity | Onboarding config | `sellers`, `seller_tax_profiles` |
| Warehouse/ship-from address | Onboarding config | `seller_locations` |
| Warehouse/billing contacts | Onboarding config | `seller_contacts` |
| Platform seller account and Blinkit supplier mapping | Onboarding config | `platform_accounts` |
| Brand identity | Platform/shared config | `brands`, referenced by `seller_item_mappings.brand_id` |
| SKU, brand, UPC, HSN, UOM, case defaults | Onboarding config | `seller_item_mappings` |
| ASN source/poll policy | Published config | `asn_source_configs`, `resolved_config_snapshots` |
| PO number, ordered item lines, buyer/facility details | Document state | `document_versions` for PO |
| Invoice number/date, shipped qty, batch, expiry, package details | Source state | `asn_tracking_job_attempts.response_ref`, then ASN `document_versions.canonical_json` |
| Exact config rows used to build ASN | Build audit state | `asn_build_snapshots` |
| Final ASN sent to Blinkit | Document/action evidence | ASN `document_versions`, `action_attempts`, `partner_messages` |

## 4. Table Catalog

### 4.0 brands

**Description:** Platform-wide brand catalog already owned by the broader product platform.

**Purpose:** Provides the `brand_id` mapping key used by seller item mappings, PO/ASN line attribution, reporting, and platform-wide product identity.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `brand_id` | PK / Platform mapping key | `brand_101` | Platform-wide brand id used across the entire platform. |
| `brand_name` | - | `Acme Staples` | Brand display name. |

### 4.1 vendors

**Description:** Vendor/customer organization using the EDI platform.

**Purpose:** Scopes sellers, platform accounts, documents, credentials, workflows, and audit records to the customer organization.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `vendor_acme` | Primary vendor id. |
| `code` | Mapping key | `acme` | Stable unique vendor code. |
| `name` | - | `Acme Foods` | Display name. |
| `status` | - | `active` | `active`, `suspended`, or `deleted`. |
| `metadata_json` | Config/state | `{}` | Non-secret vendor attributes. |
| `created_at` | - | `2026-04-29T10:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:00:00Z` | Last update timestamp. |

### 4.2 sellers

**Description:** Seller/fulfillment entity under a vendor.

**Purpose:** Stores the fulfillment/legal entity used to select default ship-from, tax profile, platform account, and ASN configuration.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `seller_123` | Seller id used by documents/workflows. |
| `vendor_id` | FK | `vendor_acme` | Owning vendor. |
| `seller_code` | Mapping key | `seller_123` | Business seller code. |
| `name` | - | `Acme North Warehouse` | Display name. |
| `legal_name` | - | `Acme Foods Pvt Ltd` | Legal seller entity name used in tax/commercial docs. |
| `default_ship_from_location_id` | FK | `loc_wh_mum_01` | Default warehouse/ship-from location. |
| `default_tax_profile_id` | FK | `tax_seller_123_gst` | Default GST/tax profile. |
| `status` | - | `active` | Seller availability. |
| `metadata_json` | Config/state | `{"erpCustomerCode":"ACME-NORTH"}` | Extra non-secret seller metadata. |
| `created_at` | - | `2026-04-29T10:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:00:00Z` | Last update timestamp. |

### 4.2.1 seller_locations

**Description:** Warehouse, billing, registered-office, and ship-from addresses. ASN commonly needs supplier/ship-from details, so do not hide these only in `metadata_json`.

**Purpose:** Supplies warehouse, bill-from, and registered-address data required for ASN ship-from and supplier details.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `loc_wh_mum_01` | Seller location id. |
| `vendor_id` | FK | `vendor_acme` | Owning vendor. |
| `seller_id` | FK | `seller_123` | Owning seller. |
| `location_code` | Mapping key | `MUM-WH-01` | Seller/location code used by ERP/platform config. |
| `location_type` | - | `warehouse` | `warehouse`, `billing`, `registered_office`, `returns`, etc. |
| `name` | - | `Mumbai North Warehouse` | Location display name. |
| `address_line1` | - | `Plot 12, Logistics Park` | Address line 1. |
| `address_line2` | - | `Bhiwandi` | Address line 2. |
| `city` | - | `Mumbai` | City. |
| `state` | - | `Maharashtra` | State. |
| `state_code` | - | `MH` | State code if needed by tax/platform. |
| `postal_code` | - | `421302` | PIN/postal code. |
| `country` | - | `IN` | ISO country code. |
| `gstin` | - | `27ABCDE1234F1Z5` | GSTIN for this location if applicable. |
| `is_default_ship_from` | - | `true` | Default ship-from location for ASN. |
| `is_default_bill_from` | - | `true` | Default bill-from/tax location. |
| `metadata_json` | Config/state | `{"dockCode":"D-4"}` | Extra non-secret location metadata. |
| `created_at` | - | `2026-04-29T10:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:00:00Z` | Last update timestamp. |

### 4.2.2 seller_contacts

**Description:** Operational and document contacts.

**Purpose:** Stores operational contacts used for ASN/PO exception handling and platform communications.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `contact_wh_mum_ops` | Contact id. |
| `vendor_id` | FK | `vendor_acme` | Owning vendor. |
| `seller_id` | FK | `seller_123` | Owning seller. |
| `seller_location_id` | FK | `loc_wh_mum_01` | Optional location-specific contact. |
| `contact_type` | - | `warehouse_ops` | `warehouse_ops`, `billing`, `escalation`, `technical`. |
| `name` | - | `Ravi Kumar` | Contact name. |
| `email` | - | `ravi@example.com` | Contact email. |
| `phone` | - | `+919999999999` | Contact phone. |
| `is_primary` | - | `true` | Primary contact for this type. |
| `created_at` | - | `2026-04-29T10:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:00:00Z` | Last update timestamp. |

### 4.2.3 seller_tax_profiles

**Description:** Tax identity/config used for invoice and ASN supplier details.

**Purpose:** Provides GST/PAN/legal tax identity used when building invoice and ASN supplier details.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `tax_seller_123_gst` | Tax profile id. |
| `vendor_id` | FK | `vendor_acme` | Owning vendor. |
| `seller_id` | FK | `seller_123` | Owning seller. |
| `seller_location_id` | FK | `loc_wh_mum_01` | Location this tax profile belongs to. |
| `legal_name` | - | `Acme Foods Pvt Ltd` | Legal tax name. |
| `gstin` | - | `27ABCDE1234F1Z5` | GSTIN. |
| `pan` | - | `ABCDE1234F` | PAN if needed. |
| `tax_registration_type` | - | `regular` | Regular/composition/unregistered/etc. |
| `effective_from` | - | `2026-04-01` | Start date. |
| `effective_until` | - | `null` | End date if superseded. |
| `metadata_json` | Config/state | `{}` | Extra non-secret tax metadata. |
| `created_at` | - | `2026-04-29T10:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:00:00Z` | Last update timestamp. |

### 4.2.4 seller_item_mappings

**Description:** One-time or slowly changing item/SKU and brand mapping needed to build PO/ASN payloads correctly.

**Purpose:** Maps seller SKUs to platform item ids, brand ids, UPC/EAN, HSN, UOM, and case defaults used by PO and ASN lines.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `map_sku_001` | Mapping row id. |
| `vendor_id` | FK | `vendor_acme` | Owning vendor. |
| `seller_id` | FK | `seller_123` | Owning seller. |
| `brand_id` | FK / Platform mapping key | `brand_101` | Platform-wide brand id from `brands.brand_id`. |
| `platform_code` | Mapping key | `blinkit` | Platform this mapping applies to. |
| `seller_sku` | Mapping key | `ACME-RICE-1KG` | Seller/ERP SKU. |
| `platform_item_id` | Mapping key | `BLK-ITEM-7788` | Platform item id. |
| `platform_sku_code` | Mapping key | `1000007788` | Platform SKU code. |
| `upc` | Mapping key | `8901234567890` | UPC/EAN used in PO/ASN. |
| `hsn_code` | Mapping key | `10063090` | Default HSN code. |
| `uom` | - | `EA` | Unit of measure. |
| `case_config_json` | Config/state | `{"unitsPerCase":12}` | Default case/package config. |
| `shelf_life_days` | - | `180` | Default shelf life if needed for validation. |
| `status` | - | `active` | Active/inactive. |
| `effective_from` | - | `2026-04-01` | Start date. |
| `effective_until` | - | `null` | End date if superseded. |
| `metadata_json` | Config/state | `{}` | Extra mapping attributes. |
| `created_at` | - | `2026-04-29T10:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:00:00Z` | Last update timestamp. |

### 4.3 platform_accounts

**Description:** Seller account on a platform/environment. For Blinkit, this is where `tenant`, `supplier_details.id`, supplier GSTIN, and outlet mapping resolve to our internal `vendor_id` and `seller_id`.

**Purpose:** Connects a seller to a platform/environment account, stores non-secret adapter configuration, and prevents Blinkit external ids from spreading across runtime tables.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `pa_blinkit_123` | Platform account id. |
| `vendor_id` | FK | `vendor_acme` | Vendor owner. |
| `seller_id` | FK | `seller_123` | Seller owner. |
| `platform_code` | Mapping key | `blinkit` | Platform adapter key. |
| `environment` | - | `prod` | `prod`, `sandbox`, or `simulator`. |
| `external_account_id` | External key | `BLINKIT:HYPERPURE:67890` | Stable normalized platform account key. |
| `external_tenant` | External key | `HYPERPURE` | Blinkit `tenant` value from PO webhook. |
| `external_supplier_id` | External key | `67890` | Blinkit `details.supplier_details.id` supplier code. |
| `external_supplier_gstin` | External key | `27ABCDE1234F1Z5` | Blinkit supplier GSTIN used as an additional matching guard. |
| `external_outlet_ids_json` | Mapping key | `[12543]` | Blinkit outlet/facility ids allowed for this seller account. |
| `status` | - | `active` | Account status. |
| `config_json` | Config/state | `{"rateLimitPerMin":60,"identityMatch":["tenant","supplier_id","gstin"]}` | Non-secret platform config and matching policy. |
| `created_at` | - | `2026-04-29T10:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:00:00Z` | Last update timestamp. |

### 4.4 credentials

**Description:** Secret references only. Never store secret values.

**Purpose:** Points actions and source plugins to secret manager entries without storing secret values in the database.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `cred_blinkit_api` | Credential row id. |
| `vendor_id` | FK | `vendor_acme` | Vendor owner. |
| `platform_account_id` | FK | `pa_blinkit_123` | Optional linked platform account. |
| `provider` | Mapping key | `blinkit` | External provider. |
| `purpose` | Mapping key | `outbound_api` | Auth purpose. |
| `secret_ref` | Object ref | `vault://edi/acme/blinkit/api-key` | Secret manager reference. |
| `status` | - | `active` | Active/rotating/revoked. |
| `rotated_at` | - | `2026-04-01T00:00:00Z` | Last rotation time. |
| `expires_at` | - | `2026-07-01T00:00:00Z` | Optional expiry. |
| `created_at` | - | `2026-04-29T10:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:00:00Z` | Last update timestamp. |

### 4.5 raw_events

**Description:** Immutable inbound event envelope. Every webhook, duplicate, failed parse, and replay gets a row.

**Purpose:** Captures immutable inbound event envelopes and payload references before canonical document creation.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `raw_evt_001` | Raw event id. |
| `trace_id` | FK | `trc_po_1001` | End-to-end trace id. |
| `platform_code` | Mapping key | `blinkit` | Source platform. |
| `vendor_id` | FK | `vendor_acme` | Owning vendor. |
| `seller_id` | FK | `seller_123` | Seller context. |
| `event_type` | - | `purchase_order.created` | Event name. |
| `external_document_id` | External key | `PO-1001` | Platform document id. |
| `aggregate_key` | Correlation key | `blinkit:seller_123:purchase_order:PO-1001` | Readable ordering/correlation key. |
| `aggregate_key_hash` | Lock/routing key | `sha256:7b8f4e...` | Compact lock/routing key. |
| `dedupe_key` | Correlation key | `blinkit:purchase_order:PO-1001:sha256:9b21...` | Non-unique duplicate detection key. Raw events stay append-only. |
| `duplicate_of_raw_event_id` | FK | `null` | Original raw event when this row is an exact duplicate. |
| `payload_hash` | Hash | `sha256:9b21...` | Raw payload hash. |
| `headers_json` | Config/state | `{"Api-Key":"redacted"}` | Request/source headers with secrets redacted. |
| `content_type` | - | `application/json` | Payload content type. |
| `raw_payload_ref` | Object ref | `s3://edi-raw/blinkit/PO-1001.json` | Immutable object-store body. |
| `status` | - | `processed` | `stored`, `queued`, `duplicate`, `processed`, `parse_failed`, `needs_mapping`, `failed`. |
| `received_at` | - | `2026-04-29T10:00:01Z` | Inbound receive time. |
| `processed_at` | - | `2026-04-29T10:00:04Z` | Processing completion time. |
| `error_code` | - | `null` | Normalized error code if failed. |
| `error_message` | - | `null` | Safe failure message. |
| `created_at` | - | `2026-04-29T10:00:01Z` | Row creation timestamp. |
| `updated_at` | - | `2026-04-29T10:00:04Z` | Last update timestamp. |

### 4.6 idempotency_keys

**Description:** Execution claim and side-effect guard for work that needs reservation state.

**Purpose:** Coordinates worker races and retries for document processing, external actions, replays, and async jobs. It does not replace table-level unique constraints on `documents`, `document_versions`, `outbox`, `partner_messages`, or ASN job tables.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `idem_ack_doc_po_001_v1` | Row id. |
| `scope` | - | `external_action` | Claim scope: `document_processing`, `external_action`, `manual_replay`, `asn_poll`. |
| `key` | Idempotency key | `blinkit.po_ack:doc_po_001:doc_ver_po_001` | Unique claim/side-effect key within scope. |
| `aggregate_key` | Correlation key | `blinkit:seller_123:purchase_order:PO-1001` | Related readable key. |
| `aggregate_key_hash` | Lock/routing key | `sha256:7b8f4e...` | Related compact key. |
| `payload_hash` | Hash | `sha256:po-canon-v1` | Optional payload/canonical hash for claim context. |
| `first_seen_ref_type` | - | `action_attempt` | Entity that first claimed this key. |
| `first_seen_ref_id` | FK | `act_ack_1` | Entity id that first claimed this key. |
| `result_ref_type` | - | `partner_message` | Completed result entity type. |
| `result_ref_id` | FK | `msg_blinkit_ack` | Completed result entity id. |
| `status` | - | `completed` | `processing`, `completed`, `failed`, `expired`. |
| `expires_at` | - | `null` | Optional expiry. |
| `created_at` | - | `2026-04-29T10:00:01Z` | Creation timestamp. |

### 4.7 documents

**Description:** One row per logical business document identity.

**Purpose:** Stores the current canonical business document header for PO, ASN, invoice, and related document types.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `doc_po_001` | Document id. |
| `vendor_id` | FK | `vendor_acme` | Vendor owner. |
| `document_type` | - | `purchase_order` | PO, ASN, ack, or amendment. |
| `platform_code` | Mapping key | `blinkit` | Platform owner. |
| `vendor_id` | FK | `vendor_acme` | Vendor context. |
| `seller_id` | FK | `seller_123` | Seller owner. |
| `external_document_id` | External key | `PO-1001` | Platform/business document id. |
| `aggregate_key` | Correlation key | `blinkit:seller_123:purchase_order:PO-1001` | Readable document lane. |
| `aggregate_key_hash` | Lock/routing key | `sha256:7b8f4e...` | Compact lock/routing key. |
| `current_version_id` | FK | `doc_ver_po_001` | Latest immutable version. |
| `current_state` | - | `completed` | Business document state only. |
| `created_from_raw_event_id` | FK | `raw_evt_001` | Source event if applicable. |
| `created_at` | - | `2026-04-29T10:00:04Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:01:18Z` | Last update timestamp. |

### 4.8 document_versions

**Description:** Immutable canonical payload history.

**Purpose:** Stores immutable canonical payload versions so amendments and generated ASNs can be audited and replayed.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `doc_ver_po_001` | Version id. |
| `document_id` | FK | `doc_po_001` | Parent document. |
| `version` | - | `1` | Monotonic version number. |
| `source_raw_event_id` | FK | `raw_evt_001` | Source event for this version. |
| `payload_hash` | Hash | `sha256:po-canon-v1` | Canonical payload hash. |
| `canonical_json` | Config/state | `{"poNumber":"PO-1001","lines":[...]}` | Canonical document payload. |
| `partner_metadata_json` | Config/state | `{"blinkitFacility":"MUM-01"}` | Partner-specific extras. |
| `change_summary_json` | Config/state | `{}` | Difference from previous version. |
| `created_by_type` | - | `system` | `system`, `user`, `replay`, `plugin`. |
| `created_by_id` | FK | `raw_evt_001` | Creator reference. |
| `created_at` | - | `2026-04-29T10:00:04Z` | Creation timestamp. |

### 4.9 document_links

**Description:** Links related documents, especially ASN to PO.

**Purpose:** Records document relationships such as ASN generated from PO and versions used for that relationship.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `link_asn_po_001` | Link id. |
| `vendor_id` | FK | `vendor_acme` | Vendor owner. |
| `source_document_id` | FK | `doc_asn_001` | Source document, e.g. ASN. |
| `source_document_version_id` | FK | `doc_ver_asn_001` | Source version. |
| `target_document_id` | FK | `doc_po_001` | Target document, e.g. PO. |
| `target_document_version_id` | FK | `doc_ver_po_001` | Target version. |
| `link_type` | Mapping key | `generated_from` | Relationship type. |
| `metadata_json` | Config/state | `{"shipment":"SHP-77"}` | Relationship metadata. |
| `created_at` | - | `2026-05-01T07:30:13Z` | Creation timestamp. |

### 4.10 workflow_templates

**Description:** Logical workflow family.

**Purpose:** Names reusable workflow families such as Blinkit PO workflow and Blinkit ASN workflow.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `wft_blinkit_po` | Template id. |
| `vendor_id` | FK | `vendor_acme` | Vendor owner or null for global. |
| `name` | - | `Blinkit PO Default` | Human name. |
| `document_type` | - | `purchase_order` | Document type handled. |
| `platform_code` | Mapping key | `blinkit` | Platform scope. |
| `scope_type` | - | `seller` | `global`, `platform`, `vendor`, `seller`. |
| `scope_id` | Mapping key | `seller_123` | Scope id. |
| `status` | - | `published` | Draft/published/archived. |
| `created_by` | - | `ops_admin` | Creator. |
| `created_at` | - | `2026-04-20T00:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T00:00:00Z` | Last update timestamp. |

### 4.11 workflow_versions

**Description:** Immutable published executable graph version.

**Purpose:** Publishes immutable workflow definitions used to execute documents with reproducible behavior.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `wf_blinkit_po_v12` | Workflow version id. |
| `workflow_template_id` | FK | `wft_blinkit_po` | Parent template. |
| `version` | - | `12` | Version number. |
| `status` | - | `published` | Draft/published/archived. |
| `definition_hash` | Hash | `sha256:wf-po-v12` | Hash of graph/config refs. |
| `published_at` | - | `2026-04-28T12:00:00Z` | Publish time. |
| `published_by` | - | `workflow_admin` | Publisher. |
| `created_at` | - | `2026-04-28T11:50:00Z` | Creation timestamp. |

### 4.12 workflow_nodes

**Description:** Design-time node definitions inside a workflow version.

**Purpose:** Defines each executable workflow step and the plugin/config scope used by that step.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `wfn_po_schedule_asn` | Node id. |
| `workflow_version_id` | FK | `wf_blinkit_po_v12` | Parent workflow version. |
| `node_key` | Mapping key | `schedule_asn_tracking` | Stable node key. |
| `node_type` | - | `action` | Action/approval/manual/terminal. |
| `plugin_id` | Mapping key | `edi.schedule_asn_tracking` | Plugin for action nodes. |
| `required` | - | `true` | Whether failure blocks terminal success. |
| `config_json` | Config/state | `{"delayHours":24}` | Node config. |
| `approval_policy_ref` | Object ref | `null` | Approval policy reference. |
| `retry_policy_ref` | Object ref | `default_short` | Retry policy reference. |
| `created_at` | - | `2026-04-28T11:50:00Z` | Creation timestamp. |

### 4.13 workflow_edges

**Description:** Design-time transition rules.

**Purpose:** Defines transitions between workflow nodes for success, failure, approval, and conditional branches.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `wfe_ack_to_asn` | Edge id. |
| `workflow_version_id` | FK | `wf_blinkit_po_v12` | Parent workflow version. |
| `from_node_key` | - | `blinkit_po_ack` | Source node. |
| `to_node_key` | - | `schedule_asn_tracking` | Target node. |
| `on_status` | - | `success` | Required source result. |
| `condition_json` | Config/state | `{}` | Optional edge condition. |
| `created_at` | - | `2026-04-28T11:50:00Z` | Creation timestamp. |

### 4.14 workflow_layouts

**Description:** UI-only workflow graph coordinates.

**Purpose:** Stores graph coordinates and UI metadata without changing workflow execution semantics.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `layout_po_v12` | Layout id. |
| `workflow_version_id` | FK | `wf_blinkit_po_v12` | Parent workflow version. |
| `layout_json` | Config/state | `{"nodes":{"validate_po":{"x":10,"y":20}}}` | Canvas positions and visual metadata. |
| `created_at` | - | `2026-04-28T11:50:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-28T12:00:00Z` | Last update timestamp. |

### 4.15 workflow_assignments

**Description:** Selects effective workflow for a scope.

**Purpose:** Chooses which published workflow version applies to a vendor, seller, platform, document type, and environment.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `wfa_seller_po` | Assignment id. |
| `scope_type` | - | `seller` | Resolution scope. |
| `scope_id` | Mapping key | `seller_123` | Scope id. |
| `platform_code` | Mapping key | `blinkit` | Platform filter. |
| `document_type` | - | `purchase_order` | Document type. |
| `workflow_version_id` | FK | `wf_blinkit_po_v12` | Selected workflow version. |
| `priority` | - | `10` | Resolution priority. |
| `effective_from` | - | `2026-04-28T12:00:00Z` | Start time. |
| `effective_until` | - | `null` | Optional end time. |
| `created_at` | - | `2026-04-28T12:00:00Z` | Creation timestamp. |

### 4.16 resolved_config_snapshots

**Description:** Frozen config used by one workflow run.

**Purpose:** Freezes workflow, rules, plugin, approval, and retry config selected for a specific document run.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `cfg_snap_po_001` | Snapshot id. |
| `document_id` | FK | `doc_po_001` | Document being processed. |
| `document_version_id` | FK | `doc_ver_po_001` | Exact document version. |
| `workflow_version_id` | FK | `wf_blinkit_po_v12` | Frozen workflow version. |
| `ruleset_version_id` | FK | `rules_po_v9` | Effective ruleset. |
| `resolved_from_json` | Config/state | `{"seller":"seller_123"}` | Config inheritance trace. |
| `action_configs_json` | Config/state | `{"blinkit.po_ack":{}}` | Frozen action configs. |
| `approval_policies_json` | Config/state | `{}` | Frozen approval policies. |
| `retry_policies_json` | Config/state | `{"default_short":{}}` | Frozen retry policies. |
| `plugin_versions_json` | Config/state | `{"blinkit.po_ack":"1.0.0"}` | Frozen plugin versions. |
| `created_at` | - | `2026-04-29T10:00:05Z` | Creation timestamp. |

### 4.17 workflow_runs

**Description:** Runtime execution of one workflow version for one document version.

**Purpose:** Tracks execution state for one document version through one workflow version.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `wf_run_po_001` | Runtime workflow id. |
| `document_id` | FK | `doc_po_001` | Document being processed. |
| `document_version_id` | FK | `doc_ver_po_001` | Exact version being processed. |
| `workflow_version_id` | FK | `wf_blinkit_po_v12` | Executed workflow definition. |
| `resolved_config_snapshot_id` | FK | `cfg_snap_po_001` | Frozen config. |
| `status` | - | `completed` | Created/running/waiting/completed/failed. |
| `started_at` | - | `2026-04-29T10:00:05Z` | Start timestamp. |
| `completed_at` | - | `2026-04-29T10:01:18Z` | Completion timestamp. |
| `created_at` | - | `2026-04-29T10:00:05Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:01:18Z` | Last update timestamp. |

### 4.18 workflow_node_runs

**Description:** Runtime execution state for one workflow node.

**Purpose:** Tracks execution state for each workflow node inside a workflow run.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `node_asn_schedule` | Node run id. |
| `workflow_run_id` | FK | `wf_run_po_001` | Parent workflow run. |
| `node_key` | Mapping key | `schedule_asn_tracking` | Design node key. |
| `node_type` | - | `action` | Runtime node type. |
| `plugin_id` | Mapping key | `edi.schedule_asn_tracking` | Plugin executed. |
| `status` | - | `success` | Runtime result. |
| `input_snapshot_json` | Config/state | `{"poDocumentId":"doc_po_001"}` | Frozen node input. |
| `output_json` | Config/state | `{"asnTrackingJobId":"asn_tracking_job_001"}` | Normalized node output. |
| `started_at` | - | `2026-04-29T10:01:17Z` | Start timestamp. |
| `completed_at` | - | `2026-04-29T10:01:18Z` | Completion timestamp. |
| `created_at` | - | `2026-04-29T10:01:17Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-29T10:01:18Z` | Last update timestamp. |

### 4.19 action_attempts

**Description:** One plugin execution attempt.

**Purpose:** Stores each external or plugin attempt, request/response refs, retry metadata, and outcome.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `act_asn_schedule_1` | Attempt id. |
| `workflow_node_run_id` | FK | `node_asn_schedule` | Parent node run. |
| `plugin_id` | Mapping key | `edi.schedule_asn_tracking` | Plugin id. |
| `attempt_no` | - | `1` | Attempt number for that node. |
| `status` | - | `success` | Attempt result. |
| `idempotency_key` | Idempotency key | `act:act_asn_schedule_1` | Safe retry key. |
| `request_ref` | Object ref | `null` | Object-store request payload if external. |
| `response_ref` | Object ref | `null` | Object-store response payload if external. |
| `error_code` | - | `null` | Normalized failure code. |
| `error_message` | - | `null` | Safe failure message. |
| `next_retry_at` | - | `null` | Retry time if retryable. |
| `started_at` | - | `2026-04-29T10:01:17Z` | Start timestamp. |
| `completed_at` | - | `2026-04-29T10:01:18Z` | Completion timestamp. |
| `created_at` | - | `2026-04-29T10:01:17Z` | Creation timestamp. |

### 4.20 approval_tasks

**Description:** Manual approval produced by approval workflow nodes.

**Purpose:** Represents manual approval work created by workflow nodes when automation must pause.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `approval_asn_001` | Approval task id. |
| `workflow_run_id` | FK | `wf_run_asn_001` | Parent workflow run. |
| `approval_workflow_node_run_id` | FK | `node_asn_approval` | Approval node run. |
| `target_workflow_node_run_id` | FK | `node_asn_sync` | Action gated by approval. |
| `target_plugin_id` | FK | `blinkit.asn_sync` | Target plugin if applicable. |
| `approval_phase` | - | `pre_action` | Approval timing. |
| `status` | - | `approved` | Pending/approved/rejected/expired. |
| `requested_role` | - | `seller_ops_manager` | Required approver role. |
| `requested_user_id` | FK | `null` | Specific user if assigned. |
| `approved_by` | - | `user_42` | Deciding user. |
| `decision_reason` | - | `ASN checked` | Human decision reason. |
| `decision_payload_json` | Config/state | `{"approved":true}` | Structured decision. |
| `created_at` | - | `2026-05-01T07:30:20Z` | Creation timestamp. |
| `decided_at` | - | `2026-05-01T07:30:30Z` | Decision timestamp. |
| `expires_at` | - | `2026-05-02T07:30:20Z` | Expiry timestamp. |

### 4.21 validation_results

**Description:** Validation findings emitted by validation action.

**Purpose:** Stores rule engine findings attached to node runs, documents, and document versions.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `val_asn_001` | Validation result id. |
| `workflow_run_id` | FK | `wf_run_asn_001` | Parent workflow run. |
| `workflow_node_run_id` | FK | `node_validate_asn` | Validation node run. |
| `action_attempt_id` | FK | `act_validate_asn_1` | Attempt that produced result. |
| `ruleset_version_id` | FK | `rules_asn_v3` | Ruleset used. |
| `status` | - | `success` | Success/warning/rejected/failed. |
| `findings_json` | Config/state | `[{"scope":"purchase_order.line","path":"lines[3].skuCode","lineId":"PO-1001:BLK-ITEM-7788","ruleKey":"sku_mapping_required","severity":"error","blocking":true}]` | Rule findings at document and line-item scope. |
| `created_at` | - | `2026-05-01T07:30:14Z` | Creation timestamp. |

`findings_json` must preserve both PO-level and PO line-item findings. PO-level findings use `scope = purchase_order`; line-item findings use `scope = purchase_order.line` plus `path`, `lineId`, and partner item identifiers such as platform item id, SKU code, or UPC when available.

### 4.22 rule_definitions

**Description:** Reusable rule catalog.

**Purpose:** Catalogs reusable validation or business rules independent of a specific published ruleset.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `rule_required_fields` | Rule definition id. |
| `rule_key` | Mapping key | `po_required_fields` | Stable rule key. |
| `rule_type` | - | `field_check` | Rule engine type. |
| `document_type` | - | `purchase_order` | Target document type. |
| `description` | - | `PO must contain mandatory fields` | Human description. |
| `input_schema_json` | Config/state | `{"required":["checks"]}` | Config schema. |
| `default_config_json` | Config/state | `{"checks":["poNumber","lines"]}` | Default config. |
| `created_at` | - | `2026-04-20T00:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-20T00:00:00Z` | Last update timestamp. |

### 4.23 ruleset_versions

**Description:** Published set of configured rules.

**Purpose:** Publishes immutable ordered rule bundles used by validation actions.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `rules_po_v9` | Ruleset version id. |
| `name` | - | `Blinkit PO Rules` | Human name. |
| `scope_type` | - | `seller` | Scope level. |
| `scope_id` | Mapping key | `seller_123` | Scope id. |
| `document_type` | - | `purchase_order` | Target document type. |
| `version` | - | `9` | Version number. |
| `status` | - | `published` | Draft/published/archived. |
| `published_at` | - | `2026-04-28T12:00:00Z` | Publish timestamp. |
| `published_by` | - | `rules_admin` | Publisher. |
| `created_at` | - | `2026-04-28T11:40:00Z` | Creation timestamp. |

### 4.24 ruleset_rules

**Description:** Rule config inside a ruleset.

**Purpose:** Maps rule definitions into a ruleset version with severity, order, and parameter overrides.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `rules_po_v9_required` | Ruleset rule id. |
| `ruleset_version_id` | FK | `rules_po_v9` | Parent ruleset. |
| `rule_key` | Mapping key | `po_required_fields` | Rule definition key. |
| `enabled` | - | `true` | Whether rule runs. |
| `severity` | - | `error` | Info/warning/error. |
| `blocking` | - | `true` | Whether finding blocks workflow. |
| `locked` | - | `true` | Lower scopes cannot weaken. |
| `seller_can_disable` | - | `false` | Seller override permission. |
| `seller_can_override_config` | - | `false` | Seller config override permission. |
| `allowed_override_fields_json` | Config/state | `[]` | Allowed override fields. |
| `config_json` | Config/state | `{"checks":["poNumber","lines"]}` | Rule config. |
| `created_at` | - | `2026-04-28T11:40:00Z` | Creation timestamp. |

### 4.25 ruleset_assignments

**Description:** Chooses effective ruleset by scope.

**Purpose:** Selects the applicable ruleset version for vendor, seller, platform, document type, environment, and node scope.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `rsa_seller_po` | Assignment id. |
| `scope_type` | - | `seller` | Scope type. |
| `scope_id` | Mapping key | `seller_123` | Scope id. |
| `platform_code` | Mapping key | `blinkit` | Platform filter. |
| `document_type` | - | `purchase_order` | Target document type. |
| `ruleset_version_id` | FK | `rules_po_v9` | Selected ruleset. |
| `priority` | - | `10` | Resolution priority. |
| `effective_from` | - | `2026-04-28T12:00:00Z` | Start timestamp. |
| `effective_until` | - | `null` | Optional end timestamp. |
| `created_at` | - | `2026-04-28T12:00:00Z` | Creation timestamp. |

### 4.26 action_plugin_configs

**Description:** Published plugin config.

**Purpose:** Publishes non-secret plugin configuration used by actions and source plugins.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `apc_blinkit_ack_v2` | Config id. |
| `scope_type` | - | `seller` | Scope level. |
| `scope_id` | Mapping key | `seller_123` | Scope id. |
| `platform_code` | Mapping key | `blinkit` | Platform filter. |
| `plugin_id` | Mapping key | `blinkit.po_ack` | Plugin configured. |
| `version` | - | `2` | Config version. |
| `status` | - | `published` | Draft/published/archived. |
| `config_json` | Config/state | `{"endpoint":"/po/ack"}` | Non-secret plugin config. |
| `published_at` | - | `2026-04-28T12:00:00Z` | Publish timestamp. |
| `published_by` | - | `workflow_admin` | Publisher. |
| `created_at` | - | `2026-04-28T11:55:00Z` | Creation timestamp. |

### 4.27 approval_policy_versions

**Description:** Approval rules for workflow nodes.

**Purpose:** Publishes approval routing and SLA policy used by manual workflow steps.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `apv_asn_pre_v1` | Approval policy version id. |
| `policy_key` | Mapping key | `asn_pre_send` | Stable policy key. |
| `scope_type` | - | `seller` | Scope level. |
| `scope_id` | Mapping key | `seller_123` | Scope id. |
| `version` | - | `1` | Version number. |
| `status` | - | `published` | Draft/published/archived. |
| `policy_json` | Config/state | `{"role":"seller_ops_manager"}` | Approval rules. |
| `published_at` | - | `2026-04-28T12:00:00Z` | Publish timestamp. |
| `published_by` | - | `workflow_admin` | Publisher. |
| `created_at` | - | `2026-04-28T11:55:00Z` | Creation timestamp. |

### 4.28 retry_policy_versions

**Description:** Retry behavior for actions/jobs.

**Purpose:** Publishes retry and backoff settings used by action workers and pollers.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `rp_default_short_v1` | Retry policy version id. |
| `policy_key` | Mapping key | `default_short` | Stable policy key. |
| `scope_type` | - | `global` | Scope level. |
| `scope_id` | Mapping key | `null` | Scope id. |
| `version` | - | `1` | Version number. |
| `status` | - | `published` | Draft/published/archived. |
| `policy_json` | Config/state | `{"maxAttempts":5,"backoff":"exponential"}` | Retry rules. |
| `published_at` | - | `2026-04-20T00:00:00Z` | Publish timestamp. |
| `published_by` | - | `platform_admin` | Publisher. |
| `created_at` | - | `2026-04-20T00:00:00Z` | Creation timestamp. |

### 4.29 outbox

**Description:** Transactional message publish table.

**Purpose:** Reliably emits domain, workflow, action, and queue messages after database commits.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `out_asn_due_001` | Outbox row id. |
| `aggregate_key` | Correlation key | `blinkit:seller_123:purchase_order:PO-1001` | Readable related lane. |
| `aggregate_key_hash` | Lock/routing key | `sha256:7b8f4e...` | Compact routing key. |
| `event_type` | - | `asn_tracking.due` | Event/message type. |
| `destination_queue` | Mapping key | `edi.asn.tracking.due` | Queue target. |
| `payload_json` | Config/state | `{"asnTrackingJobId":"asn_tracking_job_001"}` | Message body. |
| `status` | - | `dispatched` | Pending/dispatched/failed. |
| `available_at` | - | `2026-05-01T07:30:00Z` | Earliest dispatch time. |
| `dispatched_at` | - | `2026-05-01T07:30:01Z` | Dispatch timestamp. |
| `created_at` | - | `2026-05-01T07:30:00Z` | Creation timestamp. |

### 4.30 partner_messages

**Description:** External request/response evidence.

**Purpose:** Stores external API request/response evidence and partner reference ids for audit.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `msg_blinkit_asn` | Message row id. |
| `action_attempt_id` | FK | `act_asn_sync_1` | Related action attempt. |
| `platform_code` | Mapping key | `blinkit` | Provider/platform. |
| `direction` | - | `outbound` | Inbound or outbound. |
| `endpoint` | - | `/webhook/public/v1/asn` | API endpoint. |
| `request_ref` | Object ref | `s3://edi-actions/asn/request.json` | Object-store request body. |
| `response_ref` | Object ref | `s3://edi-actions/asn/response.json` | Object-store response body. |
| `status_code` | - | `200` | HTTP/status code. |
| `idempotency_key` | Idempotency key | `act:act_asn_sync_1` | External retry key if used. |
| `external_reference` | External key | `BLK-ASN-777` | Provider-side reference. |
| `created_at` | - | `2026-05-01T07:30:49Z` | Creation timestamp. |

### 4.31 asn_source_configs

**Description:** Published configuration for where ASN details come from and how polling behaves.

**Purpose:** Defines how ASN source data is obtained, when to poll, and which source plugin owns readiness checks.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `asn_src_erp_seller_123_v2` | ASN source config id. |
| `vendor_id` | FK | `vendor_acme` | Owning vendor. |
| `seller_id` | FK | `seller_123` | Owning seller. |
| `platform_code` | Mapping key | `blinkit` | Platform this config serves. |
| `source_plugin_id` | Mapping key | `erp.get_asn_details` | Source plugin used by tracking worker. |
| `version` | - | `2` | Config version. |
| `status` | - | `published` | Draft/published/archived. |
| `poll_policy_json` | Config/state | `{"initialDelayHours":24,"intervalHours":12,"maxDays":8}` | Poll cadence and expiry. |
| `source_config_json` | Config/state | `{"erpEndpointRef":"erp_asn_details","poLookupField":"poNumber"}` | Non-secret source config. |
| `required_fields_json` | Config/state | `["invoiceNumber","items[].batchNumber","items[].quantity"]` | Fields needed before ASN can be created. |
| `published_at` | - | `2026-04-28T12:00:00Z` | Publish timestamp. |
| `published_by` | - | `workflow_admin` | Publisher. |
| `created_at` | - | `2026-04-28T11:50:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-28T12:00:00Z` | Last update timestamp. |

### 4.32 asn_build_snapshots

**Description:** Frozen record of exactly which config/state rows were used to build a canonical ASN. This is the audit bridge between onboarding config and ASN document state.

**Purpose:** Freezes PO version, source response, config rows, item mappings, and output hash used to create an ASN.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `asn_build_001` | Build snapshot id. |
| `vendor_id` | FK | `vendor_acme` | Owning vendor. |
| `seller_id` | FK | `seller_123` | Owning seller. |
| `po_document_id` | FK | `doc_po_001` | Source PO document. |
| `po_document_version_id` | FK | `doc_ver_po_001` | Source PO version used. |
| `asn_document_id` | FK | `doc_asn_001` | Created ASN document. |
| `asn_document_version_id` | FK | `doc_ver_asn_001` | Created ASN version. |
| `asn_tracking_job_id` | FK | `asn_tracking_job_001` | Tracking job that triggered build. |
| `asn_tracking_job_attempt_id` | FK | `asn_poll_004` | Source poll attempt used. |
| `seller_location_id` | FK | `loc_wh_mum_01` | Ship-from/supplier location used. |
| `seller_tax_profile_id` | FK | `tax_seller_123_gst` | GST/tax profile used. |
| `asn_source_config_id` | FK | `asn_src_erp_seller_123_v2` | ASN source config used. |
| `resolved_config_snapshot_id` | FK | `cfg_snap_asn_001` | Frozen workflow/config snapshot. |
| `item_mapping_refs_json` | Object ref | `["map_sku_001"]` | Item mapping rows used. |
| `build_input_json` | Config/state | `{"poVersion":"doc_ver_po_001","sourceAttempt":"asn_poll_004"}` | Inputs used to construct ASN. |
| `build_output_hash` | Hash | `sha256:asn-canon-v1` | Hash of canonical ASN output. |
| `created_at` | - | `2026-05-01T07:30:13Z` | Creation timestamp. |

### 4.33 asn_tracking_jobs

**Description:** Durable ASN readiness tracker. Not a business document and not a long-running action.

**Purpose:** Tracks long-running ASN readiness without holding workflow action workers open for hours or days.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `asn_tracking_job_001` | Tracking job id. |
| `vendor_id` | FK | `vendor_acme` | Vendor owner. |
| `po_document_id` | FK | `doc_po_001` | Source PO document. |
| `po_document_version_id` | FK | `doc_ver_po_001` | Source PO version. |
| `seller_id` | FK | `seller_123` | Seller owner. |
| `source_plugin_id` | Mapping key | `erp.get_asn_details` | ASN source plugin. |
| `status` | - | `created_asn` | Waiting/polling/not_ready/data_incomplete/created_asn. |
| `next_poll_at` | - | `2026-05-01T07:30:00Z` | Next poll time. |
| `max_poll_until` | - | `2026-05-09T10:01:18Z` | SLA/deadline. |
| `attempt_count` | - | `4` | Number of source polls. |
| `created_asn_document_id` | FK | `doc_asn_001` | ASN document created from this job. |
| `created_asn_document_version_id` | FK | `doc_ver_asn_001` | ASN version created from this job. |
| `last_error_code` | - | `null` | Latest normalized error. |
| `last_error_message` | - | `null` | Latest safe error message. |
| `created_at` | - | `2026-04-29T10:01:18Z` | Creation timestamp. |
| `updated_at` | - | `2026-05-01T07:30:13Z` | Last update timestamp. |

### 4.34 asn_tracking_job_attempts

**Description:** Every ASN source poll attempt.

**Purpose:** Stores each ASN readiness poll attempt and the source response reference.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `asn_poll_004` | Poll attempt id. |
| `asn_tracking_job_id` | FK | `asn_tracking_job_001` | Parent tracking job. |
| `attempt_no` | - | `4` | Poll attempt number. |
| `source_plugin_id` | Mapping key | `erp.get_asn_details` | Source plugin called. |
| `status` | - | `ready` | Not_ready/data_incomplete/ready/failure. |
| `request_ref` | Object ref | `s3://edi-actions/erp/asn/attempt-4-request.json` | Source request payload. |
| `response_ref` | Object ref | `s3://edi-actions/erp/asn/attempt-4-response.json` | Source response payload. |
| `error_code` | - | `null` | Normalized failure code. |
| `error_message` | - | `null` | Safe failure message. |
| `started_at` | - | `2026-05-01T07:30:02Z` | Start timestamp. |
| `completed_at` | - | `2026-05-01T07:30:12Z` | Completion timestamp. |
| `created_at` | - | `2026-05-01T07:30:02Z` | Creation timestamp. |

### 4.35 domain_events

**Description:** Append-only business events for projections and audit.

**Purpose:** Records business events used for projections, audit, outbox dispatch, and support timelines.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `de_asn_created` | Domain event id. |
| `aggregate_key` | Correlation key | `blinkit:seller_123:advance_shipment_notice:INV-9001` | Readable lane. |
| `aggregate_key_hash` | Lock/routing key | `sha256:asn-31aa...` | Compact lane. |
| `event_type` | - | `document.created` | Domain event type. |
| `entity_type` | - | `document` | Entity type. |
| `entity_id` | FK | `doc_asn_001` | Entity id. |
| `trace_id` | FK | `trc_asn_1001` | Trace id. |
| `payload_json` | Config/state | `{"documentType":"advance_shipment_notice"}` | Event body. |
| `created_at` | - | `2026-05-01T07:30:13Z` | Creation timestamp. |

### 4.36 state_transitions

**Description:** Append-only state changes.

**Purpose:** Records old/new state changes for documents, workflows, actions, and ASN jobs.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `st_asn_job_ready` | Transition id. |
| `entity_type` | - | `asn_tracking_job` | Entity type. |
| `entity_id` | FK | `asn_tracking_job_001` | Entity id. |
| `from_state` | - | `polling` | Previous state. |
| `to_state` | - | `created_asn` | New state. |
| `reason` | - | `source_ready` | Transition reason. |
| `actor_type` | - | `system` | System/user/plugin/replay. |
| `actor_id` | FK | `asn_tracking_worker` | Actor id. |
| `trace_id` | FK | `trc_asn_1001` | Trace id. |
| `metadata_json` | Config/state | `{"attemptNo":4}` | Extra details. |
| `created_at` | - | `2026-05-01T07:30:13Z` | Creation timestamp. |

### 4.37 dead_letters

**Description:** Poison message and unrecoverable failure storage.

**Purpose:** Stores poison or exhausted messages with context needed for replay or manual repair.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `dlq_001` | Dead-letter id. |
| `source_queue` | - | `edi.actions.partner` | Queue where message failed. |
| `source_message_id` | FK | `msg-uuid` | Broker message id. |
| `aggregate_key` | Correlation key | `blinkit:seller_123:advance_shipment_notice:INV-9001` | Readable lane. |
| `aggregate_key_hash` | Lock/routing key | `sha256:asn-31aa...` | Compact lane. |
| `entity_type` | - | `action_attempt` | Failed entity type. |
| `entity_id` | FK | `act_asn_sync_1` | Failed entity id. |
| `error_code` | - | `EXTERNAL_5XX` | Normalized error. |
| `error_message` | - | `Blinkit returned 502 after retries` | Safe message. |
| `payload_json` | Config/state | `{"queue":"edi.actions.partner"}` | Original message/context. |
| `retry_count` | - | `5` | Attempts before DLQ. |
| `status` | - | `open` | Open/replayed/ignored/resolved. |
| `created_at` | - | `2026-05-01T07:35:00Z` | Creation timestamp. |
| `resolved_at` | - | `null` | Resolution timestamp. |

### 4.38 audit_log

**Description:** Security/operator audit trail.

**Purpose:** Stores actor, reason, and before/after evidence for config and operational changes.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `audit_payload_view` | Audit id. |
| `vendor_id` | FK | `vendor_acme` | Vendor context. |
| `actor_type` | - | `user` | User/system/plugin. |
| `actor_id` | FK | `user_42` | Actor id. |
| `action` | - | `raw_payload.view` | Audited action. |
| `entity_type` | - | `raw_event` | Entity type. |
| `entity_id` | FK | `raw_evt_001` | Entity id. |
| `reason` | - | `support investigation` | Required reason for sensitive ops. |
| `before_json` | Config/state | `null` | Previous state if mutation. |
| `after_json` | Config/state | `null` | New state if mutation. |
| `ip_address` | - | `10.0.0.10` | Actor IP. |
| `user_agent` | - | `Chrome` | Actor user agent. |
| `created_at` | - | `2026-04-29T10:10:00Z` | Creation timestamp. |

### 4.39 plugin_registry

**Description:** Available plugin catalog.

**Purpose:** Catalogs installed plugins and their capability contracts for workflow/action configuration.

| Column | Key role | Example | Explanation |
|---|---|---|---|
| `id` | PK | `plugin_blinkit_asn_1` | Registry row id. |
| `plugin_id` | Mapping key | `blinkit.asn_sync` | Stable plugin id. |
| `plugin_type` | - | `action` | Partner/action/validation/asn_source. |
| `version` | - | `1.0.0` | Plugin implementation version. |
| `status` | - | `active` | Active/deprecated/disabled. |
| `capabilities_json` | Config/state | `{"documentTypes":["advance_shipment_notice"]}` | Capability declaration. |
| `config_schema_json` | Config/state | `{"required":["endpoint","credentialRef"]}` | Config schema. |
| `created_at` | - | `2026-04-20T00:00:00Z` | Creation timestamp. |
| `updated_at` | - | `2026-04-20T00:00:00Z` | Last update timestamp. |

## 4A. Unique Constraints And Key Indexes

Use these as production constraints. `PK(id)` is assumed for every table unless the table uses an existing platform key such as `brands.brand_id`.

| Table | Unique constraints | Key indexes |
|---|---|---|
| `brands` | `PK(brand_id)`, `unique(brand_name)` if brand names must be globally unique. | `index(brand_name)` for search. |
| `vendors` | `unique(code)`, optionally `unique(name)` if business requires. | `index(status)`. |
| `sellers` | `unique(vendor_id, seller_code)`. | `index(vendor_id, status)`, `index(default_ship_from_location_id)`, `index(default_tax_profile_id)`. |
| `seller_locations` | `unique(seller_id, location_code)`. | `index(vendor_id, seller_id)`, `index(seller_id, location_type)`, partial `unique(seller_id) where is_default_ship_from=true`, partial `unique(seller_id) where is_default_bill_from=true`. |
| `seller_contacts` | No unique beyond `id`; optional `unique(seller_location_id, contact_type, email)`. | `index(vendor_id, seller_id)`, `index(seller_location_id)`, `index(contact_type)`. |
| `seller_tax_profiles` | `unique(seller_id, seller_location_id, gstin, effective_from)`. | `index(vendor_id, seller_id)`, `index(gstin)`, `index(effective_until)`. |
| `seller_item_mappings` | `unique(seller_id, platform_code, platform_item_id)`, `unique(seller_id, platform_code, seller_sku)` when seller SKU exists, optional `unique(seller_id, platform_code, upc)`. | `index(brand_id)`, `index(platform_sku_code)`, `index(status)`. |
| `platform_accounts` | `unique(platform_code, environment, external_account_id)`, `unique(platform_code, environment, external_tenant, external_supplier_id)`. | `index(vendor_id, seller_id)`, `index(external_supplier_gstin)`, GIN/index on `external_outlet_ids_json` if queried. |
| `credentials` | `unique(platform_account_id, provider, purpose, environment)` when `platform_account_id` is set. | `index(vendor_id)`, `index(secret_ref)`, `index(status)`. |
| `raw_events` | Only `PK(id)`. Do not add unique duplicate blockers; every webhook/replay gets a row. | `index(dedupe_key)`, `index(platform_code, seller_id, external_document_id, payload_hash)`, `index(aggregate_key_hash, received_at)`, `index(trace_id)`, `index(status, received_at)`. |
| `idempotency_keys` | `unique(scope, key)`. | `index(aggregate_key_hash)`, `index(status, expires_at)`, `index(first_seen_ref_type, first_seen_ref_id)`, `index(result_ref_type, result_ref_id)`. |
| `documents` | `unique(platform_code, seller_id, document_type, external_document_id)`. | `index(vendor_id, seller_id)`, `index(aggregate_key_hash)`, `index(current_state)`, `index(current_version_id)`. |
| `document_versions` | `unique(document_id, version)`, `unique(document_id, payload_hash)`. | `index(source_raw_event_id)`, `index(created_at)`. |
| `document_links` | `unique(source_document_id, target_document_id, link_type)`, optionally include source/target versions if multiple shipments per PO must be allowed. | `index(target_document_id, link_type)`, `index(source_document_id)`. |
| `workflow_templates` | `unique(scope_type, scope_id, platform_code, document_type, name)`. | `index(status)`, `index(vendor_id)`. |
| `workflow_versions` | `unique(workflow_template_id, version)`, `unique(workflow_template_id, definition_hash)`. | `index(status)`, `index(published_at)`. |
| `workflow_nodes` | `unique(workflow_version_id, node_key)`. | `index(plugin_id)`, `index(node_type)`. |
| `workflow_edges` | `unique(workflow_version_id, from_node_key, to_node_key, condition_key)`. | `index(workflow_version_id, from_node_key)`, `index(workflow_version_id, to_node_key)`. |
| `workflow_layouts` | `unique(workflow_version_id)`. | `index(updated_at)`. |
| `workflow_assignments` | `unique(platform_code, document_type, environment, scope_type, scope_id, effective_from)`. | `index(status)`, `index(effective_until)`. |
| `resolved_config_snapshots` | `unique(document_id, workflow_version_id, config_hash)`. | `index(document_version_id)`, `index(workflow_version_id)`, `index(created_at)`. |
| `workflow_runs` | `unique(document_version_id, workflow_version_id)`. | `index(document_id)`, `index(status)`, `index(aggregate_key_hash)`. |
| `workflow_node_runs` | `unique(workflow_run_id, node_key)`. | `index(workflow_run_id, status)`, `index(plugin_id)`. |
| `action_attempts` | `unique(workflow_node_run_id, attempt_no)`, `unique(plugin_id, idempotency_key)` when `idempotency_key` is not null. | `index(status, next_retry_at)`, `index(idempotency_key)`. |
| `approval_tasks` | `unique(approval_workflow_node_run_id)`. | `index(status)`, `index(requested_role)`, `index(target_workflow_node_run_id)`. |
| `validation_results` | `unique(workflow_node_run_id, ruleset_version_id)`. | `index(status)`, `index(document_id)` if stored/derived. |
| `rule_definitions` | `unique(rule_key)`. | `index(status)`, `index(rule_type)`. |
| `ruleset_versions` | `unique(ruleset_key, version)`, `unique(ruleset_key, definition_hash)`. | `index(status)`, `index(scope_type, scope_id)`. |
| `ruleset_rules` | `unique(ruleset_version_id, rule_definition_id)`, `unique(ruleset_version_id, rule_order)`. | `index(severity)`. |
| `ruleset_assignments` | `unique(platform_code, document_type, environment, scope_type, scope_id, node_key, effective_from)`. | `index(status)`, `index(effective_until)`. |
| `action_plugin_configs` | `unique(plugin_id, scope_type, scope_id, environment, version)`, `unique(plugin_id, scope_type, scope_id, environment, config_hash)`. | `index(status)`. |
| `approval_policy_versions` | `unique(policy_key, version)`, `unique(policy_key, policy_hash)`. | `index(status)`. |
| `retry_policy_versions` | `unique(policy_key, version)`, `unique(policy_key, policy_hash)`. | `index(status)`. |
| `outbox` | `unique(source_type, source_id, event_type)`; if source columns are not stored, use a stable `outbox_key` with `unique(outbox_key)`. | `index(status, available_at)`, `index(aggregate_key_hash)`, `index(destination_queue)`. |
| `partner_messages` | `unique(platform_code, endpoint, idempotency_key)` when `idempotency_key` is not null, `unique(platform_code, external_reference)` when partner returns stable reference. | `index(action_attempt_id)`, `index(created_at)`, `index(status_code)`. |
| `asn_source_configs` | `unique(vendor_id, seller_id, platform_code, source_plugin_id, version)`. | `index(status)`, `index(effective_until)`. |
| `asn_build_snapshots` | `unique(asn_document_version_id)`, `unique(po_document_version_id, asn_tracking_job_attempt_id, build_output_hash)`. | `index(po_document_version_id)`, `index(asn_tracking_job_id)`. |
| `asn_tracking_jobs` | `unique(po_document_id, po_document_version_id, source_plugin_id)`. | `index(status, next_poll_at)`, `index(seller_id)`, `index(created_asn_document_id)`. |
| `asn_tracking_job_attempts` | `unique(asn_tracking_job_id, attempt_no)`. | `index(status)`, `index(started_at)`. |
| `domain_events` | `unique(event_type, entity_type, entity_id, created_at)` only if producer can guarantee stable created time; otherwise no unique beyond `id`. | `index(aggregate_key_hash)`, `index(entity_type, entity_id)`, `index(created_at)`. |
| `state_transitions` | No unique beyond `id`; multiple identical transitions may be valid during replay unless replay id is modeled. | `index(entity_type, entity_id, created_at)`, `index(actor_id)`. |
| `dead_letters` | `unique(source_queue, source_message_id)` when broker message id is stable. | `index(status, created_at)`, `index(aggregate_key_hash)`, `index(entity_type, entity_id)`. |
| `audit_log` | No unique beyond `id`. | `index(vendor_id, created_at)`, `index(entity_type, entity_id)`, `index(actor_id)`. |
| `plugin_registry` | `unique(plugin_id, version)`. | `index(plugin_type)`, `index(status)`. |

## 5. Queue Catalog

| Queue | Producer | Consumer | Message key | Purpose |
|---|---|---|---|---|
| `edi.ingestion` | API/raw event writer | Document worker | `raw_event_id`, `aggregate_key_hash` | Parse raw event and create/update canonical document/version. |
| `edi.actions.validation` | Workflow engine/outbox | Validation worker | `action_attempt_id` | Run rulesets. |
| `edi.actions.erp` | Workflow engine/outbox | ERP worker | `action_attempt_id` | ERP PO punch or ERP-specific action. |
| `edi.actions.sheet` | Workflow engine/outbox | Sheet worker | `action_attempt_id` | Sheet sync. |
| `edi.actions.partner` | Workflow engine/outbox | Partner API worker | `action_attempt_id` | Blinkit PO ack, ASN sync, amendment. |
| `edi.actions.notification` | Workflow engine/outbox | Notification worker | `action_attempt_id` | Slack/email/webhook notifications. |
| `edi.asn.tracking.due` | ASN scheduler/outbox | ASN tracking worker | `asn_tracking_job_id`, `aggregate_key_hash` | Poll source plugin and create ASN document when ready. |
| `edi.retry` | Retry scheduler | Retry dispatcher | original entity id | Requeue retryable work after backoff. |
| `edi.dlq` | Any worker | Ops replay worker | source message id | Poison messages and manual replay. |

## 6. Message Contracts

### 6.1 Ingestion Message

| Field | Example | Explanation |
|---|---|---|
| `messageId` | `msg_ing_001` | Broker/application message id. |
| `traceId` | `trc_po_1001` | Trace id. |
| `vendorId` | `vendor_acme` | Vendor context. |
| `aggregateKey` | `blinkit:seller_123:purchase_order:PO-1001` | Readable lane. |
| `aggregateKeyHash` | `sha256:7b8f4e...` | Compact routing/lock key. |
| `entityType` | `raw_event` | Entity type. |
| `entityId` | `raw_evt_001` | Raw event id. |
| `attempt` | `1` | Delivery attempt. |
| `availableAt` | `2026-04-29T10:00:02Z` | Earliest process time. |
| `createdAt` | `2026-04-29T10:00:02Z` | Message creation time. |

### 6.2 Action Message

| Field | Example | Explanation |
|---|---|---|
| `messageId` | `msg_action_ack_001` | Message id. |
| `traceId` | `trc_po_1001` | Trace id. |
| `vendorId` | `vendor_acme` | Vendor context. |
| `aggregateKey` | `blinkit:seller_123:purchase_order:PO-1001` | Readable lane. |
| `aggregateKeyHash` | `sha256:7b8f4e...` | Compact key. |
| `entityType` | `action_attempt` | Entity type. |
| `entityId` | `act_ack_1` | Action attempt id. |
| `workflowRunId` | `wf_run_po_001` | Workflow run id. |
| `workflowNodeRunId` | `node_ack` | Node run id. |
| `pluginId` | `blinkit.po_ack` | Plugin to execute. |
| `attempt` | `1` | Delivery attempt. |

### 6.3 ASN Tracking Message

| Field | Example | Explanation |
|---|---|---|
| `messageId` | `msg_asn_due_004` | Message id. |
| `traceId` | `trc_asn_1001_poll_4` | Poll trace id. |
| `vendorId` | `vendor_acme` | Vendor context. |
| `aggregateKey` | `blinkit:seller_123:purchase_order:PO-1001` | Source PO lane. |
| `aggregateKeyHash` | `sha256:7b8f4e...` | Compact key. |
| `entityType` | `asn_tracking_job` | Entity type. |
| `entityId` | `asn_tracking_job_001` | Tracking job id. |
| `poDocumentId` | `doc_po_001` | Source PO document. |
| `sourcePluginId` | `erp.get_asn_details` | ASN source plugin. |
| `attempt` | `4` | Poll attempt number. |

## 7. One Completed Event Sample Rows

This sample follows one Blinkit PO that completes PO ack, waits for ASN readiness, creates ASN, and sends ASN.

### 7.1 Onboarding Config Used By The Flow

These rows exist before any PO arrives.

| Table | Row id | Important values |
|---|---|---|
| `brands` | `brand_101` | `brand_id=brand_101`, `brand_name=Acme Staples` |
| `vendors` | `vendor_acme` | `code=acme`, `name=Acme Foods`, `status=active` |
| `sellers` | `seller_123` | `vendor_id=vendor_acme`, `seller_code=seller_123`, `default_ship_from_location_id=loc_wh_mum_01`, `default_tax_profile_id=tax_seller_123_gst` |
| `seller_locations` | `loc_wh_mum_01` | `location_type=warehouse`, `city=Mumbai`, `state_code=MH`, `postal_code=421302`, `gstin=27ABCDE1234F1Z5`, `is_default_ship_from=true` |
| `seller_contacts` | `contact_wh_mum_ops` | `seller_location_id=loc_wh_mum_01`, `contact_type=warehouse_ops`, `name=Ravi Kumar`, `phone=+919999999999` |
| `seller_tax_profiles` | `tax_seller_123_gst` | `seller_location_id=loc_wh_mum_01`, `legal_name=Acme Foods Pvt Ltd`, `gstin=27ABCDE1234F1Z5`, `effective_from=2026-04-01` |
| `seller_item_mappings` | `map_sku_001` | `brand_id=brand_101`, `seller_sku=ACME-RICE-1KG`, `platform_item_id=BLK-ITEM-7788`, `upc=8901234567890`, `hsn_code=10063090`, `case_config_json={"unitsPerCase":12}` |
| `platform_accounts` | `pa_blinkit_123` | `vendor_id=vendor_acme`, `seller_id=seller_123`, `platform_code=blinkit`, `external_tenant=HYPERPURE`, `external_supplier_id=67890`, `external_supplier_gstin=27ABCDE1234F1Z5`, `external_outlet_ids_json=[12543]` |
| `credentials` | `cred_blinkit_api` | `vendor_id=vendor_acme`, `provider=blinkit`, `purpose=outbound_api`, `secret_ref=vault://edi/acme/blinkit/api-key` |
| `asn_source_configs` | `asn_src_erp_seller_123_v2` | `source_plugin_id=erp.get_asn_details`, `poll_policy_json={"initialDelayHours":24,"intervalHours":12,"maxDays":8}`, `status=published` |

### 7.2 Inbound PO and Canonical PO

| Table | Row id | Important values |
|---|---|---|
| `raw_events` | `raw_evt_001` | `event_type=purchase_order.created`, `external_document_id=PO-1001`, `dedupe_key=blinkit:purchase_order:PO-1001:sha256:9b21...`, `duplicate_of_raw_event_id=null`, `aggregate_key=blinkit:seller_123:purchase_order:PO-1001`, `raw_payload_ref=s3://edi-raw/blinkit/PO-1001.json`, `status=processed` |
| `documents` | `doc_po_001` | `document_type=purchase_order`, `external_document_id=PO-1001`, `current_version_id=doc_ver_po_001`, `current_state=completed` |
| `document_versions` | `doc_ver_po_001` | `document_id=doc_po_001`, `version=1`, `canonical_json={"poNumber":"PO-1001","lines":[...]}` |

### 7.3 PO Workflow Completion

| Table | Row id | Important values |
|---|---|---|
| `resolved_config_snapshots` | `cfg_snap_po_001` | `document_id=doc_po_001`, `workflow_version_id=wf_blinkit_po_v12`, `ruleset_version_id=rules_po_v9` |
| `workflow_runs` | `wf_run_po_001` | `document_id=doc_po_001`, `document_version_id=doc_ver_po_001`, `status=completed` |
| `workflow_node_runs` | `node_validate_po` | `node_key=validate_po`, `plugin_id=validation.ruleset_engine`, `status=success` |
| `workflow_node_runs` | `node_erp` | `node_key=erp_punch`, `plugin_id=erp.punch_po`, `status=success` |
| `workflow_node_runs` | `node_ack` | `node_key=blinkit_po_ack`, `plugin_id=blinkit.po_ack`, `status=success` |
| `workflow_node_runs` | `node_asn_schedule` | `node_key=schedule_asn_tracking`, `plugin_id=edi.schedule_asn_tracking`, `status=success` |
| `idempotency_keys` | `idem_ack_doc_po_001_v1` | `scope=external_action`, `key=blinkit.po_ack:doc_po_001:doc_ver_po_001`, `status=completed`, `result_ref_id=msg_blinkit_ack` |
| `action_attempts` | `act_ack_1` | `plugin_id=blinkit.po_ack`, `request_ref=s3://edi-actions/blinkit/ack/request.json`, `response_ref=s3://edi-actions/blinkit/ack/response.json`, `status=success` |
| `partner_messages` | `msg_blinkit_ack` | `endpoint=/po/acknowledgement`, `status_code=200`, `external_reference=BLK-ACK-556` |

### 7.4 ASN Tracking and ASN Creation

| Table | Row id | Important values |
|---|---|---|
| `asn_tracking_jobs` | `asn_tracking_job_001` | `po_document_id=doc_po_001`, `po_document_version_id=doc_ver_po_001`, `source_plugin_id=erp.get_asn_details`, `attempt_count=4`, `status=created_asn` |
| `outbox` | `out_asn_due_004` | `event_type=asn_tracking.due`, `destination_queue=edi.asn.tracking.due`, `payload_json={"asnTrackingJobId":"asn_tracking_job_001"}`, `status=dispatched` |
| `asn_tracking_job_attempts` | `asn_poll_004` | `attempt_no=4`, `status=ready`, `response_ref=s3://edi-actions/erp/asn/attempt-4-response.json` |
| `documents` | `doc_asn_001` | `document_type=advance_shipment_notice`, `external_document_id=INV-9001`, `current_version_id=doc_ver_asn_001`, `current_state=completed` |
| `document_versions` | `doc_ver_asn_001` | `document_id=doc_asn_001`, `version=1`, `canonical_json={"invoiceNumber":"INV-9001","poNumber":"PO-1001","supplierDetails":{"gstin":"27ABCDE1234F1Z5"},"shipFrom":{"locationCode":"MUM-WH-01"},"items":[...]}` |
| `document_links` | `link_asn_po_001` | `source_document_id=doc_asn_001`, `target_document_id=doc_po_001`, `link_type=generated_from` |
| `asn_build_snapshots` | `asn_build_001` | `po_document_version_id=doc_ver_po_001`, `asn_document_version_id=doc_ver_asn_001`, `seller_location_id=loc_wh_mum_01`, `seller_tax_profile_id=tax_seller_123_gst`, `asn_source_config_id=asn_src_erp_seller_123_v2`, `item_mapping_refs_json=["map_sku_001"]`, `source_refs_json={"brandIds":["brand_101"]}` |

### 7.5 ASN Workflow Completion

| Table | Row id | Important values |
|---|---|---|
| `resolved_config_snapshots` | `cfg_snap_asn_001` | `document_id=doc_asn_001`, `workflow_version_id=wf_blinkit_asn_v4`, `ruleset_version_id=rules_asn_v3` |
| `workflow_runs` | `wf_run_asn_001` | `document_id=doc_asn_001`, `document_version_id=doc_ver_asn_001`, `status=completed` |
| `workflow_node_runs` | `node_validate_asn` | `node_key=validate_asn`, `plugin_id=validation.ruleset_engine`, `status=success` |
| `validation_results` | `val_asn_001` | `workflow_node_run_id=node_validate_asn`, `status=success`, `findings_json=[]` |
| `workflow_node_runs` | `node_asn_sync` | `node_key=blinkit_asn_sync`, `plugin_id=blinkit.asn_sync`, `status=success` |
| `action_attempts` | `act_asn_sync_1` | `plugin_id=blinkit.asn_sync`, `request_ref=s3://edi-actions/blinkit/asn/request.json`, `response_ref=s3://edi-actions/blinkit/asn/response.json`, `status=success` |
| `partner_messages` | `msg_blinkit_asn` | `endpoint=/webhook/public/v1/asn`, `status_code=200`, `external_reference=BLK-ASN-777` |

### 7.6 Audit and Observability Rows

| Table | Row id | Important values |
|---|---|---|
| `domain_events` | `de_po_completed` | `event_type=workflow.completed`, `entity_id=wf_run_po_001` |
| `domain_events` | `de_asn_created` | `event_type=document.created`, `entity_id=doc_asn_001` |
| `state_transitions` | `st_po_completed` | `entity_type=document`, `entity_id=doc_po_001`, `from_state=in_workflow`, `to_state=completed` |
| `state_transitions` | `st_asn_job_created` | `entity_type=asn_tracking_job`, `entity_id=asn_tracking_job_001`, `to_state=created_asn` |
| `audit_log` | `audit_workflow_publish` | `action=workflow.publish`, `entity_id=wf_blinkit_po_v12` |

No `dead_letters` row is created in this happy path. If `blinkit.asn_sync` exhausts retries, create `dead_letters` with `entity_type=action_attempt`, `entity_id=act_asn_sync_1`.

## 8. Link Graph Source

```text
brands
-> seller_item_mappings via brand_id

Blinkit tenant + supplier_details.id + supplier GSTIN/outlet
-> platform_accounts
-> internal vendor_id + seller_id

vendors
-> sellers
-> seller_locations / seller_tax_profiles / seller_item_mappings / platform_accounts / credentials / asn_source_configs

raw_events
-> documents(purchase_order)
-> document_versions(PO)
-> workflow_runs(PO)
-> workflow_node_runs(PO)
-> action_attempts(PO ack / schedule ASN)
-> partner_messages(PO ack)
-> asn_tracking_jobs
-> asn_tracking_job_attempts
-> documents(advance_shipment_notice)
-> document_versions(ASN)
   uses seller_locations + seller_tax_profiles for supplier/ship-from details
   uses seller_item_mappings + brands for item/brand identity
-> asn_build_snapshots
   freezes seller location, tax profile, item mappings, brand ids, source config, PO version, source response
-> document_links(ASN generated_from PO)
-> workflow_runs(ASN)
-> workflow_node_runs(ASN)
-> action_attempts(ASN sync)
-> partner_messages(ASN sync)
```

## 9. Production Guardrails

- Keep `aggregate_key` readable and `aggregate_key_hash` compact everywhere a row participates in ordered async work.
- Use `aggregate_key_hash` for advisory locks and queue partition/routing.
- Use `aggregate_key` for logs, audit, support, and UI search.
- Keep `raw_events` append-only. Do not put a unique duplicate blocker on raw webhook storage.
- Use unique constraints on owner tables for data identity: `documents`, `document_versions`, `workflow_runs`, `workflow_node_runs`, `outbox`, `partner_messages`, `asn_tracking_jobs`, and `asn_tracking_job_attempts`.
- Use `idempotency_keys` only for execution claims and external side-effect reservation.
- Partition `raw_events`, `partner_messages`, `state_transitions`, `domain_events`, `audit_log`, and `dead_letters` by month when volume grows.
- Store raw bodies and large request/response bodies in immutable object storage.
- Restrict `raw_payload_ref`, `request_ref`, and `response_ref` access through audited signed URLs.
- Only published immutable workflow/ruleset/config versions can execute.
- Never mutate old `document_versions`.
- Never keep an action attempt open for multi-day ASN wait; use `asn_tracking_jobs`.
