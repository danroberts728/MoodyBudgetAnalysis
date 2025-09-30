/* globals d3 */
/**
 * Drillable pie for Moody Budget
 * Level 0: Departments (sum of 2025-2026 Approved per department)
 * Level 1: Accounts within a department
 * “Other” bucket: If the sum of the smallest 2+ slices < 5% of total,
 *   aggregate them into an “Other” slice. Clicking “Other” reveals the
 *   items it contains (and from there you can drill further if needed).
 */

const DEFAULT_DATA_URL_START = "https://docs.google.com/spreadsheets/d/e/";
const DEFAULT_DATA_URL = DEFAULT_DATA_URL_START + "2PACX-1vRRtJHPNjRvv_DT0suQ4u-Z4yHKa-cwkkACS-l_QmJrPm7uuAnTUmN7xdwISa7iAEJfuuVrTEjY1xkV/pub?output=tsv";

// ----------------------------------------------
// Helpers
// ----------------------------------------------
const fmtCurrency = d3.format("$,");
const fmtPct = d3.format(".1%");

// Be generous with header names; normalize to lower+no spaces
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

function firstKey(obj, keys) {
  const wanted = keys.map(norm);
  for (const k of Object.keys(obj)) {
    if (wanted.includes(norm(k))) return k;
  }
  return null;
}

function parseNumber(x) {
  if (x == null) return 0;
  const s = String(x).replace(/[\$,]/g, "").trim();
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

// Returns {kept: [{name,value,meta}], other: [{...}, ...], total}
function withOtherBucket(items, threshold = 0.05) {
  const total = d3.sum(items, d => d.value);
  if (total <= 0) return { kept: items, other: [], total };

  // Sort ascending by value; find smallest N (N >= 2) whose sum < threshold
  const sortedAsc = items.slice().sort((a, b) => d3.ascending(a.value, b.value));
  let bucket = [];
  let acc = 0;
  for (let i = 0; i < sortedAsc.length; i++) {
    const next = sortedAsc[i];
    const nextAcc = acc + next.value;
    if (i + 1 >= 2 && nextAcc / total < threshold) {
      bucket.push(next);
      acc = nextAcc;
    } else if (i + 1 < 2) {
      // we need at least 2 in the bucket; force the first two in and keep checking
      bucket.push(next);
      acc = nextAcc;
    } else {
      break;
    }
  }

  // If making “Other” wouldn’t reduce clutter, skip it.
  if (bucket.length < 2) return { kept: items, other: [], total };

  const bucketIds = new Set(bucket.map(d => d.id));
  const kept = items.filter(d => !bucketIds.has(d.id));
  const otherValue = d3.sum(bucket, d => d.value);

  kept.push({
    id: "__OTHER__",
    name: "Other",
    value: otherValue,
    meta: { children: bucket } // store what’s inside
  });

  return { kept, other: bucket, total };
}

// ----------------------------------------------
// Layout
// ----------------------------------------------
const root = d3.select("#app").style("position", "relative");

let width = 900;
let height = 560;
let radius = Math.min(width, height) / 2 - 10;

const svg = root
  .append("svg")
  .attr("viewBox", `0 0 ${width} ${height}`)
  .attr("width", "100%")
  .attr("height", "100%")
  .attr("preserveAspectRatio", "xMidYMid meet");;

const chartG = svg
  .append("g");

let arc = d3.arc().innerRadius(radius * 0.55).outerRadius(radius);
let arcHover = d3.arc().innerRadius(radius * 0.52).outerRadius(radius * 1.03);

const pie = d3
  .pie()
  .value(d => d.value)
  .sort(null);

const color = d3.scaleOrdinal(d3.schemeTableau10);

// Tooltip
const tip = root
  .append("div")
  .attr("class", "mb-tooltip")
  .style("opacity", 0);

// Breadcrumb
const crumbs = root.append("div").attr("class", "mb-breadcrumb");

// Center label
const center = chartG.append("text")
  .attr("text-anchor", "middle")
  .attr("dy", "0.35em")
  .attr("class", "mb-center");

// Back button
const backBtn = root.append("button")
  .attr("class", "mb-back")
  .text("◀ Back")
  .style("display", "none")
  .on("click", () => drillBack());

// ----------------------------------------------
// Data prep
// ----------------------------------------------
async function loadData() {
  var $_GET = {};
  if(document.location.toString().indexOf('?' !== -1)) {
    var query = document.location
        .toString()
        .replace(/^.*?\?/, '')
        .replace(/#.*$/, '')
        .split('&');
    for(var i=0, l=query.length; i<l; i++) {
       var aux = decodeURIComponent(query[i]).split('=');
       $_GET[aux[0]] = aux[1];
    }
  }
  
  let fetch_url = DEFAULT_DATA_URL;
  if("doc_id" in $_GET) {
    fetch_url = DEFAULT_DATA_URL_START + $_GET['doc_id'] + "/pub?";
  }
  if("gid" in $_GET) {
    fetch_url += "&gid=" + $_GET["gid"] + "&single=true";
  }
  if(fetch_url != DEFAULT_DATA_URL) {
    fetch_url += "&output=tsv";
  }

  const tsv = await fetch(fetch_url).then(r => r.text());
  const rows = d3.tsvParse(tsv);

  // Column detection
  const sample = rows[0] || {};
  const deptKey = firstKey(sample, ["department", "dept", "division", "fund", "function"]);
  const acctKey = firstKey(sample, ["account title", "account", "title", "line item"]);
  const approvedKey = firstKey(sample, ["2025-2026 approved", "2025 - 2026 approved", "approved 2025-2026"]);

  if (!deptKey || !acctKey || !approvedKey) {
    console.error("Could not detect headers. Found keys:", Object.keys(sample));
    throw new Error("Missing expected columns (Department, Account Title, 2025-2026 Approved).");
  }

  const clean = rows.map((r, i) => ({
    id: `row-${i}`,
    dept: String(r[deptKey] || "").trim().replace("City of Moody", ""),
    account: String(r[acctKey] || "").trim(),
    approved: parseNumber(r[approvedKey])
  })).filter(d => d.dept && d.account && d.approved > 0);

  // Aggregate department totals
  const byDept = d3.rollups(
    clean,
    v => d3.sum(v, d => d.approved),
    d => d.dept
  ).map(([dept, total]) => ({ id: `dept-${dept}`, name: dept, value: total }));

  // Build a map: dept -> accounts[]
  const accountsByDept = d3.group(clean, d => d.dept);
  return { byDept, accountsByDept };
}

// ----------------------------------------------
// Drilldown controller
// ----------------------------------------------
const state = {
  level: 0,              // 0 = departments, 1 = accounts (or expanded “Other”)
  stack: [],             // breadcrumb stack of {title, data, kind}
  current: null          // {title, data, kind}
};

function showBreadcrumb() {
  if (!state.stack.length && !state.current) {
    crumbs.html("");
    return;
  }
  const parts = [...state.stack.map(s => s.title), state.current?.title].filter(Boolean);
  crumbs.html(parts.map((p, i) => {
    const isLast = i === parts.length - 1;
    return `<span class="${isLast ? "mb-crumb-last" : "mb-crumb"}">${p}</span>`;
  }).join(`<span class="mb-crumb-sep">›</span>`));
}

function drillTo({ title, data, kind }) {
  state.current = { title, data, kind };
  state.level = (kind === "departments") ? 0 : 1;
  backBtn.style("display", state.stack.length ? null : "none");
  showBreadcrumb();
  renderPie(data, title);
}

function drillIn(next) {
  if (state.current) state.stack.push(state.current);
  drillTo(next);
}

function drillBack() {
  if (!state.stack.length) return;
  const prev = state.stack.pop();
  drillTo(prev);
}

// Build the “view data” for departments, with Other if needed
function viewDepartments(withOther = true) {
  const { byDept } = cache;
  let items = byDept.map(d => ({ ...d })); // copy
  if (withOther) {
    items = withOtherBucket(items).kept;
  }
  return items;
}

// Build the “view data” for accounts in a dept, with Other if needed
function viewAccountsForDept(deptName, withOther = true) {
  const rows = cache.accountsByDept.get(deptName) || [];
  let items = rows.map((r) => ({
    id: `acct-${deptName}-${r.account}`,
    name: r.account,
    value: r.approved,
    meta: { dept: deptName }
  }));
  if (withOther) {
    items = withOtherBucket(items).kept;
  }
  return items;
}

// If user clicks "Other" at departments: show its departments
// If user clicks "Other" at accounts: show the actual accounts
function expandOther(container) {
  // container.meta.children is the array of items that were bucketed
  const kids = container.meta?.children || [];
  return kids.map(k => ({ ...k })); // shallow copy
}

// ----------------------------------------------
// Render
// ----------------------------------------------
function renderPie(items, title = "") {
  const total = d3.sum(items, d => d.value);
  
  center.text(total > 0 ? `${title}\n${fmtCurrency(total)}` : title);

  const arcs = pie(items);

  const g = chartG.selectAll("path.slice")
    .data(arcs, d => d.data.id);

  g.enter()
    .append("path")
    .attr("class", "slice")
    .attr("fill", d => color(d.data.name))
    .attr("d", arc)
    .on("mouseenter", function (event, d) {
      d3.select(this).transition().duration(150).attr("d", arcHover);
      const pct = total ? d.data.value / total : 0;
      tip.style("opacity", 1)
        .html(`
          <div class="mb-tip-title">${d.data.name}</div>
          <div>${fmtCurrency(d.data.value)} <span class="mb-tip-pct">(${fmtPct(pct)})</span></div>
        `);
    })
    .on("mousemove", function (event) {
      tip.style("left", (event.pageX + 12) + "px")
         .style("top", (event.pageY + 12) + "px");
    })
    .on("mouseleave", function () {
      d3.select(this).transition().duration(150).attr("d", arc);
      tip.style("opacity", 0);
    })
    .on("click", (event, d) => {
      // Drill logic
      if (state.level === 0) {
        // Clicked a department slice
        if (d.data.id === "__OTHER__") {
          const kids = expandOther(d.data); // array of small departments
          drillIn({
            title: "Other Departments",
            data: kids,
            kind: "departments" // keep at dept-level; clicking a dept here drills to its accounts
          });
        } else {
          drillIn({
            title: d.data.name,
            data: viewAccountsForDept(d.data.name, true),
            kind: "accounts"
          });
        }
      } else {
        // level 1 (accounts)
        if (d.data.id === "__OTHER__") {
          const kids = expandOther(d.data); // the small accounts for this dept
          drillIn({
            title: "Other Accounts",
            data: kids,
            kind: "accounts"
          });
        }
        // (If we ever add a deeper level, handle here.)
      }
    })
    .append("title")
    .text(d => `${d.data.name}\n${fmtCurrency(d.data.value)}`);

  g.transition().duration(450).attrTween("d", function (d) {
    const i = d3.interpolate(this._current || d, d);
    this._current = i(0);
    return t => arc(i(t));
  });

  g.exit().transition().duration(300).style("opacity", 0).remove();

  // Labels
  const texts = chartG.selectAll("text.slice-label").data(arcs, d => d.data.id);

const enter = texts.enter()
  .append("text")
  .attr("class", "slice-label")
  .attr("text-anchor", "middle")
  .attr("pointer-events", "none");

enter.append("tspan").attr("class", "label-name").attr("x", 0).attr("dy", "-0.2em");
enter.append("tspan").attr("class", "label-value").attr("x", 0).attr("dy", "1.2em");

texts.merge(enter)
  .transition().duration(450)
  .attrTween("transform", function (d) {
    const i = d3.interpolate(this._pos || d, d);
    this._pos = i(0);
    return t => {
      const a = arc.centroid(i(t));
      return `translate(${a[0]},${a[1]})`;
    };
  })
  .on("end", function (d) {
    const pct = total ? d.data.value / total : 0;
    const g = d3.select(this);
    if (pct >= 0.04) {
      g.select("tspan.label-name").text(d.data.name);
      g.select("tspan.label-value").text(fmtCurrency(d.data.value));
    } else {
      g.select("tspan.label-name").text("");
      g.select("tspan.label-value").text("");
    }
  });

  texts.exit().remove();
}

function resize() {
  const box = root.node().getBoundingClientRect();
  let W = Math.max(280, Math.round(box.width));       // never smaller than 280
  let H = Math.max(360, Math.round(W * 0.62));        // keep nice aspect ratio

  width = W;
  height = H;
  radius = Math.min(width, height) / 2 - 10;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  chartG.attr("transform", `translate(${width / 2}, ${height / 2})`);

  arc = d3.arc().innerRadius(radius * 0.55).outerRadius(radius);
  arcHover = d3.arc().innerRadius(radius * 0.52).outerRadius(radius * 1.03);

  // Re-render current view with new geometry
  if (state.current) renderPie(state.current.data, state.current.title);
}

// ----------------------------------------------
// Boot
// ----------------------------------------------
let cache = { byDept: [], accountsByDept: new Map() };

(async function init() {
  try {
    cache = await loadData();

    resize();
    drillTo({
      title: "2025–2026 Approved",
      data: viewDepartments(true),
      kind: "departments"
    });

    // Make it responsive
    const ro = new ResizeObserver(() => {
      // (SVG has viewBox + width:100%, so it scales automatically)
    });
    ro.observe(document.body);
  } catch (err) {
    console.error(err);
    d3.select("#app").append("pre").text("Failed to load data:\n" + err.message);
  }
})();
