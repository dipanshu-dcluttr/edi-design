const fs = require("fs");
const crypto = require("crypto");

const sourcePath = "docs/edi-integration-technical-design.md";
const targetPath = "docs/edi-technical-design-site.html";

const markdown = fs.readFileSync(sourcePath, "utf8");
const sourceHash = crypto.createHash("sha256").update(markdown).digest("hex").slice(0, 12);
const sourceLines = markdown.split(/\r?\n/).length;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function isTableStart(lines, index) {
  return lines[index] && lines[index].trim().startsWith("|") && lines[index + 1] && /^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[index + 1]);
}

function renderTable(lines, start) {
  const rows = [];
  let i = start;
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    rows.push(lines[i].trim());
    i += 1;
  }

  const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((cell) => inline(cell.trim()));
  const headers = cells(rows[0]);
  const bodyRows = rows.slice(2).map(cells);
  const html = [
    "<table>",
    "<thead><tr>",
    ...headers.map((header) => `<th>${header}</th>`),
    "</tr></thead>",
    "<tbody>",
    ...bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`),
    "</tbody></table>",
  ].join("");

  return { html, next: i };
}

function renderMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  const headings = [];
  let i = 0;
  let paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const rawLang = trimmed.slice(3).trim() || "text";
      const lang = rawLang === "mermaid" ? "diagram-source" : rawLang;
      i += 1;
      const code = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      out.push(`<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code.join("\n"))}</code></pre>`);
      i += 1;
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text);
      headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      if (id === "4-high-level-architecture") out.push(graphCard("highLevel", "Rendered Architecture"));
      if (id === "8-data-model" || id === "8-database-schema") out.push(graphCard("db", "Database Relationship Map"));
      if (id === "11-6-ruleset-inheritance-and-custom-rules") out.push(graphCard("rules", "Ruleset Inheritance and Publishing Flow"));
      if (id === "11-7-approval-as-workflow-action") out.push(graphCard("approvalPatterns", "Approval as Explicit Workflow Actions"));
      if (id === "15-asn-tracking-and-asn-workflow") out.push(graphCard("asnWorkflow", "PO Workflow to ASN Workflow Bridge"));
      if (id === "21-simulator-first-implementation-prerequisite" || id === "21-simulator-and-test-provider-strategy") out.push(graphCard("simulators", "Simulator Provider Strategy"));
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      flushParagraph();
      const table = renderTable(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      out.push(`<ol>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`);
      continue;
    }

    paragraph.push(trimmed);
    i += 1;
  }

  flushParagraph();
  return { html: out.join("\n"), headings };
}

function graphCard(name, title) {
  return `<section class="graph-card"><div class="graph-title">${escapeHtml(title)}</div><div class="graph" data-graph="${escapeHtml(name)}"></div></section>`;
}

const rendered = renderMarkdown(markdown);
const nav = rendered.headings
  .filter((heading) => heading.level <= 3)
  .map((heading) => `<a class="lvl${heading.level}" href="#${heading.id}">${inline(heading.text)}</a>`)
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EDI Integration Technical Design</title>
<script src="https://unpkg.com/cytoscape@3.28.1/dist/cytoscape.min.js"></script>
<script src="https://unpkg.com/dagre@0.8.5/dist/dagre.min.js"></script>
<script src="https://unpkg.com/cytoscape-dagre@2.5.0/cytoscape-dagre.js"></script>
<style>
:root{color-scheme:dark;--bg:#0b0e12;--panel:#121821;--panel2:#17202b;--ink:#e7edf5;--muted:#9ba8b7;--line:#2a3647;--accent:#5fd3bc;--accent2:#f4b860;--danger:#ff6b6b;--code:#0a1118}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at top left,#16202b 0,#0b0e12 34rem);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.layout{display:grid;grid-template-columns:320px minmax(0,1fr);min-height:100vh}
aside{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--line);background:rgba(10,14,20,.92);padding:22px}
.brand{font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);font-weight:700}.meta{margin:10px 0 18px;color:var(--muted);font-size:12px}
nav{display:grid;gap:3px}nav a{color:var(--muted);text-decoration:none;border-left:2px solid transparent;padding:6px 8px;border-radius:6px}nav a:hover{color:var(--ink);background:#16202b;border-left-color:var(--accent)}.lvl2{padding-left:18px}.lvl3{padding-left:30px;font-size:13px}
main{padding:42px min(7vw,90px) 90px;max-width:1320px}
article{max-width:1120px}h1{font-size:44px;line-height:1.05;margin:0 0 24px;letter-spacing:-.02em}h2{margin-top:54px;padding-top:18px;border-top:1px solid var(--line);font-size:28px}h3{margin-top:34px;font-size:21px;color:#d9f7f0}h4{margin-top:26px;font-size:17px;color:#f5d79e}
p,li{color:#d6deea}a{color:var(--accent)}code{background:#182231;color:#c7fff2;border:1px solid #263548;border-radius:5px;padding:1px 5px}pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:16px;overflow:auto;box-shadow:0 16px 40px rgba(0,0,0,.24)}pre code{background:transparent;border:0;padding:0;color:#d8e4ef}
table{width:100%;border-collapse:collapse;margin:18px 0;background:rgba(18,24,33,.74);border:1px solid var(--line);border-radius:8px;overflow:hidden;display:table}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:10px 12px}th{color:#f3d79c;background:#1b2634}td{color:#d5deeb}
.graph-card{margin:20px 0 28px;background:linear-gradient(180deg,#131b25,#0f151d);border:1px solid var(--line);border-radius:10px;padding:14px;box-shadow:0 24px 70px rgba(0,0,0,.28)}
.graph-title{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--accent2);font-weight:800;margin:0 0 10px}.graph{height:620px;border-radius:8px;background:#090d12;border:1px solid #223044}
.source-note{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 26px}.pill{border:1px solid var(--line);background:#121a25;color:var(--muted);border-radius:999px;padding:6px 10px;font-size:12px}
@media(max-width:980px){.layout{display:block}aside{position:relative;height:auto}.graph{height:520px}main{padding:26px 18px 70px}h1{font-size:34px}}
</style>
</head>
<body>
<div class="layout">
<aside>
<div class="brand">EDI Technical Design</div>
<div class="meta">Generated from ${escapeHtml(sourcePath)}<br>Lines: ${sourceLines} · SHA: ${sourceHash}</div>
<nav>${nav}</nav>
</aside>
<main>
<article>
<div class="source-note"><span class="pill">Source complete</span><span class="pill">Dark theme</span><span class="pill">Cytoscape + Dagre diagrams</span></div>
${rendered.html}
</article>
</main>
</div>
<script>
const colors={edge:"#38485e",core:"#4cc9f0",plugin:"#5fd3bc",queue:"#f4b860",store:"#b8c0ff",risk:"#ff6b6b"};
function n(id,label,layer){return {data:{id,label,layer}}}
function e(source,target,label){return {data:{source,target,label:label||""}}}
const style=[
{selector:"node",style:{label:"data(label)","text-wrap":"wrap","text-max-width":150,"font-size":11,"font-weight":700,color:"#edf6ff","text-valign":"center","text-halign":"center",shape:"round-rectangle",width:150,height:58,"background-color":ele=>colors[ele.data("layer")]||"#60708a","border-width":1,"border-color":"#d7e2ee"}},
{selector:"edge",style:{width:1.6,"line-color":"#65758c","target-arrow-color":"#65758c","target-arrow-shape":"triangle","curve-style":"bezier",label:"data(label)","font-size":9,color:"#aeb9c8","text-background-color":"#090d12","text-background-opacity":.75,"text-background-padding":2}},
{selector:'node[layer = "risk"]',style:{"background-color":colors.risk,color:"#fff"}},
{selector:'node[layer = "store"]',style:{"background-color":colors.store,color:"#10131a"}},
{selector:'node[layer = "queue"]',style:{"background-color":colors.queue,color:"#17110a"}}
];
const graphs={
highLevel:[n("api","Webhook/API Gateway","edge"),n("auth","Auth Guard\\nApi-Key + IP","edge"),n("raw","Raw Event Writer","edge"),n("idem","Idempotency Service","core"),n("ingest","RabbitMQ\\nedi.ingestion","queue"),n("partner","Partner Plugin Runtime","plugin"),n("canonical","Canonical Document Service","core"),n("config","Config Resolver","core"),n("workflow","DB-backed Workflow Engine","core"),n("outbox","Transactional Outbox","core"),n("actionq","RabbitMQ\\nAction Queues","queue"),n("approval","Approval Action\\napproval.manual_decision","plugin"),n("validation","Validation Action\\nruleset_engine","plugin"),n("erp","ERP Action Plugin","plugin"),n("sheet","Sheet Sync Action","plugin"),n("ack","Blinkit PO Ack Action","plugin"),n("asn","ASN Actions\\nschedule + sync","plugin"),n("asntrack","ASN Tracking Jobs","queue"),n("amendment","Amendment Action","plugin"),n("notify","Notification Action","plugin"),n("retry","Retry Scheduler","core"),n("dlq","Dead Letter Queues","risk"),n("poller","ASN Poller Infra","core"),n("pg","Postgres","store"),n("obj","Object Store","store"),n("audit","Audit Ledger","store"),n("trace","Logs/Metrics/Traces","store"),e("api","auth"),e("auth","raw"),e("raw","idem"),e("raw","obj"),e("idem","ingest"),e("ingest","partner"),e("partner","canonical"),e("canonical","workflow"),e("config","workflow"),e("workflow","outbox"),e("outbox","actionq"),e("actionq","approval"),e("actionq","validation"),e("actionq","erp"),e("actionq","sheet"),e("actionq","ack"),e("actionq","asn"),e("actionq","amendment"),e("actionq","notify"),e("approval","workflow"),e("validation","workflow"),e("erp","workflow"),e("sheet","workflow"),e("ack","workflow"),e("asn","workflow"),e("asn","asntrack","schedule"),e("asntrack","poller"),e("amendment","workflow"),e("notify","workflow"),e("retry","actionq"),e("actionq","dlq"),e("workflow","pg"),e("poller","erp"),e("workflow","audit"),e("workflow","trace")],
db:[n("raw","RAW_EVENTS","edge"),n("docs","DOCUMENTS","store"),n("versions","DOCUMENT_VERSIONS","store"),n("links","DOCUMENT_LINKS","store"),n("runs","WORKFLOW_RUNS","core"),n("nodes","WORKFLOW_NODE_RUNS","core"),n("attempts","ACTION_ATTEMPTS","plugin"),n("approvals","APPROVAL_TASKS","plugin"),n("results","VALIDATION_RESULTS","plugin"),n("asn","ASN_TRACKING_JOBS","queue"),n("asna","ASN_TRACKING_JOB_ATTEMPTS","queue"),n("wfv","WORKFLOW_VERSIONS","core"),n("wfn","WORKFLOW_NODES","core"),n("wfe","WORKFLOW_EDGES","core"),n("rules","RULESET_VERSIONS","plugin"),n("snap","CONFIG_SNAPSHOTS","store"),e("raw","docs","creates"),e("docs","versions"),e("docs","links","PO/ASN links"),e("docs","runs"),e("runs","nodes"),e("nodes","attempts"),e("attempts","approvals","approval action"),e("attempts","results","validation action"),e("docs","asn","schedule action"),e("asn","asna","poll history"),e("asn","docs","creates ASN"),e("wfv","wfn"),e("wfv","wfe"),e("rules","results"),e("snap","runs")],
rules:[n("global","Global Ruleset","core"),n("platform","Platform Ruleset\\nBlinkit","core"),n("vendor","Vendor Ruleset","core"),n("seller","Seller Ruleset","core"),n("merge","Effective Ruleset Merge","plugin"),n("preview","Preview + Dry Run","core"),n("publish","Published Immutable Version","store"),n("snapshot","Resolved Config Snapshot","store"),n("validate","validation.ruleset_engine","plugin"),n("results","validation_results","store"),e("global","merge"),e("platform","merge"),e("vendor","merge"),e("seller","merge"),e("merge","preview"),e("preview","publish"),e("publish","snapshot"),e("snapshot","validate"),e("validate","results")],
approvalPatterns:[n("pre","Pre-action Approval","plugin"),n("erp","erp.punch_po","plugin"),n("post","Post-action Approval","plugin"),n("ack","blinkit.po_ack","plugin"),n("risky","Action returns\\nmanual_required","plugin"),n("checkpoint","Checkpoint Approval","plugin"),n("continue","Continuation Action","plugin"),n("reject","Rejected/Expired Terminal","risk"),e("pre","erp","approved"),e("pre","reject","rejected"),e("erp","post","success"),e("post","ack","approved"),e("post","reject","rejected"),e("risky","checkpoint","manual_required"),e("checkpoint","continue","approved"),e("checkpoint","reject","rejected")],
asnWorkflow:[n("poDoc","PurchaseOrder\\ndocument","store"),n("poRun","PO Workflow Run","core"),n("validatePo","validate_po","plugin"),n("dest","ERP punch / Sheet sync","plugin"),n("ack","blinkit_po_ack","plugin"),n("schedule","schedule_asn_tracking","plugin"),n("job","asn_tracking_jobs","queue"),n("attempts","asn_tracking_job_attempts","queue"),n("source","ASN Source Plugin\\nERP get_asn_details","plugin"),n("config","Onboarding Config\\nlocation/tax/item/brand/source","store"),n("build","asn_build_snapshots","store"),n("asnDoc","AdvanceShipmentNotice\\ndocument","store"),n("asnVersion","ASN document_version\\ncanonical_json","store"),n("link","document_links\\nASN generated_from PO","store"),n("asnRun","ASN Workflow Run","core"),n("validateAsn","validate_asn","plugin"),n("sendAsn","blinkit_asn_sync","plugin"),n("messages","partner_messages\\nrequest/response refs","store"),e("poDoc","poRun"),e("poRun","validatePo"),e("validatePo","dest","success"),e("dest","ack","success"),e("ack","schedule","success"),e("schedule","job","create + complete action"),e("job","source","next_poll_at due"),e("source","attempts","store request/response refs"),e("attempts","job","not_ready: reschedule"),e("attempts","build","ready source data"),e("config","build","freeze inputs"),e("build","asnDoc","create ASN"),e("asnDoc","asnVersion"),e("asnDoc","link","source"),e("poDoc","link","target"),e("asnDoc","asnRun"),e("asnRun","validateAsn"),e("validateAsn","sendAsn","success"),e("sendAsn","messages")],
simulators:[n("plugins","Action Plugins","core"),n("provider","Provider Interface","core"),n("blinkitSim","blinkit.simulator","plugin"),n("erpSim","erp.simulator","plugin"),n("sheetSim","sheet.simulator","plugin"),n("blinkitReal","Blinkit Real API","edge"),n("erpReal","Real ERP","edge"),n("sheetReal","Real Sheet","edge"),n("tests","Scenario Catalog","store"),e("plugins","provider"),e("provider","blinkitSim"),e("provider","erpSim"),e("provider","sheetSim"),e("provider","blinkitReal"),e("provider","erpReal"),e("provider","sheetReal"),e("tests","blinkitSim"),e("tests","erpSim"),e("tests","sheetSim")]
};
document.querySelectorAll("[data-graph]").forEach((el)=>{const elements=graphs[el.dataset.graph];if(!elements)return;const cy=cytoscape({container:el,elements,style,layout:{name:"dagre",rankDir:el.dataset.graph==="db"?"TB":"LR",nodeSep:42,rankSep:70},wheelSensitivity:.18,minZoom:.18,maxZoom:2.6});cy.ready(()=>cy.fit(undefined,28));});
</script>
</body>
</html>`;

fs.writeFileSync(targetPath, html);
console.log(`Generated ${targetPath} from ${sourcePath} (${sourceLines} lines, ${sourceHash})`);
