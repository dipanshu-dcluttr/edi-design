# EDI Workflow Configuration Design

## Core Correction

Validation is not a separate processing layer before workflow.

Validation is an action node inside the workflow.

The correct runtime shape is:

```text
webhook
-> raw event stored
-> canonical document created or versioned
-> workflow selected
-> workflow run starts
   -> validation action node runs
   -> approval gates run where configured
   -> destination/action plugins run
   -> ack, ASN, amendment, notification actions run where configured
```

The workflow engine is the orchestrator. Everything meaningful after canonical document creation is modeled as a workflow node and tracked as workflow node runs, action attempts, approval tasks, and audit transitions.

## Design-Time Vs Runtime

### Design Time

Admins and seller users configure:

- workflow templates
- workflow nodes
- allowed edges
- validation rulesets used by validation action nodes
- action plugin configs
- approval policies
- retry policies
- seller overrides
- drag/drop UI layout

Design-time config is editable as draft data.

Published config is immutable.

### Runtime

Runtime does:

- receive webhook
- store raw event
- create or version canonical document
- resolve effective workflow and configs
- freeze the resolved config snapshot
- execute workflow nodes
- store node/action/approval states
- audit every transition

Runtime never executes against mutable draft config.

## System Layers

The system has these layers:

1. Raw event layer
2. Canonical document layer
3. Workflow definition layer
4. Workflow runtime layer
5. Action plugin layer
6. Approval layer
7. Audit/trace layer

Validation belongs to the action plugin layer.

Ruleset inheritance still exists, but the effective ruleset is config consumed by the validation action plugin. It is not a separate lifecycle outside workflow.

## Workflow Definition Model

Workflows are versioned DAGs.

```text
Node = executable step
Edge = dependency/routing rule
```

Example PO workflow:

```text
validate_po
-> destination_sync
-> blinkit_po_ack
-> start_asn_tracking
```

For seller A, `destination_sync` may be `erp.punch_po`.

For seller B, it may be `sheet.sync_po`.

For seller C, it may be disabled or replaced by another plugin.

Same engine, different published workflow/config versions.

## Node Types

Recommended node types:

```text
action
condition
manual_task
wait
notification
terminal
subworkflow
```

Validation is represented as:

```json
{
  "nodeKey": "validate_po",
  "nodeType": "action",
  "pluginId": "validation.ruleset_engine",
  "required": true,
  "config": {
    "rulesetRef": "effective",
    "documentType": "purchase_order",
    "failOnSeverity": "error"
  },
  "approvalPolicyRef": "validation_default",
  "retryPolicyRef": "no_retry"
}
```

ERP punch is represented as:

```json
{
  "nodeKey": "erp_punch",
  "nodeType": "action",
  "pluginId": "erp.punch_po",
  "required": true,
  "approvalPolicyRef": "effective",
  "retryPolicyRef": "standard_api_retry"
}
```

Sheet sync is represented as:

```json
{
  "nodeKey": "sheet_sync",
  "nodeType": "action",
  "pluginId": "sheet.sync_po",
  "required": true,
  "approvalPolicyRef": "effective",
  "retryPolicyRef": "standard_api_retry"
}
```

## Workflow Storage

Use executable graph tables, not only UI diagram data.

```text
workflow_templates
workflow_versions
workflow_nodes
workflow_edges
workflow_layouts
workflow_assignments
```

### workflow_templates

Logical workflow family.

```text
id
name
document_type
platform
scope
status
created_at
```

Example:

```text
name = Blinkit Purchase Order Default
document_type = purchase_order
platform = blinkit
```

### workflow_versions

Published versions are immutable.

```text
id
template_id
version_no
status = draft / published / archived
created_by
published_at
definition_hash
created_at
```

Rule: never mutate a published workflow version. A UI edit creates a new draft version, validates it, and publishes a new version.

### workflow_nodes

```text
id
workflow_version_id
node_key
node_type
plugin_id
config_json
approval_policy_ref
retry_policy_ref
required
timeout_seconds
```

### workflow_edges

```text
id
workflow_version_id
from_node_key
to_node_key
on_status
condition_expr
```

Example:

```yaml
edges:
  - from: validate_po
    to: erp_punch
    on_status: success

  - from: validate_po
    to: manual_review
    on_status: rejected

  - from: erp_punch
    to: blinkit_po_ack
    on_status: success

  - from: erp_punch
    to: manual_review
    on_status: permanent_failure
```

Retry should usually not be modeled as a graph edge. Retry belongs to the node retry policy.

### workflow_layouts

UI-only layout data.

```text
workflow_version_id
node_key
x
y
width
height
```

Backend execution uses nodes and edges. UI layout can change without changing executable behavior.

### workflow_assignments

Assign workflow versions by scope.

```text
scope_type = global / platform / vendor / seller
scope_id
platform
document_type
workflow_version_id
priority
effective_from
```

Runtime resolution:

```text
seller workflow
else vendor workflow
else platform workflow
else global workflow
```

## Edge Policy System

The UI can support drag/drop workflow editing, but not every edge should be allowed.

Backend must validate graph shape before publish.

Examples:

```text
validation action -> destination action        allowed
destination action -> po ack action            allowed
po ack action -> start ASN tracking            allowed
manual review -> destination action            allowed
asn sync -> po ack                             not allowed
po ack -> validation                           usually not allowed
amendment action -> mutate original PO         not allowed
```

Node type constraints:

```yaml
node_types:
  action:
    allowed_next:
      - action
      - condition
      - manual_task
      - notification
      - terminal

  manual_task:
    allowed_next:
      - action
      - terminal

  condition:
    allowed_next:
      - action
      - manual_task
      - notification
      - terminal

  terminal:
    allowed_next: []
```

Plugin constraints:

```yaml
plugin: blinkit.po_ack
constraints:
  allowed_after:
    - validation.ruleset_engine
    - erp.punch_po
    - sheet.sync_po
  not_allowed_before:
    - validation.ruleset_engine
```

If a user draws `blinkit.po_ack -> validate_po`, publish fails with a graph validation error.

## Ruleset Inheritance

Rulesets are inherited config used by the validation action plugin.

Resolution order:

```text
global rules
-> platform rules
-> vendor/client rules
-> seller rules
```

Example:

```text
global:
  po_number_required
  quantity_positive
  item_code_required

blinkit:
  facility_id_required
  delivery_slot_required

vendor:
  allowed_warehouse_check
  vendor_tax_rule

seller:
  sku_mapping_required
  min_order_quantity
  allow_mrp_warning_only
```

Effective ruleset:

```text
effective_ruleset =
  global base rules
  + platform additions/overrides
  + vendor additions/overrides
  + seller additions/overrides
  - disabled rules where override is allowed
```

Rules support:

```text
enabled
severity = error / warning / info
blocking = true / false
locked = true / false
seller_can_disable = true / false
version
effective_from
config_json
```

Some global rules should be locked:

```yaml
rule: po_number_required
locked: true
seller_can_disable: false
```

## Ruleset Storage

Recommended tables:

```text
rule_definitions
ruleset_versions
ruleset_rules
ruleset_assignments
validation_results
```

### rule_definitions

Reusable rule catalog.

```text
id
rule_key
rule_type
description
input_schema
created_at
```

Example:

```json
{
  "ruleKey": "sku_exists",
  "ruleType": "reference_check",
  "description": "Every PO SKU must exist in seller product master",
  "input": "document.items[*].sku",
  "source": "seller_product_master"
}
```

### ruleset_versions

Immutable ruleset version.

```text
id
name
scope_type
scope_id
document_type
version_no
status
created_by
published_at
```

### ruleset_rules

```text
ruleset_version_id
rule_key
enabled
severity
blocking
config_json
locked
override_policy_json
```

### ruleset_assignments

```text
scope_type = global / platform / vendor / seller
scope_id
document_type
ruleset_version_id
priority
effective_from
```

### validation_results

Produced by validation action attempts.

```text
id
workflow_run_id
workflow_node_run_id
action_attempt_id
ruleset_version_id
status
findings_json
created_at
```

This answers:

- which validation action ran
- which ruleset version ran
- which seller overrides applied
- which findings were produced
- which workflow edge was followed after validation

## Action Approval

Every action node has an approval gate.

The approval gate is workflow engine behavior, not plugin code.

Execution lifecycle:

```text
node becomes ready
-> resolve approval policy
-> if approval required:
      create approval task
      node waits
-> if approval approved:
      execute plugin
-> if approval rejected:
      node rejected
      workflow follows rejection edge
-> if approval disabled:
      execute plugin immediately
```

Approval can apply to any action plugin, including validation, but validation defaults to approval disabled.

## Approval Policy Inheritance

Approval config is inherited:

```text
global
-> platform
-> vendor/client
-> seller
```

Example:

```yaml
actions:
  validation.ruleset_engine:
    approval:
      required: false
      seller_can_override: false

  erp.punch_po:
    approval:
      required: true
      seller_can_override: true

  sheet.sync_po:
    approval:
      required: false
      seller_can_override: true

  blinkit.po_ack:
    approval:
      required: false
      seller_can_override: false

  blinkit.asn_sync:
    approval:
      required: true
      seller_can_override: true
```

Seller override:

```yaml
actions:
  erp.punch_po:
    approval:
      required: false
```

Runtime freezes the resolved approval policy in the workflow run config snapshot.

## Workflow Runtime Storage

Runtime tables:

```text
workflow_runs
workflow_node_runs
action_attempts
approval_tasks
state_transitions
```

### workflow_runs

```text
id
document_id
document_version_id
workflow_version_id
resolved_config_snapshot_id
status
started_at
completed_at
```

Status:

```text
pending
running
waiting
completed
failed
cancelled
blocked
```

### workflow_node_runs

```text
id
workflow_run_id
node_key
node_type
plugin_id
status
started_at
completed_at
input_snapshot_json
output_json
```

Status:

```text
pending
ready
waiting_for_approval
running
success
rejected
retry_scheduled
failed
skipped
cancelled
```

### action_attempts

```text
id
workflow_node_run_id
plugin_id
attempt_no
status
request_ref
response_ref
error_code
error_message
next_retry_at
started_at
completed_at
```

### approval_tasks

```text
id
workflow_run_id
workflow_node_run_id
action_plugin_id
status
requested_role
requested_user_id
approved_by
decision_reason
created_at
decided_at
```

## Runtime Example

```text
Blinkit PO webhook
-> raw_event stored
-> idempotency checked
-> canonical PO document created
-> workflow resolved and frozen
-> workflow_run created
```

Workflow graph:

```text
validate_po
-> erp_punch
-> blinkit_po_ack
-> start_asn_tracking
```

Execution:

```text
workflow_node_run(validate_po) = ready
approval required? false
action_attempt(validation.ruleset_engine) = running
validation_result = success
workflow_node_run(validate_po) = success

workflow_node_run(erp_punch) = ready
approval required? true
approval_task = pending
workflow_node_run(erp_punch) = waiting_for_approval

user approves
approval_task = approved
action_attempt(erp.punch_po) = running
action_attempt(erp.punch_po) = success
workflow_node_run(erp_punch) = success

workflow_node_run(blinkit_po_ack) = ready
approval required? false
action_attempt(blinkit.po_ack) = running
action_attempt(blinkit.po_ack) = success
workflow_node_run(blinkit_po_ack) = success

workflow_run = completed
document.state = completed
```

## Same PO Changed Payload

Same PO is serialized by:

```text
platform + seller + document_type + external_document_id
```

### Exact duplicate

```text
same aggregate key + same payload hash
```

Behavior:

```text
raw_event = duplicate
no workflow node created
no action plugin triggered
```

### Same PO changed before required side effect

If no required side-effect action has started:

```text
create new document version
set current version to new version
start or restart workflow from configured safe point
run validation action against new version
```

### Same PO changed after required side effect

If ERP/sheet/ack/other required side effect has started or completed:

```text
create change event or new document version for review
block automatic mutation
route to manual review or amendment flow
```

Never silently mutate an already externalized PO.

## Effective Config Snapshot

At workflow start, freeze resolved config.

```json
{
  "workflowVersionId": "blinkit_po_workflow_v4",
  "rulesetVersionId": "seller_123_po_rules_v7",
  "actionConfigs": {
    "validation.ruleset_engine": {
      "ruleset": "seller_123_po_rules_v7"
    },
    "erp.punch_po": {
      "approvalRequired": false,
      "retryPolicy": "standard_api_retry"
    },
    "blinkit.po_ack": {
      "approvalRequired": false,
      "retryPolicy": "standard_partner_retry"
    }
  },
  "resolvedFrom": {
    "workflow": "seller",
    "ruleset": "seller",
    "erp.punch_po.approval": "seller",
    "blinkit.po_ack.approval": "global"
  }
}
```

This allows audit to answer exactly which workflow, rules, approvals, and plugin configs were used for any document.

