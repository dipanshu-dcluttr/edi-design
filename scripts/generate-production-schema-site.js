const fs = require("fs");
const crypto = require("crypto");

const sourcePath = "docs/edi-production-database-and-queue-schema.md";
const targetPath = "docs/edi-production-database-and-queue-schema-site.html";

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
  return {
    next: i,
    html: `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${bodyRows
      .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`,
  };
}

function graphCard(name, title) {
  return `<section class="graph-card"><div class="graph-title">${escapeHtml(title)}</div><div class="graph" data-graph="${escapeHtml(name)}"></div></section>`;
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
      const lang = trimmed.slice(3).trim() || "text";
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
      if (id === "4-table-catalog") out.push(graphCard("schema", "Database Link Graph"));
      if (id === "5-queue-topology") out.push(graphCard("queues", "Queue Flow Graph"));
      if (id === "6-po-to-asn-example") out.push(graphCard("journey", "PO to ASN Journey Graph"));
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
<title>EDI Production Schema</title>
<script src="https://unpkg.com/cytoscape@3.28.1/dist/cytoscape.min.js"></script>
<script src="https://unpkg.com/dagre@0.8.5/dist/dagre.min.js"></script>
<script src="https://unpkg.com/cytoscape-dagre@2.5.0/cytoscape-dagre.js"></script>
<style>
:root{color-scheme:dark;--bg:#0c0f0d;--panel:#121815;--panel2:#19211d;--ink:#eef5ed;--muted:#a7b3aa;--line:#2b3931;--accent:#8fd14f;--accent2:#f2c14e;--danger:#ef6f6c;--store:#b8c6ff;--queue:#f2c14e;--code:#090d0b}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:linear-gradient(135deg,#0c0f0d,#101812 45%,#090b0a);color:var(--ink);font:15px/1.56 "Avenir Next",ui-sans-serif,system-ui,sans-serif}
.layout{display:grid;grid-template-columns:340px minmax(0,1fr);min-height:100vh}
aside{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--line);background:rgba(8,12,9,.94);padding:22px}
.brand{font-size:13px;text-transform:uppercase;letter-spacing:.16em;color:var(--accent);font-weight:800}.meta{margin:12px 0 20px;color:var(--muted);font-size:12px}
nav{display:grid;gap:2px}nav a{color:var(--muted);text-decoration:none;border-left:2px solid transparent;padding:6px 8px;border-radius:6px}nav a:hover{color:var(--ink);background:#172019;border-left-color:var(--accent)}.lvl2{padding-left:18px}.lvl3{padding-left:30px;font-size:13px}
main{padding:42px min(7vw,88px) 90px;max-width:1400px}article{max-width:1160px}
h1{font-size:44px;line-height:1.05;margin:0 0 20px;letter-spacing:-.01em}h2{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-size:29px}h3{margin-top:34px;font-size:21px;color:#c8f5a2}h4{margin-top:26px;font-size:17px;color:#f5dc97}
p,li{color:#dae4dc}a{color:var(--accent)}code{background:#172119;color:#d9ffc0;border:1px solid #2f432f;border-radius:5px;padding:1px 5px}pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:16px;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.28)}pre code{background:transparent;border:0;padding:0;color:#e1eadf}
table{width:100%;border-collapse:collapse;margin:18px 0;background:rgba(18,24,21,.84);border:1px solid var(--line);border-radius:8px;overflow:hidden;display:table}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:10px 12px}th{color:#f4dda1;background:#1b241f}td{color:#dce5df}
.graph-card{margin:20px 0 30px;background:linear-gradient(180deg,#141b17,#0b100d);border:1px solid var(--line);border-radius:10px;padding:14px;box-shadow:0 24px 70px rgba(0,0,0,.3)}
.graph-title{font-size:12px;text-transform:uppercase;letter-spacing:.14em;color:var(--accent2);font-weight:800;margin:0 0 10px}.graph{height:650px;border-radius:8px;background:#070a08;border:1px solid #26362c}
.source-note{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 26px}.pill{border:1px solid var(--line);background:#131b16;color:var(--muted);border-radius:999px;padding:6px 10px;font-size:12px}
@media(max-width:980px){.layout{display:block}aside{position:relative;height:auto}.graph{height:520px}main{padding:26px 18px 70px}h1{font-size:34px}}
</style>
</head>
<body>
<div class="layout">
<aside>
<div class="brand">Production Schema</div>
<div class="meta">Generated from ${escapeHtml(sourcePath)}<br>Lines: ${sourceLines} · SHA: ${sourceHash}</div>
<nav>${nav}</nav>
</aside>
<main>
<article>
<div class="source-note"><span class="pill">Postgres DDL</span><span class="pill">RabbitMQ contracts</span><span class="pill">PO-to-ASN links</span></div>
${rendered.html}
</article>
</main>
</div>
<script>
const colors={core:"#8fd14f",store:"#b8c6ff",queue:"#f2c14e",plugin:"#76e4f7",risk:"#ef6f6c",edge:"#809188"};
function n(id,label,layer){return {data:{id,label,layer}}}
function e(source,target,label){return {data:{source,target,label:label||""}}}
const style=[
{selector:"node",style:{label:"data(label)","text-wrap":"wrap","text-max-width":160,"font-size":10.5,"font-weight":800,color:"#eff7ef","text-valign":"center","text-halign":"center",shape:"round-rectangle",width:158,height:58,"background-color":ele=>colors[ele.data("layer")]||"#69756e","border-width":1,"border-color":"#e5efe2"}},
{selector:'node[layer = "store"]',style:{"background-color":colors.store,color:"#10131a"}},
{selector:'node[layer = "queue"]',style:{"background-color":colors.queue,color:"#17110a"}},
{selector:'node[layer = "risk"]',style:{"background-color":colors.risk,color:"#fff"}},
{selector:"edge",style:{width:1.6,"line-color":"#74857b","target-arrow-color":"#74857b","target-arrow-shape":"triangle","curve-style":"bezier",label:"data(label)","font-size":9,color:"#bfccc2","text-background-color":"#070a08","text-background-opacity":.8,"text-background-padding":2}}
];
const graphs={
schema:[
n("brand","brands","store"),n("vendor","vendors","store"),n("seller","sellers","store"),n("locations","seller_locations","store"),n("contacts","seller_contacts","store"),n("tax","seller_tax_profiles","store"),n("items","seller_item_mappings","store"),n("acct","platform_accounts","store"),n("cred","credentials","risk"),n("asnconfig","asn_source_configs","core"),n("asnbuild","asn_build_snapshots","store"),
n("raw","raw_events","store"),n("idem","idempotency_keys","store"),n("doc","documents","store"),n("ver","document_versions","store"),n("link","document_links","store"),
n("wft","workflow_templates","core"),n("wfv","workflow_versions","core"),n("wfn","workflow_nodes","core"),n("wfe","workflow_edges","core"),n("wfl","workflow_layouts","core"),n("wfa","workflow_assignments","core"),
n("snap","resolved_config_snapshots","store"),n("run","workflow_runs","core"),n("node","workflow_node_runs","core"),n("attempt","action_attempts","plugin"),n("approval","approval_tasks","plugin"),n("validation","validation_results","plugin"),
n("ruledef","rule_definitions","plugin"),n("rsv","ruleset_versions","plugin"),n("rsr","ruleset_rules","plugin"),n("rsa","ruleset_assignments","plugin"),
n("apc","action_plugin_configs","plugin"),n("apv","approval_policy_versions","plugin"),n("rpv","retry_policy_versions","plugin"),n("outbox","outbox","queue"),
n("pm","partner_messages","plugin"),n("asnjob","asn_tracking_jobs","queue"),n("asnattempt","asn_tracking_job_attempts","queue"),
n("domain","domain_events","store"),n("state","state_transitions","store"),n("dl","dead_letters","risk"),n("audit","audit_log","store"),n("registry","plugin_registry","plugin"),
e("brand","items","brand_id"),e("vendor","seller"),e("seller","locations"),e("locations","contacts"),e("locations","tax"),e("seller","items"),e("seller","acct"),e("acct","cred"),e("seller","asnconfig"),e("seller","raw"),e("raw","doc","creates"),e("raw","idem","dedupe"),e("doc","ver","versions"),e("doc","link","source/target"),e("ver","link","version refs"),e("locations","asnbuild","ship-from"),e("tax","asnbuild","GST"),e("items","asnbuild","item/brand map"),e("asnconfig","asnbuild","source config"),
e("wft","wfv"),e("wfv","wfn"),e("wfv","wfe"),e("wfv","wfl"),e("wfv","wfa"),e("wfa","run","selected"),e("doc","snap"),e("snap","run"),e("run","node"),e("node","attempt"),e("attempt","pm"),e("node","approval"),e("attempt","validation"),
e("ruledef","rsr"),e("rsv","rsr"),e("rsv","rsa"),e("apc","snap"),e("apv","snap"),e("rpv","snap"),e("outbox","attempt","dispatch"),e("doc","asnjob","PO schedules"),e("asnjob","asnattempt","polls"),e("asnattempt","asnbuild","source response"),e("asnbuild","doc","creates ASN"),e("asnjob","doc","creates ASN"),e("registry","wfn","plugin"),e("domain","outbox"),e("state","audit"),e("dl","audit")
],
queues:[
n("api","API / Raw Writer","core"),n("outbox","outbox table","store"),n("dispatcher","Outbox Dispatcher","core"),n("ing","edi.ingestion","queue"),n("validation","edi.actions.validation","queue"),n("erp","edi.actions.erp","queue"),n("sheet","edi.actions.sheet","queue"),n("partner","edi.actions.partner","queue"),n("notification","edi.actions.notification","queue"),n("asn","edi.asn.tracking.due","queue"),n("retry","edi.retry","queue"),n("dlq","edi.dlq","risk"),n("docworker","Document Worker","plugin"),n("actionworker","Action Workers","plugin"),n("asnworker","ASN Tracking Worker","plugin"),
e("api","outbox","ingestion msg"),e("outbox","dispatcher"),e("dispatcher","ing"),e("dispatcher","validation"),e("dispatcher","erp"),e("dispatcher","sheet"),e("dispatcher","partner"),e("dispatcher","notification"),e("dispatcher","asn"),e("ing","docworker"),e("validation","actionworker"),e("erp","actionworker"),e("sheet","actionworker"),e("partner","actionworker"),e("notification","actionworker"),e("asn","asnworker"),e("actionworker","retry","retryable"),e("asnworker","retry","not due/failure"),e("retry","dispatcher"),e("actionworker","dlq","poison"),e("asnworker","dlq","poison")
],
journey:[
n("raw","raw_events\\nPO webhook","store"),n("po","documents\\nPurchaseOrder","store"),n("pov","document_versions\\nPO v1/v2","store"),n("powf","workflow_runs\\nPO workflow","core"),n("poack","action_attempts\\nblinkit.po_ack","plugin"),n("ackmsg","partner_messages\\nPO ack req/res","plugin"),n("schedule","action_attempts\\nschedule_asn_tracking","plugin"),n("asnjob","asn_tracking_jobs\\nwaiting/polling","queue"),n("polls","asn_tracking_job_attempts\\nERP get_asn_details","queue"),n("config","onboarding config\\nlocation/tax/item/brand/source","store"),n("build","asn_build_snapshots\\nfrozen build inputs","store"),n("asn","documents\\nAdvanceShipmentNotice","store"),n("asnv","document_versions\\nASN payload","store"),n("link","document_links\\nASN generated_from PO","store"),n("asnwf","workflow_runs\\nASN workflow","core"),n("send","action_attempts\\nblinkit.asn_sync","plugin"),n("asnmsg","partner_messages\\nASN req/res","plugin"),
e("raw","po"),e("po","pov"),e("pov","powf"),e("powf","poack"),e("poack","ackmsg"),e("powf","schedule"),e("schedule","asnjob"),e("asnjob","polls"),e("polls","build","ready"),e("config","build"),e("build","asn","create"),e("asn","asnv"),e("asn","link","source"),e("po","link","target"),e("asn","asnwf"),e("asnwf","send"),e("send","asnmsg")
]
};
document.querySelectorAll(".graph").forEach((el)=>{
  const cy=cytoscape({container:el,elements:graphs[el.dataset.graph],style,layout:{name:"dagre",rankDir:"LR",nodeSep:45,rankSep:90,edgeSep:20},wheelSensitivity:.18});
  cy.fit(undefined,28);
});
</script>
</body>
</html>`;

fs.writeFileSync(targetPath, html);
console.log(`Generated ${targetPath} from ${sourcePath}`);
