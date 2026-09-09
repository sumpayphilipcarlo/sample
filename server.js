import express from 'express';
import * as cheerio from 'cheerio';

const app = express();
const port = process.env.PORT || 3000;
app.use(express.static('public'));

const UA = 'Mozilla/5.0 (compatible; MemeCoinRiskScanner/1.1; +https://example.invalid/bot)';
const TIMEOUT = 10000;
const MAX_CONCURRENCY = 5;
const MAX_CATALOG_PAGES = 25;
const history = new Map();
let cache = { ts: 0, data: null };

const sources = [
  { name: 'DexScreener', url: 'https://dexscreener.com/', type: 'market' },
  { name: 'GeckoTerminal', url: 'https://www.geckoterminal.com/', type: 'market' },
  { name: 'CoinMarketCap Memes', url: 'https://coinmarketcap.com/view/memes/', type: 'market' },
  { name: 'Etherscan Tokens', url: 'https://etherscan.io/tokens', type: 'explorer' },
  { name: 'Solscan Tokens', url: 'https://solscan.io/tokens', type: 'explorer' },
  { name: 'BscScan Tokens', url: 'https://bscscan.com/tokens', type: 'explorer' },
  { name: 'Google News Crypto', url: 'https://news.google.com/rss/search?q=memecoin%20OR%20meme%20coin%20crypto&hl=en-US&gl=US&ceid=US:en', type: 'news' },
  { name: 'Reddit CryptoCurrency', url: 'https://www.reddit.com/r/CryptoCurrency/', type: 'social' },
  { name: 'Reddit Memecoins', url: 'https://www.reddit.com/r/memecoins/', type: 'social' }
];

const fallbackKnown = [
  ['DOGE','Dogecoin'],['SHIB','Shiba Inu'],['PEPE','Pepe'],['BONK','Bonk'],['WIF','dogwifhat'],
  ['FLOKI','FLOKI'],['BRETT','Brett'],['MOG','Mog Coin'],['POPCAT','Popcat'],['TURBO','Turbo']
];

const suspiciousTerms = ['guaranteed profit','100x guaranteed','risk free','send funds','presale ending','double your','airdrop claim','wallet validation','connect wallet now','urgent claim','locked liquidity forever','cannot lose'];
const bullishTerms = ['listing','partnership','burn','volume surge','all time high','breakout','accumulation','whale buy','open interest'];
const bearishTerms = ['rug pull','rugpull','honeypot','exploit','hack','mint function','blacklist','liquidity removed','developer sold','insider dump','scam'];

function timeoutFetch(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT);
  return fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }, signal: controller.signal, redirect: 'follow' }).finally(() => clearTimeout(id));
}

async function fetchText(src) {
  try {
    const r = await timeoutFetch(src.url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    return { ...src, ok: true, text: text.slice(0, 1800000), status: r.status };
  } catch (e) {
    return { ...src, ok: false, text: '', error: String(e.message || e) };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  async function worker(){ while(i < items.length){ const j = i++; out[j] = await fn(items[j]); }}
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}

function cleanText(html) {
  const $ = cheerio.load(html || '');
  $('script,style,noscript,svg').remove();
  return $('body').text().replace(/\s+/g,' ').trim();
}

function extractNews(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('item').slice(0,80).each((_, el) => items.push({ title: $(el).find('title').text(), link: $(el).find('link').text(), published: $(el).find('pubDate').text() }));
  return items;
}

function catalogPageCount(html) {
  const $ = cheerio.load(html || '');
  let max = 1;
  $('a[href*="page="]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/[?&]page=(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return Math.min(MAX_CATALOG_PAGES, Math.max(1, max));
}

async function fetchCoinGeckoCatalog() {
  const firstSrc = { name:'CoinGecko Meme 1', url:'https://www.coingecko.com/en/categories/meme-token?items=300&page=1', type:'catalog' };
  const first = await fetchText(firstSrc);
  if (!first.ok) return [first];
  const totalPages = catalogPageCount(first.text);
  const rest = [];
  for (let page=2; page<=totalPages; page++) rest.push({ name:`CoinGecko Meme ${page}`, url:`https://www.coingecko.com/en/categories/meme-token?items=300&page=${page}`, type:'catalog' });
  return [first, ...(await mapLimit(rest, MAX_CONCURRENCY, fetchText))];
}

function parseCatalogTokens(catalogPages) {
  const found = new Map();
  for (const p of catalogPages) {
    if (!p.ok) continue;
    const $ = cheerio.load(p.text || '');
    $('table tbody tr').each((_, tr) => {
      const link = $(tr).find('a[href*="/en/coins/"]').first();
      if (!link.length) return;
      const href = link.attr('href') || '';
      const slugMatch = href.match(/\/en\/coins\/([^/?#]+)/);
      if (!slugMatch) return;
      const slug = slugMatch[1].toLowerCase();
      let cell = link.closest('td').text().replace(/\s+/g,' ').trim().replace(/\bBuy\b/gi,'').trim();
      if (!cell) cell = link.text().replace(/\s+/g,' ').trim();
      const parts = cell.split(' ').filter(Boolean);
      let symbol = '';
      for (let i=parts.length-1;i>=0;i--) {
        const x = parts[i].replace(/^\$+/,'');
        if (/^[A-Za-z0-9._-]{1,20}$/.test(x) && /[A-Za-z]/.test(x)) { symbol = x.toUpperCase(); parts.splice(i,1); break; }
      }
      const name = parts.join(' ').trim() || slug.replace(/-/g,' ');
      if (!symbol || symbol.length > 20) return;
      const key = `cg:${slug}`;
      if (!found.has(key)) found.set(key,{ id:key, slug, symbol, name, mentions:0, catalog:true });
    });
  }
  return found;
}

function discoverTokens(pages, catalogPages) {
  const found = parseCatalogTokens(catalogPages);
  for (const [s,n] of fallbackKnown) {
    if (![...found.values()].some(x=>x.symbol===s)) found.set(`seed:${s}`,{id:`seed:${s}`,symbol:s,name:n,mentions:0,catalog:false});
  }
  const bySymbol = new Map();
  for (const t of found.values()) if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, t);
  const tokenRegex = /\$([A-Z][A-Z0-9]{1,14})\b/g;
  for(const p of pages){
    if(!p.ok) continue;
    const txt = cleanText(p.text).toUpperCase();
    for(const t of found.values()){
      if (t.symbol.length < 2) continue;
      const count = (txt.match(new RegExp(`\\b${t.symbol.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'g'))||[]).length;
      if(count) t.mentions += Math.min(count,20);
    }
    for(const m of txt.matchAll(tokenRegex)){
      const s=m[1];
      let t=bySymbol.get(s);
      if(!t){ t={id:`mention:${s}`,symbol:s,name:s,mentions:0,catalog:false}; found.set(t.id,t); bySymbol.set(s,t); }
      t.mentions++;
    }
  }
  return [...found.values()];
}

function termCount(text, terms){ const t=text.toLowerCase(); return terms.reduce((n,x)=>n+(t.includes(x)?1:0),0); }

function scoreToken(token, pages, newsItems) {
  const corpus = pages.filter(p=>p.ok).map(p=>({name:p.name,type:p.type,text:cleanText(p.text)}));
  const sym = token.symbol.toLowerCase(), name = token.name.toLowerCase();
  const relevant = corpus.filter(x => (sym.length>1 && x.text.toLowerCase().includes(sym)) || (name.length>3 && x.text.toLowerCase().includes(name)));
  const news = newsItems.filter(n => (n.title||'').toLowerCase().includes(sym) || (name.length>3 && (n.title||'').toLowerCase().includes(name)));
  const text = [...relevant.map(x=>x.text.slice(0,18000)), ...news.map(n=>n.title)].join(' ');
  const bullish = termCount(text,bullishTerms), bearish = termCount(text,bearishTerms), suspicious = termCount(text,suspiciousTerms);
  const independentSources = new Set(relevant.map(x=>x.name)).size + Math.min(news.length,3);
  const marketPresence = relevant.some(x=>x.type==='market'), explorerPresence = relevant.some(x=>x.type==='explorer'), socialPresence = relevant.some(x=>x.type==='social');
  const mentionScore = Math.min(20, token.mentions * 2);
  let opportunity = 35 + mentionScore + bullish*5 - bearish*12 - suspicious*15 + (marketPresence?8:0) + (explorerPresence?5:0) + (socialPresence?3:0);
  opportunity = Math.max(0,Math.min(100,opportunity));
  let rugRisk = 10 + bearish*18 + suspicious*22 + (!explorerPresence?12:0) + (independentSources<2?10:0);
  rugRisk = Math.max(0,Math.min(100,rugRisk));
  const hkey = token.id || token.symbol;
  const prev = history.get(hkey) || [];
  prev.push({t:Date.now(), mentions:token.mentions, opportunity, rugRisk}); while(prev.length>40) prev.shift(); history.set(hkey, prev);
  const older = prev.length > 1 ? prev[Math.max(0,prev.length-6)] : prev[0];
  const momentum = older ? token.mentions - older.mentions : 0;
  let action='WATCH'; if(rugRisk>=55) action='AVOID'; else if(opportunity>=78&&independentSources>=3) action='BUY CANDIDATE'; else if(opportunity<35) action='AVOID';
  const evidenceQuality = Math.min(100, independentSources*15 + (marketPresence?15:0) + (explorerPresence?15:0) + (news.length?10:0));
  const confidence = Math.round(Math.min(92,Math.max(20,0.55*evidenceQuality+0.45*Math.abs(opportunity-50)*2)));
  const hold = action==='BUY CANDIDATE' ? (rugRisk<25&&momentum>=0?'Hold while score stays ≥70; re-check every scan.':'Short hold only; reassess at the next scan.') : 'No entry recommended.';
  const exit = action==='BUY CANDIDATE' ? 'Scale out if score drops below 65, rug risk rises above 35, or momentum reverses for 2 scans. Consider partial profit at +20–30% and trail the rest.' : 'N/A';
  return {...token,opportunity,rugRisk,confidence,action,momentum,independentSources,bullishSignals:bullish,bearishSignals:bearish,suspiciousSignals:suspicious,evidenceQuality,hold,exit,evidence:relevant.slice(0,6).map(x=>x.name),headlines:news.slice(0,4)};
}

async function runScan(force=false){
  if(!force && cache.data && Date.now()-cache.ts<120000) return cache.data;
  const [catalogPages, otherPages] = await Promise.all([fetchCoinGeckoCatalog(), mapLimit(sources,MAX_CONCURRENCY,fetchText)]);
  const pages = [...catalogPages, ...otherPages];
  const newsItems = pages.filter(p=>p.ok&&p.type==='news').flatMap(p=>extractNews(p.text));
  const discovered = discoverTokens(pages,catalogPages);
  const tokens = discovered.map(t=>scoreToken(t,pages,newsItems));
  tokens.sort((a,b)=> (b.action==='BUY CANDIDATE')-(a.action==='BUY CANDIDATE') || b.opportunity-a.opportunity || b.mentions-a.mentions || a.symbol.localeCompare(b.symbol));
  const catalogCount = tokens.filter(t=>t.catalog).length;
  const result={generatedAt:new Date().toISOString(),methodology:'Public-web crawling only; no external market-data API is used. Meme token catalog is dynamically enumerated from paginated public category pages.',catalogCount,totalTokens:tokens.length,sourceHealth:pages.map(p=>({name:p.name,type:p.type,ok:p.ok,error:p.error||null})),warnings:['Confidence is evidence confidence, not a probability of profit.','HTML-only crawling cannot reliably observe every trade, holder, wallet, or contract state in real time.','A token is never marked risk-free. Rug-pull indicators override bullish signals.','The catalog contains all tokens the permitted public pages expose to this crawler at scan time; websites can hide or block some entries.'],tokens};
  cache={ts:Date.now(),data:result}; return result;
}

app.get('/scan',async(req,res)=>{try{res.json(await runScan(req.query.force==='1'));}catch(e){res.status(500).json({error:String(e.message||e)});}});
app.get('/health',(_,res)=>res.json({ok:true,now:new Date().toISOString()}));
app.listen(port,()=>console.log(`MemeCoin crawler listening on ${port}`));
