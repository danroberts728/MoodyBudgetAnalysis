/* Moody Budget • Sankey → Pie (TSV, phone-first)
 * Features:
 *  - Two-stage Sankey: Revenue Budgets → [Total Revenues] → Expense Budgets (+ Remainder/Shortfall)
 *  - Expense Budget nodes clickable if they span multiple Departments
 *  - Revenue Budget nodes clickable if they contain multiple Accounts
 *  - Pie charts (for both sides) support "Other (<5%)" grouping and drill-down
 */

const TSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRRtJHPNjRvv_DT0suQ4u-Z4yHKa-cwkkACS-l_QmJrPm7uuAnTUmN7xdwISa7iAEJfuuVrTEjY1xkV/pub?gid=0&single=true&output=tsv";

// DOM
const sankeySvg = d3.select("#sankeySvg");
const sankeyLegend = d3.select("#sankeyLegend");
const pieSvg = d3.select("#pieSvg");
const pieLegend = d3.select("#pieLegend");
const pieTitle = d3.select("#pieTitle");
const pieSubhead = d3.select("#pieSubhead");
const sankeyView = d3.select("#sankeyView");
const pieView = d3.select("#pieView");
const backBtn = d3.select("#backBtn");
const chooser = d3.select("#chooser");
const chooserList = d3.select("#chooserList");
const chooserClose = d3.select("#chooserClose");

function setViewBox(svg, w, h){ svg.attr("viewBox", `0 0 ${w} ${h}`); }
const fmt0 = d3.format(",.0f");
const dollars = x => `$${fmt0(x)}`;

const revScale = d3.scaleOrdinal().range(d3.schemeTableau10);
const expScale = d3.scaleOrdinal().range(d3.schemeSet3);

// State
let rawRows = [];
let revenueByBudget = new Map();
let expenseByBudget = new Map();
let budgetToDepartments = new Map();
let departmentToAccounts = new Map();
let revenueToAccounts = new Map();
let sankeyData = null;

init();

/* ===================== Init ===================== */
async function init(){
  try{
    const rawTsv = await fetch(TSV_URL).then(r => r.text());
    const parsed = d3.tsvParse(rawTsv);

    // Adjust to your exact TSV header strings
    const TYPE_COL     = "TYPE";
    const BUDGET_COL   = "BUDGET";
    const DEPT_COL     = "DEPARTMENT";
    const ACCT_COL     = "Account Title";
    const APPROVED_COL = "2025-2026 Approved";

    const money = s => {
      const v = +String(s ?? "").replace(/[^0-9.-]/g,"");
      return Number.isFinite(v) ? v : 0;
    };

    rawRows = parsed.map(d => ({
      Type: (d[TYPE_COL] ?? "").trim(),
      Budget: (d[BUDGET_COL] ?? "").trim(),
      Department: (d[DEPT_COL] ?? "").trim(),
      Account: (d[ACCT_COL] ?? "").trim(),
      Approved: money(d[APPROVED_COL])
    }));

    const isRev = v => v.toLowerCase() === "revenue";
    const isExp = v => v.toLowerCase() === "expense";

    const revRows = rawRows.filter(r => isRev(r.Type) && r.Budget && r.Approved > 0);
    const expRows = rawRows.filter(r => isExp(r.Type) && r.Budget && r.Approved > 0);

    revenueByBudget = d3.rollup(revRows, v => d3.sum(v, d => d.Approved), d => d.Budget);
    expenseByBudget = d3.rollup(expRows, v => d3.sum(v, d => d.Approved), d => d.Budget);

    budgetToDepartments = new Map(
      d3.rollups(expRows, v => new Set(v.flatMap(r => splitDepartments(r.Department)).filter(Boolean)), r => r.Budget)
    );

    departmentToAccounts = buildDepartmentAccounts(expRows);
    revenueToAccounts = buildRevenueAccounts(revRows);

    sankeyData = buildSankey(revenueByBudget, expenseByBudget);
    renderSankey(sankeyData);

    backBtn.on("click", () => {
      pieView.classed("hidden", true);
      sankeyView.classed("hidden", false);
      backBtn.classed("hidden", true);
    });
    chooserClose.on("click", () => chooser.classed("hidden", true));
  }catch(err){
    console.error(err);
    alert(`Problem: ${err.message}`);
  }
}

/* ===================== Helpers ===================== */
function splitDepartments(cell){
  if(!cell) return [];
  return cell.split(/[;,]/).map(s=>s.trim()).filter(Boolean);
}
function buildDepartmentAccounts(expRows){
  const finalMap = new Map();
  for(const row of expRows){
    for(const dept of splitDepartments(row.Department)){
      if(!dept) continue;
      if(!finalMap.has(dept)) finalMap.set(dept, []);
      finalMap.get(dept).push(row);
    }
  }
  for(const [dept, rows] of finalMap){
    const items = d3.rollups(rows, v => d3.sum(v, r => r.Approved), r => r.Account||"(Unlabeled)")
      .map(([account,value]) => ({account,value}))
      .sort((a,b)=>d3.descending(a.value,b.value));
    finalMap.set(dept, items);
  }
  return finalMap;
}
function buildRevenueAccounts(revRows){
  return new Map(
    d3.rollups(revRows, v => {
      const grouped = d3.rollups(v, g => d3.sum(g, r => r.Approved), r => r.Account||"(Unlabeled)")
        .map(([account,value]) => ({account,value}));
      return grouped.sort((a,b)=>d3.descending(a.value,b.value));
    }, r => r.Budget)
  );
}

/* ===================== Sankey ===================== */
function buildSankey(revMap, expMap){
  const revenues = [...revMap.entries()].map(([n,v])=>({name:n,value:+v||0}));
  const expenses = [...expMap.entries()].map(([n,v])=>({name:n,value:+v||0}));

  const totalRevenue = d3.sum(revenues,d=>d.value);
  const totalExpenses = d3.sum(expenses,d=>d.value);
  const remainderVal = totalRevenue - totalExpenses;

  const midName = "Total Revenues";
  const specialNodeName = remainderVal>=0 ? "Remainder" : "Shortfall";
  const specialValue = Math.abs(remainderVal);

  const nodes=[], nameToIdx=new Map();
  const addNode=(n,k)=>{if(!nameToIdx.has(n)){nameToIdx.set(n,nodes.length);nodes.push({name:n,kind:k});}return nameToIdx.get(n);};

  revenues.forEach(r=>addNode(r.name,"rev"));
  addNode(midName,"mid");
  expenses.forEach(e=>addNode(e.name,"exp"));
  if(specialValue>0) addNode(specialNodeName,"bal");

  const links=[];
  const midIdx=nameToIdx.get(midName);
  revenues.forEach(r=>links.push({source:nameToIdx.get(r.name),target:midIdx,value:r.value}));
  expenses.forEach(e=>links.push({source:midIdx,target:nameToIdx.get(e.name),value:e.value}));
  if(specialValue>0) links.push({source:midIdx,target:nameToIdx.get(specialNodeName),value:specialValue});

  return {nodes,links,totals:{totalRevenue,totalExpenses,specialNodeName,specialValue}};
}

function renderSankey(graph){
  sankeySvg.selectAll("*").remove(); sankeyLegend.selectAll("*").remove();
  const width=Math.min(1100,Math.max(360,window.innerWidth-24));
  const height=Math.max(420,Math.round(width*0.62));
  setViewBox(sankeySvg,width,height);

  const sankey=d3.sankey().nodeWidth(Math.max(12,Math.round(width*0.02))).nodePadding(14).nodeAlign(d3.sankeyLeft).extent([[8,8],[width-8,height-8]]);
  const {nodes,links}=sankey({nodes:graph.nodes.map(d=>({...d})),links:graph.links.map(d=>({...d}))});
  const nodeColor = d =>
    d.kind === "rev" ? revScale(d.name) :
    d.kind === "exp" ? expScale(d.name) :
    "#7b8ba3";

  // links
  sankeySvg.append("g")
  .attr("fill","none")
  .selectAll("path")
  .data(links)
  .join("path")
      .attr("class","link")
      .attr("d", d3.sankeyLinkHorizontal())
      // 👇 use the node object, not an index
      .attr("stroke", d => d3.color(nodeColor(d.source || {})).formatHex())
      .attr("stroke-width", d => Math.max(1, d.width));


const gNode = sankeySvg.append("g")
  .selectAll("g")
  .data(nodes)
  .join("g")
    .attr("class", d => {
      if (d.kind === "exp") {
        const set = budgetToDepartments.get(d.name);
        if (set && set.size >= 2) return "node clickable";
      }
      if (d.kind === "rev") {
        const acc = revenueToAccounts.get(d.name);
        if (acc && acc.length > 1) return "node clickable";
      }
      return "node";
    })
    // SAFETY: default NaN to 0 so transform is always valid
    .attr("transform", d => `translate(${Number.isFinite(d.x0)?d.x0:0},${Number.isFinite(d.y0)?d.y0:0})`)
    .on("click", (event, d) => onNodeClick(d));

const nodeWidth  = d => {
  const w = (Number.isFinite(d.x1) && Number.isFinite(d.x0)) ? (d.x1 - d.x0) : NaN;
  return Number.isFinite(w) ? Math.max(10, w) : 10;
};
const nodeHeight = d => {
  const h = (Number.isFinite(d.y1) && Number.isFinite(d.y0)) ? (d.y1 - d.y0) : NaN;
  return Number.isFinite(h) ? Math.max(2, h) : 2;
};
const isLeft = d => Number.isFinite(d.x0) ? (d.x0 < width/2) : true;
const safeValue = v => Number.isFinite(v) ? v : 0;

gNode.append("rect")
  .attr("height", d => nodeHeight(d))
  .attr("width",  d => nodeWidth(d))
  .attr("fill", nodeColor)
  .append("title")
  .text(d => `${d.name}\n${dollars(safeValue(d.value))}`);

// >>> THIS IS THE PART THAT WAS THROWING: now fully guarded <<<
gNode.append("text")
  .attr("x", d => isLeft(d) ? nodeWidth(d) + 8 : -8)
  .attr("y", d => nodeHeight(d) / 2)
  .attr("dy", "0.35em")
  .attr("text-anchor", d => isLeft(d) ? "start" : "end")
  .text(d => `${d.name} — ${dollars(safeValue(d.value))}`);


  sankeyLegend.append("div").attr("class","badge")
    .html(`<span class="swatch" style="background:${revScale("rev")};"></span>Revenue`);
  sankeyLegend.append("div").attr("class","badge")
    .html(`<span class="swatch" style="background:${expScale("exp")};"></span>Expense`);
  if(graph.totals.specialValue>0) sankeyLegend.append("div").attr("class","badge")
    .html(`<span class="swatch" style="background:#7b8ba3;"></span>${graph.totals.specialNodeName}`);
}

function onNodeClick(node){
  if(node.kind==="exp"){
    const deptSet=budgetToDepartments.get(node.name);
    if(!deptSet||deptSet.size<2)return;
    chooserList.selectAll("*").remove();
    [...deptSet].sort(d3.ascending).forEach(dept=>{
      chooserList.append("li").append("button").text(dept).on("click",()=>{
        chooser.classed("hidden",true);showPie(`Dept: ${dept}`, departmentToAccounts.get(dept), node.name);
      });
    });
    chooser.classed("hidden",false);
    return;
  }
  if(node.kind==="rev"){
    const accounts=revenueToAccounts.get(node.name);
    if(!accounts||accounts.length<=1)return;
    showPie(node.name, accounts, "Revenue Accounts");
  }
}

/* ===================== Pie ===================== */
function showPie(title, items, subtitle){
  sankeyView.classed("hidden",true); pieView.classed("hidden",false); backBtn.classed("hidden",false);
  pieTitle.text(title); pieSubhead.text(subtitle||"");
  renderPie(items);
}

function renderPie(allItems){
  pieSvg.selectAll("*").remove(); pieLegend.selectAll("*").remove();
  const width=Math.min(1100,Math.max(360,window.innerWidth-24));
  const height=Math.max(420,Math.round(width*0.8));
  setViewBox(pieSvg,width,height);
  const outerR=Math.min(width,height)*0.40;const innerR=Math.round(outerR*0.55);
  const cx=width/2, cy=height/2+6;
  const total=d3.sum(allItems,d=>d.value)||1;
  const pct=v=>(v/total)*100;
  const sorted=[...allItems].sort((a,b)=>d3.ascending(a.value,b.value));

  let baseItems=[...allItems];
  if(sorted.length>=3){
    const smalls=[];let i=0;
    while(i<sorted.length&&pct(sorted[i].value)<5){smalls.push(sorted[i]);i++;}
    if(smalls.length>=2){
      const otherValue=d3.sum(smalls,d=>d.value);
      const remaining=allItems.filter(d=>!smalls.includes(d));
      baseItems=[...remaining,{account:"Other",value:otherValue,__other:smalls}];
    }
  }

  const color=d3.scaleOrdinal().domain(baseItems.map(d=>d.account)).range(d3.schemeTableau10.concat(d3.schemeSet3));
  const pieGen=d3.pie().value(d=>d.value).sort(null);
  const arcGen=d3.arc().innerRadius(innerR).outerRadius(outerR);
  const arcLabel=d3.arc().innerRadius(outerR+14).outerRadius(outerR+14);

  const g=pieSvg.append("g").attr("transform",`translate(${cx},${cy})`);
  const arcs=pieGen(baseItems);

  g.selectAll("path").data(arcs).join("path")
    .attr("class",d=>"slice"+(d.data.account==="Other"?" other":""))
    .attr("d",arcGen).attr("fill",d=>color(d.data.account))
    .append("title").text(d=>`${d.data.account}\n${dollars(d.data.value)} (${(d.data.value/total*100).toFixed(1)}%)`);

  const labelG=g.append("g");
  labelG.selectAll("path.leader").data(arcs).join("path").attr("class","leader").attr("d",d=>{
    const p=arcLabel.centroid(d);const mid=[p[0]*0.88,p[1]*0.88];
    const endX=(p[0]>0?1:-1)*(outerR+52);const end=[endX,p[1]];
    return d3.line().curve(d3.curveBasis)([arcGen.centroid(d),mid,end]);
  });
  const labels=labelG.selectAll("g.label").data(arcs).join("g").attr("class","label").attr("transform",d=>{
    const p=arcLabel.centroid(d);const endX=(p[0]>0?1:-1)*(outerR+56);return `translate(${endX},${p[1]})`;
  });
  labels.append("text").attr("class","label-t").attr("text-anchor",d=>arcLabel.centroid(d)[0]>0?"start":"end").text(d=>d.data.account);
  labels.append("text").attr("class","label-v").attr("dy","1.15em").attr("text-anchor",d=>arcLabel.centroid(d)[0]>0?"start":"end").text(d=>dollars(d.data.value));

  pieSvg.selectAll(".slice.other").on("click",(e,d)=>{if(d.data.__other){renderPie(d.data.__other.sort((a,b)=>d3.descending(a.value,b.value)));}});
  baseItems.slice(0,10).forEach(it=>{pieLegend.append("div").attr("class","badge").html(`<span class="swatch" style="background:${color(it.account)};"></span>${it.account}`);});
}
