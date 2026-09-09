import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || "/data/parlay.json";
const CRAWL_MS = 5 * 60 * 1000;
const UA = "ParlayScannerBot/0.2 (+personal research crawler)";

const sources = [
  {
    id: "openfootball-epl",
    name: "OpenFootball England",
    sport: "Soccer",
    url: "https://raw.githubusercontent.com/openfootball/football.json/master/2025-26/en.1.json",
    kind: "openfootball-json",
    weight: 0.85,
    enabled: true
  }
];

function ensureDir(file) {
  const d = path.dirname(file);
  if (d && d !== ".") fs.mkdirSync(d, { recursive: true });
}
ensureDir(DB_PATH);

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch { return { observations: [], lastCrawl: null, runs: [] }; }
}
function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function slug(s="") {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
}
function eventKey(e) {
  return [e.sport||"unknown",slug(e.home),slug(e.away||e.title),String(e.start_time||"").slice(0,10)].join("|");
}
async function robotsAllowed(url) {
  try {
    const u = new URL(url);
    const robots = `${u.protocol}//${u.host}/robots.txt`;
    const r = await fetch(robots,{headers:{"user-agent":UA}});
    if (!r.ok) return true;
    const txt = (await r.text()).toLowerCase();
    const blocks = txt.split(/user-agent\s*:/);
    for (const b of blocks) {
      if (b.startsWith("*")) {
        const disallows = [...b.matchAll(/disallow\s*:\s*([^\n\r]*)/g)].map(m=>m[1].trim());
        const p = u.pathname;
        if (disallows.some(x => x && x !== "/" && p.startsWith(x))) return false;
        if (disallows.includes("/")) return false;
      }
    }
    return true;
  } catch { return false; }
}
function normalizeOpenFootball(json, source) {
  const matches = Array.isArray(json.matches) ? json.matches : [];
  return matches.map(m => {
    const home = m.team1 || m.home || "";
    const away = m.team2 || m.away || "";
    const d = m.date || "";
    const t = m.time || "00:00";
    let start_time = null;
    if (d) {
      const dt = new Date(`${d}T${t}:00Z`);
      if (!Number.isNaN(dt.getTime())) start_time = dt.toISOString();
    }
    const e = {
      source_id: source.id,
      source_name: source.name,
      sport: source.sport,
      home, away,
      title: `${home} vs ${away}`,
      start_time,
      venue: "",
      location: "",
      source_weight: source.weight,
      fetched_at: new Date().toISOString()
    };
    e.event_key = eventKey(e);
    return e;
  });
}
async function crawlSource(source) {
  if (!source.enabled) return {source:source.id,ok:false,reason:"disabled"};
  if (!(await robotsAllowed(source.url))) return {source:source.id,ok:false,reason:"robots-denied"};
  const res = await fetch(source.url,{headers:{"user-agent":UA},redirect:"follow"});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (source.kind === "openfootball-json") {
    const json = await res.json();
    return {source:source.id,ok:true,events:normalizeOpenFootball(json,source)};
  }
  return {source:source.id,ok:false,reason:"unsupported-kind"};
}
async function runCrawl() {
  const db = loadDb();
  const run = {started_at:new Date().toISOString(),results:[]};
  for (const source of sources) {
    try {
      const r = await crawlSource(source);
      if (r.ok && r.events) {
        for (const e of r.events) db.observations.push(e);
        r.count = r.events.length;
        delete r.events;
      }
      run.results.push(r);
    } catch (err) {
      run.results.push({source:source.id,ok:false,reason:String(err.message||err)});
    }
  }
  const cutoff = Date.now() - 45*24*60*60*1000;
  db.observations = db.observations.filter(o => {
    const ts = Date.parse(o.fetched_at||0);
    return Number.isFinite(ts) && ts >= cutoff;
  }).slice(-50000);
  db.lastCrawl = new Date().toISOString();
  run.finished_at = db.lastCrawl;
  db.runs = [...(db.runs||[]).slice(-99),run];
  saveDb(db);
  console.log(JSON.stringify({type:"crawl",...run}));
}
function consensus() {
  const db = loadDb();
  const latest = new Map();
  for (const o of db.observations) {
    const prev = latest.get(o.event_key);
    if (!prev || String(o.fetched_at)>String(prev.fetched_at)) latest.set(o.event_key,o);
  }
  const now = Date.now();
  const events = [...latest.values()]
    .filter(e => {
      const s = Date.parse(e.start_time||0);
      return Number.isFinite(s) && s >= now - 6*60*60*1000;
    })
    .sort((a,b)=>String(a.start_time).localeCompare(String(b.start_time)))
    .slice(0,1000)
    .map(e=>({...e,data_confidence:Math.round((e.source_weight||0.5)*100),status:"single-source"}));
  return {events,lastCrawl:db.lastCrawl};
}
function json(res,status,obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status,{"content-type":"application/json","access-control-allow-origin":"*","cache-control":"no-store"});
  res.end(body);
}
const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url,`http://${req.headers.host||"localhost"}`);
  if (url.pathname==="/api/health") {
    const db=loadDb();
    return json(res,200,{ok:true,service:"parlay-crawler",version:"0.2",now:new Date().toISOString(),lastCrawl:db.lastCrawl,sources:sources.filter(s=>s.enabled).length});
  }
  if (url.pathname==="/api/events") return json(res,200,consensus());
  if (url.pathname==="/api/sources") return json(res,200,{sources:sources.map(({url,...s})=>s)});
  if (url.pathname==="/api/crawl" && req.method==="POST") {
    await runCrawl();
    return json(res,200,{ok:true,lastCrawl:loadDb().lastCrawl});
  }
  return json(res,404,{error:"not found"});
});
server.listen(PORT,"0.0.0.0",async ()=>{
  console.log(`parlay crawler listening on ${PORT}`);
  try { await runCrawl(); } catch(e) { console.error(e); }
});
setInterval(()=>runCrawl().catch(console.error),CRAWL_MS);
