/* City of Moody Budget
 */

/* Constants */
// Location of TSV output document publish. This is kinda finicky in how it's formatted for now.
const TSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRRtJHPNjRvv_DT0suQ4u-Z4yHKa-cwkkACS-l_QmJrPm7uuAnTUmN7xdwISa7iAEJfuuVrTEjY1xkV/pub?gid=0&single=true&output=tsv";

// Pie segment threshold for whether to show on-the pie or to use leader line
const THRESHOLD_FOR_LEADER = 0.08;

// Pie segments less than this % are comined into "Other"
const THRESHOLD_FOR_OTHER = 0.03;

/* DOM elements */
const tableView = d3.select("#tableView");
const tableBody = d3.select("#tableBody");
const pieView = d3.select("#pieView");
const pieSvg = d3.select("#pieSvg");
const pieLegend = d3.select("#pieLegend");
const pieTitle = d3.select("#pieTitle");
const pieSubhead = d3.select("#pieSubhead");
const backBtn = d3.select("#backBtn");

/* Formats */
const fmt_whole_number = d3.format(",.0f");
const fmt_one_decimal = d3.format(".1f");
const fmt_dollars = x => `$${fmt_whole_number(x)}`;

/* Tooltip and methods */
const tip = d3.select("body").append("div")
    .attr("class", "mb-tip hidden")
    .attr("role", "tooltip");
function showTip(html, x, y) {
    tip.html(html)
        .style("left", (x + 12) + "px")
        .style("top", (y + 12) + "px")
        .classed("hidden", false);
}
function hideTip() {
    tip.classed("hidden", true).style("left", "-9999px").style("top", "-9999px");
}


let revRows = [];
let expRows = [];
let lessRows = [];

// For showing the "More" button (count > 1)
let revBudgetToAccounts = new Map();
let expBudgetToAccounts = new Map();
let lessBudgetToAccounts = new Map();

// For responsive re-render of the current pie
let lastPieState = null; // { allItems, opts, header }
let pieHistory = [];

init();

async function init() {
    let rawRows = [];
    try {
        const rawTsv = await fetch(TSV_URL).then(r => r.text());
        const parsed = d3.tsvParse(rawTsv);

        // <<< Set these EXACTLY to your TSV headers >>>
        const TYPE_COL = "Type";
        const BUDGET_COL = "Budget";
        const DEPT_COL = "Department";
        const ACCT_COL = "Account";
        const APPROVED_COL = "2025-2026 Approved";

        const money = s => {
            const v = +String(s ?? "").replace(/[^0-9.-]/g, "");
            return Number.isFinite(v) ? v : 0;
        };

        rawRows = parsed.map(d => ({
            Type: (d[TYPE_COL] ?? "").trim(),
            Budget: (d[BUDGET_COL] ?? "").trim(),
            Department: (d[DEPT_COL] ?? "").trim(),
            Account: (d[ACCT_COL] ?? "").trim(),
            Approved: money(d[APPROVED_COL])
        }));

        const normType = s => String(s || "").trim().toUpperCase();
        revRows = rawRows.filter(r => normType(r.Type) === "REVENUE" && r.Budget && r.Approved > 0);
        expRows = rawRows.filter(r => normType(r.Type) === "EXPENSE" && r.Budget && r.Approved > 0);
        lessRows = rawRows.filter(r => normType(r.Type) === "LESS" && r.Budget && r.Approved > 0);

        // Build Budget -> Accounts list (for >1 check)
        revBudgetToAccounts = buildBudgetAccounts(revRows);
        expBudgetToAccounts = buildBudgetAccounts(expRows);
        lessBudgetToAccounts = buildBudgetAccounts(lessRows);

        renderBudgetTable();

        backBtn.on("click", () => {
            hideTip();
            if (pieHistory.length > 0) {
                const prev = pieHistory.pop();
                // Restore header + render the prior pie
                applyHeader(prev.header);
                renderPie(prev.allItems, prev.opts);
                lastPieState = prev;
            } else {
                // No more pie levels—return to table
                pieView.classed("hidden", true);
                tableView.classed("hidden", false);
                backBtn.classed("hidden", true);
                lastPieState = null;
            }
        });

        // Debounced resize that respects current pie state
        let t = null;
        window.addEventListener("resize", () => {
            clearTimeout(t);
            t = setTimeout(() => {
                if (lastPieState) {
                    const { allItems, opts, header } = lastPieState;
                    applyHeader(header);
                    renderPie(allItems, opts);
                }
            }, 120);
        });

    } catch (err) {
        console.error(err);
        alert(`Problem loading/structuring data:\n${err.message}`);
    }
}

/* ===== Helpers ===== */

function renderLegend(pieData, color) {
    // pieData should be your arcs (same data you bind to slices)
    // color is your color scale

    const legend = d3.select("#legend");
    // Efficient join that handles enter + update + exit
    const items = legend.selectAll(".legend-item")
        .data(pieData, d => d.data.id ?? d.data.key ?? d.data.account ?? d.index);

    items.exit().remove();

    const enter = items.enter()
        .append("div")
        .attr("class", "legend-item")
        .attr("role", "listitem")
        .attr("aria-label", d => `${(d.data.account ?? d.data.key ?? "Item")} ${fmt_dollars(d.data.value)}`);

    enter.append("span")
        .attr("class", "legend-swatch")
        .style("background-color", d => color(d.data.key ?? d.data.account ?? d.index));

    const textWrap = enter.append("div").attr("class", "legend-text");
    textWrap.append("div").attr("class", "legend-title");
    textWrap.append("div").attr("class", "legend-value");

    // enter + update
    const merged = enter.merge(items);
    merged.select(".legend-title")
        .text(d => d.data.account ?? d.data.key ?? d.data.name ?? "Other");

    merged.select(".legend-value")
        .text(d => fmt_dollars(d.data.value));
}

function applyHeader(header) {
    if (!header) return;
    pieTitle.text(header.titleText || "");
    pieSubhead.text(header.subheadText || "");
}

function navigateToPie(allItems, opts, header) {
    // Dismiss on tap anywhere in the SVG and on resize/scroll
    pieSvg.on("pointerdown", (event) => {
        // only hide if you tapped somewhere that's NOT a slice
        if (!event.target.closest?.("path.slice")) hideTip();
    });
    window.addEventListener("resize", hideTip, { passive: true });
    window.addEventListener("scroll", hideTip, { passive: true });

    hideTip();
    // Push current view to history if we’re already showing a pie
    if (lastPieState) {
        pieHistory.push(lastPieState);
    }

    // Ensure pie view is visible
    tableView.classed("hidden", true);
    pieView.classed("hidden", false);
    backBtn.classed("hidden", false);

    // Update header (title/subhead)
    const hdr = header || (lastPieState ? lastPieState.header : null);
    applyHeader(hdr);

    // Render and capture state
    renderPie(allItems, opts);
    lastPieState = { allItems, opts, header: hdr };
}

function buildBudgetAccounts(rows) {
    // Budget -> [{account, value}] sorted desc
    return new Map(
        d3.rollups(
            rows,
            v => {
                const grouped = d3.rollups(
                    v,
                    g => d3.sum(g, r => r.Approved),
                    r => r.Account || "(Unlabeled)"
                ).map(([account, value]) => ({ account, value }));
                return grouped.sort((a, b) => d3.descending(a.value, b.value));
            },
            r => r.Budget
        )
    );
}
function sumRows(rows) { return d3.sum(rows, d => d.Approved); }
function splitDepartments(cell) {
    if (!cell) return [];
    return cell.split(/[;,]/).map(s => s.trim()).filter(Boolean);
}
function cleanName(s) {
    // Remove a leading "City of Moody" plus common separators
    if (!s) return s;
    return s
        .replace(/^\s*City of Moody\s*[-:–—]?\s*/i, "")
        .replace(/\s*\(City of Moody\)\s*$/i, "")
        .trim();
}

/* Grouping helper: combine all < THRESHOLD_FOR_OTHER % into "Other"; if that sum is smaller than threshold,
   keep adding the next-smallest slices until Other ≥5%. */
function groupStrictOthers(items) {
    const total = d3.sum(items, d => d.value) || 1;

    // Sort ascending by value
    const asc = [...items].sort((a, b) => d3.ascending(a.value, b.value));

    // Take all <5%
    let smalls = asc.filter(d => d.value / total < THRESHOLD_FOR_OTHER);
    let remaining = asc.filter(d => d.value / total >= THRESHOLD_FOR_OTHER);

    // If nothing to group, return original
    if (smalls.length === 0) return items;

    let otherValue = d3.sum(smalls, d => d.value);

    // Ensure "Other" itself is ≥5% (and avoid consuming everything)
    while ((otherValue / total) * 100 < THRESHOLD_FOR_OTHER && remaining.length > 0) {
        const next = remaining.shift(); // smallest of the remaining
        smalls.push(next);
        otherValue += next.value;
    }

    // Edge case: if we consumed everything, revert
    if (smalls.length === asc.length) return items;

    const other = { account: "Other", value: otherValue, __other: smalls };
    const keep = asc.filter(d => !smalls.includes(d));

    return [...keep, other];
}

// Wrap <text> to a given width (multi-line tspan)
function wrapText(selection, width, lineHeight = 1.15) {
    selection.each(function () {
        const text = d3.select(this);
        const words = text.text().split(/\s+/).filter(Boolean);
        let line = [];
        let tspan = text.text(null).append("tspan").attr("x", 0).attr("dy", "0em");
        for (let i = 0; i < words.length; i++) {
            line.push(words[i]);
            tspan.text(line.join(" "));
            if (tspan.node().getComputedTextLength() > width) {
                line.pop();
                tspan.text(line.join(" "));
                line = [words[i]];
                tspan = text.append("tspan")
                    .attr("x", 0)
                    .attr("dy", `${lineHeight}em`)
                    .text(words[i]);
            }
        }
    });
}

// ===== NEW: size-aware overlap resolver for external label columns =====
function resolveOverlaps(nodes, minY, maxY, pad = 6) {
    // nodes: [{ y, height }]
    nodes.sort((a, b) => a.y - b.y);

    // forward pass (push down)
    for (let i = 1; i < nodes.length; i++) {
        const prev = nodes[i - 1], cur = nodes[i];
        const needed = (prev.height / 2 + cur.height / 2) + pad;
        if (cur.y - prev.y < needed) {
            cur.y = prev.y + needed;
        }
    }

    // backward pass (pull up)
    for (let i = nodes.length - 2; i >= 0; i--) {
        const cur = nodes[i], next = nodes[i + 1];
        const needed = (cur.height / 2 + next.height / 2) + pad;
        if (next.y - cur.y < needed) {
            cur.y = next.y - needed;
        }
    }

    // clamp
    for (const n of nodes) {
        n.y = Math.max(minY + n.height / 2, Math.min(maxY - n.height / 2, n.y));
    }

    // final forward pass if clamping created new conflicts
    for (let i = 1; i < nodes.length; i++) {
        const prev = nodes[i - 1], cur = nodes[i];
        const needed = (prev.height / 2 + cur.height / 2) + pad;
        if (cur.y - prev.y < needed) {
            cur.y = Math.min(maxY - cur.height / 2, prev.y + needed);
        }
    }
    return nodes;
}

/* ===== Table ===== */
function renderBudgetTable() {
    tableBody.selectAll("*").remove();

    const groupByBudget = rows => {
        const map = new Map();
        for (const r of rows) {
            const entry = map.get(r.Budget) || { total: 0, accounts: new Set() };
            entry.total += r.Approved;
            entry.accounts.add(r.Account || "(Unlabeled)");
            map.set(r.Budget, entry);
        }
        return [...map.entries()]
            .map(([budget, { total, accounts }]) => ({ budget, total, accountsCount: accounts.size }))
            .sort((a, b) => d3.descending(a.total, b.total));
    };

    const revAgg = groupByBudget(revRows);
    const expAgg = groupByBudget(expRows);
    const lessAgg = groupByBudget(lessRows);

    const revTotal = d3.sum(revRows, d => d.Approved);
    const expTotal = d3.sum(expRows, d => d.Approved);
    const lessTotal = d3.sum(lessRows, d => d.Approved);
    const net = revTotal - expTotal - lessTotal; // Difference Revenue vs Expense

    // Helper to render a block of budget rows (no section headers)
    const appendRows = (items, accountsMap, sectionLabel) => {
        for (const row of items) {
            const accounts = accountsMap.get(row.budget) || [];
            const showMore = accounts.length > 1;

            const tr = tableBody.append("tr");

            // Budget cell (with optional More button)
            const tdBudget = tr.append("td").attr("class", "col-budget");
            tdBudget.text(row.budget);
            if (showMore) {
                tdBudget.append("button")
                    .attr("class", "more-btn")
                    .attr("type", "button")
                    .text("More ▸")
                    .on("click", (e) => {
                        e.stopPropagation();
                        showDeptPieForBudget(sectionLabel, row.budget);
                    });
            }

            // Amount
            tr.append("td").attr("class", "col-total").text(fmt_dollars(row.total));
        }
    };

    // Renders: Revenues → Total Revenues
    appendRows(revAgg, revBudgetToAccounts, "Revenues");
    tableBody.append("tr").attr("class", "total-row total-rev")
        .html(`
      <td class="col-budget label">Total Revenues</td>
      <td class="col-total val">${fmt_dollars(revTotal)}</td>
    `);

    // Expenses → Total Expenses
    appendRows(expAgg, expBudgetToAccounts, "Expenses");
    tableBody.append("tr").attr("class", "total-row total-exp")
        .html(`
      <td class="col-budget label">Total Expenses</td>
      <td class="col-total val">${fmt_dollars(expTotal)}</td>
    `);

    // LESS (no section total)
    appendRows(lessAgg, lessBudgetToAccounts, "LESS");

    // Net Difference (Revenues - Expenses - LESS)
    tableBody.append("tr").attr("class", "net-row total-row")
        .html(`
      <td class="col-budget label">Difference Revenue vs Expense</td>
      <td class="col-total val">${fmt_dollars(net)}</td>
    `);
}

/* ===== Pie: Dept (per budget) -> Accounts (dept+budget) ===== */
function showDeptPieForBudget(sectionLabel, budgetName) {
    const baseRows =
        sectionLabel === "Revenues" ? revRows :
            sectionLabel === "Expenses" ? expRows : lessRows;

    // rows for this budget
    const rows = baseRows.filter(r => r.Budget === budgetName && r.Approved > 0);
    if (rows.length === 0) {
        alert(`No rows found for "${budgetName}".`);
        return;
    }

    // Sum by department for THIS budget (split multi-dept rows evenly)
    const deptSums = new Map();
    for (const r of rows) {
        const depts = splitDepartments(r.Department);
        if (depts.length === 0) continue;
        const share = r.Approved / depts.length;
        depts.forEach(d => {
            const key = cleanName(d);
            deptSums.set(key, (deptSums.get(key) || 0) + share);
        });
    }
    const items = [...deptSums.entries()]
        .map(([account, value]) => ({ account, value }))
        .sort((a, b) => d3.descending(a.value, b.value));

    if (items.length === 0) {
        alert(`No departments listed for "${budgetName}".`);
        return;
    }

    const rootTotal = d3.sum(items, d => d.value);

    navigateToPie(
        items,
        {
            groupOther: true,               // show a single "Other" in the base view
            rootTotal,
            rootLabel: `${budgetName} total`,
            onSliceClick: (d) => {
                const dept = d.data.account;
                showAccountsPieForDeptBudget(sectionLabel, budgetName, dept);
            }
        },
        {
            titleText: budgetName,
            subheadText: `${sectionLabel} • Departments`
        }
    );
}

function showAccountsPieForDeptBudget(sectionLabel, budgetName, dept) {
    const baseRows =
        sectionLabel === "Revenues" ? revRows :
            sectionLabel === "Expenses" ? expRows : lessRows;

    // Filter to this budget+dept
    const rows = baseRows.filter(r =>
        r.Budget === budgetName &&
        r.Approved > 0 &&
        splitDepartments(r.Department).some(d => cleanName(d) === dept)
    );
    if (rows.length === 0) {
        alert(`No accounts found for ${dept} in "${budgetName}".`);
        return;
    }

    const items = d3.rollups(
        rows,
        v => d3.sum(v, r => r.Approved),
        r => cleanName(r.Account || "(Unlabeled)")
    ).map(([account, value]) => ({ account, value }))
        .sort((a, b) => d3.descending(a.value, b.value));

    const rootTotal = d3.sum(items, d => d.value);

    navigateToPie(
        items,
        {
            groupOther: true,               // show a single "Other" in the base view
            rootTotal,
            rootLabel: `Total for ${dept}`,
            onSliceClick: null
        },
        {
            titleText: dept,
            subheadText: `From budget: ${budgetName}`
        }
    );
}

/* ===== Generic pie ===== */
function renderPie(allItems, {
    groupOther = true,
    onSliceClick = null,
    // keep percentages relative to the original/root pie
    rootTotal = null,
    rootLabel = "Total"
} = {}) {
    pieSvg.selectAll("*").remove();
    pieLegend.selectAll("*").remove();

    const width = Math.min(1100, Math.max(360, window.innerWidth - 24));
    const height = Math.max(420, Math.round(width * 0.8));

    // Set view box
    pieSvg.attr("viewBox", `0 0 ${width} ${height}`);

    const outerR = Math.min(width, height) * 0.40;
    const innerR = Math.round(outerR * 0.55);
    const outerHoverR = Math.round(outerR * 1.06);  // gentle pop
    const cx = width / 2, cy = height / 2 + 6;

    // Apply grouping + name cleanup
    let baseItems = [...allItems].map(d => ({
        account: cleanName(d.account),
        value: d.value,
        __other: d.__other
            ? d.__other.map(x => ({ account: cleanName(x.account), value: x.value }))
            : undefined
    }));
    if (groupOther) {
        baseItems = groupStrictOthers(baseItems);
    }

    // Sort largest → smallest, but keep "Other" (if present) at the end.
    const hadOther = baseItems.some(d => d.account === "Other");
    baseItems.sort((a, b) => d3.descending(a.value, b.value));
    if (hadOther) {
        const idx = baseItems.findIndex(d => d.account === "Other");
        if (idx > -1) {
            const [other] = baseItems.splice(idx, 1);
            baseItems.push(other);
        }
    }

    const localTotal = d3.sum(baseItems, d => d.value) || 1;
    const denom = (rootTotal ?? localTotal); // fixed denominator when provided
    const percentOfRoot = v => (v / denom) * 100;
    const pctVisible = v => v / localTotal;  // returns 0..1

    const color = d3.scaleOrdinal()
        .domain(baseItems.map(d => d.account))
        .range(d3.schemeTableau10.concat(d3.schemeSet3));

    const pieGen = d3.pie().value(d => d.value).sort(null);
    const arcGen = d3.arc().innerRadius(innerR).outerRadius(outerR);
    const arcHover = d3.arc().innerRadius(innerR).outerRadius(outerHoverR);
    const arcOuterLabel = d3.arc().innerRadius(outerR + 14).outerRadius(outerR + 14);
    const arcOnSlice = d3.arc().innerRadius((innerR + outerR) / 2).outerRadius((innerR + outerR) / 2); // mid-band

    // Root group
    const g = pieSvg.append("g").attr("transform", `translate(${cx},${cy})`);

    // === Hatch pattern for "Other" ===
    const defs = pieSvg.append("defs");
    const hatch = defs.append("pattern")
        .attr("id", "otherHatch")
        .attr("patternUnits", "userSpaceOnUse")
        .attr("width", 6).attr("height", 6)
        .attr("patternTransform", "rotate(45)");
    hatch.append("rect").attr("width", 6).attr("height", 6).attr("fill", "#111827"); // dark base
    hatch.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 6)
        .attr("stroke", "#a78bfa").attr("stroke-width", 2); // violet stripes

    const arcs = pieGen(baseItems);
    const arcByAccount = new Map(arcs.map(d => [d.data.account, d]));

    function onSliceActivate(event, d) {
        hideTip && hideTip();

        if (d.data.__other) {
            // Expand "Other" ONCE: render without grouping so no second "Other"
            const expanded = d.data.__other.sort((a, b) => d3.descending(a.value, b.value));
            navigateToPie(
                expanded,
                {
                    groupOther: false,
                    onSliceClick,
                    rootTotal: denom,  // keep denominator fixed
                    rootLabel
                },
                lastPieState?.header
            );
            return;
        }

        if (typeof onSliceClick === "function") {
            onSliceClick(d);
        }
    }


    // ==== Slices (consistent hover; "Other" clickable/keyboard) ====
    const slices = g.selectAll("path.slice").data(arcs).join("path")
        .attr("class", d => "slice" + (d.data.account === "Other" ? " other" : ""))
        .attr("d", arcGen)
        .attr("fill", d => d.data.account === "Other" ? "url(#otherHatch)" : color(d.data.account))
        .attr("tabindex", d => d.data.__other ? 0 : null)
        .on("click", onSliceActivate)
        .on("keydown", (event, d) => {
            if ((event.key === "Enter" || event.key === " ") && d.data.__other) {
                event.preventDefault();
                const expanded = d.data.__other.sort((a, b) => d3.descending(a.value, b.value));
                navigateToPie(
                    expanded,
                    {
                        groupOther: false,
                        onSliceClick,
                        rootTotal: denom,
                        rootLabel
                    },
                    lastPieState?.header
                );
            }
        })
        .on("pointermove", (event, d) => {
            const p = (d.data.value / (rootTotal ?? d3.sum(baseItems, x => x.value))) * 100;
            const hint = d.data.__other ? `<div class="tip-hint">Click to expand</div>` : "";
            // Use pointer coordinates (works for touch + mouse)
            const x = event.pageX ?? (event.touches && event.touches[0]?.pageX) ?? 0;
            const y = event.pageY ?? (event.touches && event.touches[0]?.pageY) ?? 0;
            showTip(`<strong>${d.data.account}</strong><br>${fmt_one_decimal(p)}%${hint}`, x, y);
        })
        .on("pointerenter", function (event, d) {
            // keep the tooltip you added
            const p = (d.data.value / (rootTotal ?? d3.sum(baseItems, x => x.value))) * 100;
            const hint = d.data.__other ? `<div class="tip-hint">Click to expand</div>` : "";
            const x = event.pageX ?? event.clientX ?? 0;
            const y = event.pageY ?? event.clientY ?? 0;
            showTip(`<strong>${d.data.account}</strong><br>${fmt_one_decimal(p)}%${hint}`, x, y);

            // restore the zoom pop
            d3.select(this).interrupt()
                .transition().duration(140)
                .attr("d", arcHover(d));
        })
        .on("pointerleave", function () {
            hideTip();
            d3.select(this).interrupt()
                .transition().duration(160)
                .attr("d", arcGen(d3.select(this).datum()));
        });

    // Accessibility title uses the root denominator too
    slices.append("title")
        .text(d => `${d.data.account}\n${fmt_one_decimal(percentOfRoot(d.data.value))}%`);

    // === Labeling rules ===
    // Show labels if slice ≥7% OR among top 8 by value
    const ranked = [...arcs].sort((a, b) => d3.descending(a.data.value, b.data.value));
    const cutoffVal = ranked[Math.min(7, ranked.length - 1)]?.data?.value ?? Infinity;
    const labelArcs = arcs.filter(a => pctVisible(a.data.value) >= 0.07 || a.data.value >= cutoffVal);

    // Base ON-SLICE vs LEADER for label
    const bigArcs = labelArcs.filter(a => pctVisible(a.data.value) >= THRESHOLD_FOR_LEADER);
    const smallArcs = labelArcs.filter(a => pctVisible(a.data.value) < THRESHOLD_FOR_LEADER);

    const labelG = g.append("g");

    // ---------- SMALL LABELS: keep on-screen ----------
    const labelMargin = 8;
    const colW = Math.min(220, Math.max(window.innerWidth < 420 ? 108 : 120, width * 0.32));
    const leftColX = - (width / 2) + labelMargin + colW / 2;
    const rightColX = (width / 2) - labelMargin - colW / 2;
    const topLimit = - (height / 2) + labelMargin;
    const botLimit = (height / 2) - labelMargin;

    // Build positioning targets for small labels
    const smallTargets = smallArcs.map(d => {
        const [cx0, cy0] = arcOuterLabel.centroid(d);
        const rightSide = cx0 >= 0;
        return {
            d,
            side: rightSide ? "R" : "L",
            x: rightSide ? rightColX : leftColX,
            y: cy0,
            height: 30 // temp, will be measured precisely after render
        };
    });

    // Split left/right (we'll resolve after measuring)
    const leftNodes = smallTargets.filter(n => n.side === "L");
    const rightNodes = smallTargets.filter(n => n.side === "R");

    // Leader lines from slice -> elbow -> label edge (first pass; will update later)
    const leaders = labelG.selectAll("path.leader").data(smallTargets).join("path")
        .attr("class", "leader")
        .attr("d", n => {
            const p = arcOuterLabel.centroid(n.d);
            const mid = [p[0] * 0.88, p[1] * 0.88];
            const edgeX = n.side === "R" ? (n.x - colW / 2) : (n.x + colW / 2);
            const end = [edgeX, n.y];
            return d3.line().curve(d3.curveBasis)([arcGen.centroid(n.d), mid, end]);
        });

    // External small labels, clamped inside columns
    const smallLabels = labelG.selectAll("g.label-small").data(smallTargets).join("g")
        .attr("class", "label label-small")
        .attr("transform", n => `translate(${n.x},${n.y})`);

    // Background pill to improve contrast
    smallLabels.append("rect")
        .attr("class", "label-box")
        .attr("x", -colW / 2)
        .attr("y", -16)
        .attr("rx", 8).attr("ry", 8)
        .attr("width", colW)
        .attr("height", 34);

    // Title (wrap to column width)
    const tTitle = smallLabels.append("text")
        .attr("class", "label-t")
        .attr("text-anchor", "middle")
        .text(n => n.d.data.account)
        .call(wrapText, colW - 14);

    // Value line (always second block)
    const tVal = smallLabels.append("text")
        .attr("class", "label-v")
        .attr("text-anchor", "middle")
        .attr("dy", "1.4em")
        .text(n => fmt_dollars(n.d.data.value));

    // Resize pill height to fit wrapped tspans and MEASURE true heights
    smallLabels.each(function (n) {
        const g = d3.select(this);
        const box = g.select("rect.label-box");
        const title = g.select("text.label-t");
        const tspans = title.selectAll("tspan").nodes();
        const lineCt = Math.max(1, tspans.length);
        const h = 8 + (lineCt * 16 * 1.15) + 18 + 8; // padding + lines + value + padding
        g.select("text.label-v").attr("dy", `${(lineCt * 1.15) + 0.6}em`);
        box.attr("height", h).attr("y", -h / 2);
        title.attr("dy", `${-(lineCt - 1) * 0.575}em`);

        // precise measurement (accounts for font metrics)
        const bbox = box.node().getBBox();
        n.height = bbox.height || h;
    });

    // Resolve overlaps per column using real heights
    resolveOverlaps(leftNodes, topLimit, botLimit, 8);
    resolveOverlaps(rightNodes, topLimit, botLimit, 8);

    // Apply final positions
    smallLabels.attr("transform", n => `translate(${n.x},${n.y})`);

    // Redraw leaders with final label Y
    leaders.attr("d", n => {
        const p = arcOuterLabel.centroid(n.d);
        const mid = [p[0] * 0.88, p[1] * 0.88];
        const edgeX = n.side === "R" ? (n.x - colW / 2) : (n.x + colW / 2);
        const end = [edgeX, n.y];
        return d3.line().curve(d3.curveBasis)([arcGen.centroid(n.d), mid, end]);
    });

    // ---------- BIG LABELS: on-slice centered, no leaders ----------
    const bigLabels = labelG.selectAll("g.label-big").data(bigArcs).join("g")
        .attr("class", "label label-big on-slice")
        .attr("transform", d => {
            const [x, y] = arcOnSlice.centroid(d);
            return `translate(${x},${y})`;
        });
    bigLabels.append("text")
        .attr("class", "label-t on-slice-text")
        .attr("text-anchor", "middle")
        .text(d => d.data.account);
    bigLabels.append("text")
        .attr("class", "label-v on-slice-text")
        .attr("text-anchor", "middle")
        .attr("dy", "1.15em")
        .text(d => fmt_dollars(d.data.value));

    // Legend (first 10 after grouping) — show name + dollars; flag "Other"
    // Legend (top 10 after grouping) — clickable; largest → smallest; "Other" flagged
    baseItems.slice(0, 100).forEach(it => {
        const isOther = it.account === "Other";
        const d = arcByAccount.get(it.account); // corresponding arc datum

        const badge = pieLegend.append("div")
            .attr("class", "badge" + (isOther ? " other" : ""))
            .attr("role", "button")
            .attr("tabindex", 0)
            .attr("aria-label", `${it.account} ${fmt_dollars(it.value)} — ${isOther ? "expand" : "view segment"}`);

        const swatchStyle = isOther
            ? "background:repeating-linear-gradient(45deg,#111827 0 6px,#a78bfa 6px 8px);"
            : `background:${color(it.account)};`;

        badge.html(`
    <span class="swatch" style="${swatchStyle}"></span>
    <div class="btxt">
      <div class="btitle">${it.account}${isOther ? ' <span class="badge-hint">(expand)</span>' : ''}</div>
      <div class="bval">${fmt_dollars(it.value)}</div>
    </div>
  `);

        // Activate (click/tap)
        badge.on("click", (event) => {
            if (!d) return;
            event.preventDefault();
            event.stopPropagation();
            onSliceActivate(event, d);
        });

        // Keyboard accessibility: Enter/Space
        badge.on("keydown", (event) => {
            const k = event.code || event.key;
            if (k === "Enter" || k === "Space" || k === " ") {
                if (!d) return;
                event.preventDefault();
                event.stopPropagation();
                onSliceActivate(event, d);
            }
        });
    });


    // === Center total (fixed to root) ===
    const center = g.append("g").attr("class", "pie-center");
    center.append("text")
        .attr("class", "pie-center-value")
        .attr("text-anchor", "middle")
        .attr("dy", "-0.15em")
        .text(fmt_dollars(denom));
    center.append("text")
        .attr("class", "pie-center-label")
        .attr("text-anchor", "middle")
        .attr("dy", "1.1em")
        .text(rootLabel || "Total");

    // Save state for responsive re-render
    lastPieState = { allItems, opts: { groupOther, onSliceClick, rootTotal: denom, rootLabel }, header: lastPieState?.header };
}
