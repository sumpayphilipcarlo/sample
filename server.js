import express from 'express';
import * as cheerio from 'cheerio';

const app = express();
const port = process.env.PORT || 3000;
app.use(express.static('public'));

const UA = 'Mozilla/5.0 (compatible; CryptoScopeCrawler/2.2; +https://example.invalid/bot)';
const TIMEOUT = 10000;
const MAX_CONCURRENCY = 6;
const MAX_CATALOG_PAGES = 30;
const history = new Map();
const cache = { all:{ts:0,data:null}, meme:{ts:0,data:null}, ph:{ts:0,data:null}, global:{ts:0,data:null} };

const commonSources = [
  { name:'DexScreener', url:'https://dexscreener.com/', type:'market' },
  { name:'GeckoTerminal', url:'https://www.geckoterminal.com/', type:'market' },
  { name:'Etherscan Tokens', url:'https://etherscan.io/tokens', type:'explorer' },
  { name:'Solscan Tokens', url:'https://solscan.io/tokens', type:'explorer' },
  { name:'BscScan Tokens', url:'https://bscscan.com/tokens', type:'explorer' },
  { name:'Reddit CryptoCurrency', url:'https://www.reddit.com/r/CryptoCurrency/', type:'social' }
];

const modeSources = {
  all: [
    { name:'CoinMarketCap', url:'https://coinmarketcap.com/', type:'market' },
    { name:'Google News Crypto', url:'https://news.google.com/rss/search?q=cryptocurrency%20OR%20crypto%20token&hl=en-US&gl=US&ceid=US:en', type:'news' }
  ],
  meme: [
    { name:'CoinMarketCap Memes', url:'https://coinmarketcap.com/view/memes/', type:'market' },
    { name:'Google News Memes', url:'https://news.google.com/rss/search?q=memecoin%20OR%20meme%20coin%20crypto&hl=en-US&gl=US&ceid=US:en', type:'news' },
    { name:'Reddit Memecoins', url:'https://www.reddit.com/r/memecoins/', type:'social' }
  ]
};

const categorySources = [
  ['Meme','meme-token'], ['AI','artificial-intelligence'], ['DeFi','decentralized-finance-defi'],
  ['RWA','real-world-assets-rwa'], ['Gaming','gaming'], ['Layer 1','layer-1'],
  ['Layer 2','layer-2'], ['Privacy','privacy-coins'], ['Exchange','centralized-exchange-token-cex'],
  ['Stablecoin','stablecoins']
];

const fallbackAll = [
  ['BTC','Bitcoin'],['ETH','Ethereum'],['USDT','Tether'],['BNB','BNB'],['SOL','Solana'],['USDC','USDC'],
  ['XRP','XRP'],['DOGE','Dogecoin'],['ADA','Cardano'],['AVAX','Avalanche'],['LINK','Chainlink'],['DOT','Polkadot'],
  ['TRX','TRON'],['SUI','Sui'],['TON','Toncoin'],['UNI','Uniswap'],['AAVE','Aave'],['NEAR','NEAR Protocol']
];
const fallbackMeme = [['DOGE','Dogecoin'],['SHIB','Shiba Inu'],['PEPE','Pepe'],['BONK','Bonk'],['WIF','dogwifhat'],['FLOKI','FLOKI'],['BRETT','Brett'],['MOG','Mog Coin'],['POPCAT','Popcat'],['TURBO','Turbo']];

const suspiciousTerms = ['guaranteed profit','100x guaranteed','risk free','send funds','presale ending','double your','airdrop claim','wallet validation','connect wallet now','urgent claim','cannot lose'];
const bullishTerms = ['listing','partnership','upgrade','adoption','integration','volume surge','all time high','breakout','accumulation','whale buy','open interest','institutional','launch'];
const bearishTerms = ['rug pull','rugpull','honeypot','exploit','hack','blacklist','liquidity removed','developer sold','insider dump','scam','delist','lawsuit','breach'];
const qualityTerms = ['mainnet','protocol','validator','governance','staking','revenue','developers','audit','institutional','ecosystem','partnership','integration'];

function timeoutFetch(url){const c=new AbortController();const id=setTimeout(()=>c.abort(),TIMEOUT);return fetch(url,{headers:{'user-agent':UA,'accept-language':'en-US,en;q=0.9'},signal:c.signal,redirect:'follow'}).finally(()=>clearTimeout(id));}
async function fetchText(src){try{const r=await timeoutFetch(src.url);if(!r.ok)throw new Error(`HTTP ${r.status}`);return{...src,ok:true,text:(await r.text()).slice(0,1800000),status:r.status};}catch(e){return{...src,ok:false,text:'',error:String(e.message||e)};}}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let i=0;async function worker(){while(i<items.length){const j=i++;out[j]=await fn(items[j]);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;}
function cleanText(html){const $=cheerio.load(html||'');$('script,style,noscript,svg').remove();return $('body').text().replace(/\s+/g,' ').trim();}
function extractNews(xml){const $=cheerio.load(xml,{xmlMode:true});const items=[];$('item').slice(0,120).each((_,el)=>items.push({title:$(el).find('title').text(),link:$(el).find('link').text(),published:$(el).find('pubDate').text()}));return items;}
function termCount(text,terms){const t=(text||'').toLowerCase();return terms.reduce((n,x)=>n+(t.includes(x)?1:0),0);}
function catalogPageCount(html){const $=cheerio.load(html||'');let max=1;$('a[href*="page="]').each((_,a)=>{const m=($(a).attr('href')||'').match(/[?&]page=(\d+)/);if(m)max=Math.max(max,Number(m[1]));});return Math.min(MAX_CATALOG_PAGES,Math.max(1,max));}

function catalogUrl(mode,page){return mode==='meme'?`https://www.coingecko.com/en/categories/meme-token?items=300&page=${page}`:`https://www.coingecko.com/en/coins/all?items=300&page=${page}`;}
async function fetchCatalog(mode){const first=await fetchText({name:mode==='meme'?'CoinGecko Meme 1':'CoinGecko All 1',url:catalogUrl(mode,1),type:'catalog'});if(!first.ok)return[first];const total=catalogPageCount(first.text);const rest=[];for(let p=2;p<=total;p++)rest.push({name:`CoinGecko ${mode==='meme'?'Meme':'All'} ${p}`,url:catalogUrl(mode,p),type:'catalog'});return[first,...await mapLimit(rest,MAX_CONCURRENCY,fetchText)];}

function parseCatalogTokens(pages,mode){const found=new Map();for(const p of pages){if(!p.ok)continue;const $=cheerio.load(p.text||'');$('table tbody tr').each((_,tr)=>{const link=$(tr).find('a[href*="/en/coins/"]').first();if(!link.length)return;const m=(link.attr('href')||'').match(/\/en\/coins\/([^/?#]+)/);if(!m)return;const slug=m[1].toLowerCase();let cell=link.closest('td').text().replace(/\s+/g,' ').trim().replace(/\bBuy\b/gi,'').trim();if(!cell)cell=link.text().replace(/\s+/g,' ').trim();const parts=cell.split(' ').filter(Boolean);let symbol='';for(let i=parts.length-1;i>=0;i--){const x=parts[i].replace(/^\$+/,'');if(/^[A-Za-z0-9._-]{1,20}$/.test(x)&&/[A-Za-z]/.test(x)){symbol=x.toUpperCase();parts.splice(i,1);break;}}const name=parts.join(' ').trim()||slug.replace(/-/g,' ');if(!symbol)return;const id=`cg:${slug}`;if(!found.has(id))found.set(id,{id,slug,symbol,name,mentions:0,catalog:true,categories:mode==='meme'?['Meme']:[],evidenceRecords:[],headlines:[]});});}return found;}

function buildUniverse(catalogPages,mode){const found=parseCatalogTokens(catalogPages,mode),bySymbol=new Map();for(const t of found.values()){if(!bySymbol.has(t.symbol))bySymbol.set(t.symbol,[]);bySymbol.get(t.symbol).push(t);}const seeds=mode==='meme'?fallbackMeme:fallbackAll;for(const[s,n]of seeds){if(!bySymbol.has(s)){const t={id:`seed:${s}`,symbol:s,name:n,mentions:0,catalog:false,categories:mode==='meme'?['Meme']:[],evidenceRecords:[],headlines:[]};found.set(t.id,t);bySymbol.set(s,[t]);}}return{found,bySymbol};}

async function fetchCategoryMembership(){const jobs=categorySources.map(([label,slug])=>({name:`Category ${label}`,label,url:`https://www.coingecko.com/en/categories/${slug}?items=300&page=1`,type:'category'}));return mapLimit(jobs,MAX_CONCURRENCY,fetchText);}
function indexCategories(found,categoryPages){const bySlug=new Map([...found.values()].filter(t=>t.slug).map(t=>[t.slug,t]));for(const p of categoryPages){if(!p.ok)continue;const $=cheerio.load(p.text||'');$('a[href*="/en/coins/"]').each((_,a)=>{const m=($(a).attr('href')||'').match(/\/en\/coins\/([^/?#]+)/);if(!m)return;const t=bySlug.get(m[1].toLowerCase());if(t&&!t.categories.includes(p.label))t.categories.push(p.label);});}}

function indexPageEvidence(found,bySymbol,pages){for(const p of pages){if(!p.ok||p.type==='catalog'||p.type==='category'||p.type==='news')continue;const text=cleanText(p.text).toUpperCase(),counts=new Map();for(const m of text.matchAll(/\b[A-Z][A-Z0-9._-]{1,19}\b/g)){const s=m[0];if(bySymbol.has(s))counts.set(s,Math.min(20,(counts.get(s)||0)+1));}for(const[s,count]of counts)for(const t of bySymbol.get(s)){t.mentions+=count;t.evidenceRecords.push({name:p.name,type:p.type});}for(const m of text.matchAll(/\$([A-Z][A-Z0-9]{1,14})\b/g)){const s=m[1];if(bySymbol.has(s))continue;let t=found.get(`mention:${s}`);if(!t){t={id:`mention:${s}`,symbol:s,name:s,mentions:0,catalog:false,categories:[],evidenceRecords:[],headlines:[]};found.set(t.id,t);bySymbol.set(s,[t]);}t.mentions++;t.evidenceRecords.push({name:p.name,type:p.type});}}
}
function indexNews(bySymbol,newsItems){for(const n of newsItems){const title=n.title||'',upper=title.toUpperCase(),matched=new Set();for(const m of upper.matchAll(/\b[A-Z][A-Z0-9._-]{1,19}\b/g)){const s=m[0];if(bySymbol.has(s))for(const t of bySymbol.get(s))matched.add(t);}for(const t of matched){t.headlines.push(n);t.mentions++;t.evidenceRecords.push({name:'Google News',type:'news'});}}}

function scoreMeme(token){const records=token.evidenceRecords||[],headlines=(token.headlines||[]).slice(0,5),text=headlines.map(x=>x.title).join(' ');const bullish=termCount(text,bullishTerms),bearish=termCount(text,bearishTerms),suspicious=termCount(text,suspiciousTerms);const names=[...new Set(records.map(x=>x.name))],independentSources=names.length,marketPresence=records.some(x=>x.type==='market'),explorerPresence=records.some(x=>x.type==='explorer'),socialPresence=records.some(x=>x.type==='social');let opportunity=30+Math.min(24,token.mentions*2)+bullish*7-bearish*14-suspicious*18+(token.catalog?5:0)+(marketPresence?10:0)+(explorerPresence?6:0)+(socialPresence?4:0);opportunity=Math.max(0,Math.min(100,opportunity));let risk=10+bearish*20+suspicious*24+(!explorerPresence?12:0)+(independentSources<2?10:0);risk=Math.max(0,Math.min(100,risk));return finishScore(token,{opportunity,risk,quality:null,bullish,bearish,suspicious,names,headlines,independentSources,marketPresence,explorerPresence,mode:'meme'});}

function scoreGeneral(token){const records=token.evidenceRecords||[],headlines=(token.headlines||[]).slice(0,5),text=headlines.map(x=>x.title).join(' '),bullish=termCount(text,bullishTerms),bearish=termCount(text,bearishTerms),suspicious=termCount(text,suspiciousTerms),qualityHits=termCount(text,qualityTerms);const names=[...new Set(records.map(x=>x.name))],independentSources=names.length,marketPresence=records.some(x=>x.type==='market'),explorerPresence=records.some(x=>x.type==='explorer'),categoryBreadth=(token.categories||[]).filter(x=>x!=='Stablecoin').length;let quality=35+(token.catalog?15:0)+(explorerPresence?10:0)+Math.min(15,independentSources*3)+Math.min(15,qualityHits*4)+Math.min(10,categoryBreadth*3);if((token.categories||[]).includes('Stablecoin'))quality=Math.max(quality,55);quality=Math.min(100,quality);let opportunity=32+Math.min(22,token.mentions*2)+bullish*7-bearish*10+Math.min(10,categoryBreadth*2)+(marketPresence?8:0)+Math.round((quality-50)*.18);opportunity=Math.max(0,Math.min(100,opportunity));let risk=18+bearish*13+suspicious*22+(!explorerPresence?8:0)+(independentSources<2?7:0)+(token.catalog?-5:6);if((token.categories||[]).includes('Stablecoin'))opportunity=Math.min(opportunity,55);risk=Math.max(0,Math.min(100,risk));return finishScore(token,{opportunity,risk,quality,bullish,bearish,suspicious,names,headlines,independentSources,marketPresence,explorerPresence,mode:'all'});}

function finishScore(token,s){const key=`${s.mode}:${token.id}`,prev=history.get(key)||[];prev.push({t:Date.now(),mentions:token.mentions,opportunity:s.opportunity,risk:s.risk});while(prev.length>40)prev.shift();history.set(key,prev);const older=prev.length>1?prev[Math.max(0,prev.length-6)]:prev[0],momentum=older?token.mentions-older.mentions:0;let action='WATCH';if(s.risk>=60)action='AVOID';else if(s.opportunity>=76&&s.independentSources>=3)action='BUY CANDIDATE';else if(s.opportunity<30)action='AVOID';const evidenceQuality=Math.min(100,s.independentSources*16+(s.marketPresence?14:0)+(s.explorerPresence?14:0)+(s.headlines.length?10:0)+(token.catalog?8:0));const confidence=Math.round(Math.min(92,Math.max(15,.62*evidenceQuality+.38*Math.abs(s.opportunity-50)*2)));const hold=action==='BUY CANDIDATE'?(s.risk<30&&momentum>=0?'Hold while opportunity remains ≥68 and risk remains controlled; reassess each scan.':'Short-duration setup; reassess on the next scan.'):'No entry recommended.';const exit=action==='BUY CANDIDATE'?'Reduce/exit if opportunity falls below 60, risk rises above 45, or momentum reverses across consecutive scans. Use your own position-size and stop rules.':'N/A';const{evidenceRecords,...clean}=token;return{...clean,opportunity:s.opportunity,risk:s.risk,rugRisk:s.risk,quality:s.quality,confidence,action,momentum,independentSources:s.independentSources,bullishSignals:s.bullish,bearishSignals:s.bearish,suspiciousSignals:s.suspicious,evidenceQuality,hold,exit,evidence:s.names.slice(0,6),headlines:s.headlines};}

async function runScan(mode='all',force=false){mode=mode==='meme'?'meme':'all';const c=cache[mode];if(!force&&c.data&&Date.now()-c.ts<120000)return c.data;const sourceList=[...commonSources,...modeSources[mode]];const tasks=[fetchCatalog(mode),mapLimit(sourceList,MAX_CONCURRENCY,fetchText)];if(mode==='all')tasks.push(fetchCategoryMembership());const[catalogPages,otherPages,categoryPages=[]]=await Promise.all(tasks);const{found,bySymbol}=buildUniverse(catalogPages,mode);if(mode==='all')indexCategories(found,categoryPages);indexPageEvidence(found,bySymbol,otherPages);const newsItems=otherPages.filter(p=>p.ok&&p.type==='news').flatMap(p=>extractNews(p.text));indexNews(bySymbol,newsItems);const scorer=mode==='meme'?scoreMeme:scoreGeneral;const tokens=[...found.values()].map(scorer);tokens.sort((a,b)=>(b.action==='BUY CANDIDATE')-(a.action==='BUY CANDIDATE')||b.opportunity-a.opportunity||b.mentions-a.mentions||a.symbol.localeCompare(b.symbol));const sourceHealth=[...catalogPages,...otherPages,...categoryPages].map(p=>({name:p.name,type:p.type,ok:p.ok,error:p.error||null}));const result={mode,generatedAt:new Date().toISOString(),methodology:mode==='meme'?'MemeWatch: public-web meme catalog with sentiment/rug-risk override.':'CryptoScope: broad public-web crypto catalog with opportunity, quality and risk scoring.',catalogCount:tokens.filter(t=>t.catalog).length,totalTokens:tokens.length,sourceHealth,warnings:['Signals are heuristic and do not guarantee profit.','Confidence measures evidence strength, not win probability.','Public HTML crawling cannot guarantee coverage of every token or observe every on-chain event in real time.','New/unlisted tokens and sources blocked by site controls may be missing.'],tokens};cache[mode]={ts:Date.now(),data:result};return result;}

function parseTrendingTable(html){const $=cheerio.load(html||'');const rows=[];$('table tbody tr').each((i,tr)=>{const link=$(tr).find('a[href*="/en/coins/"]').first();if(!link.length)return;const href=link.attr('href')||'';const slug=(href.match(/\/en\/coins\/([^/?#]+)/)||[])[1]||'';const coinText=link.text().replace(/\s+/g,' ').trim();const parts=coinText.split(' ').filter(Boolean);let symbol='';for(let j=parts.length-1;j>=0;j--){const p=parts[j].replace(/^\$+/,'');if(/^[A-Za-z0-9._-]{1,15}$/.test(p)&&/[A-Za-z]/.test(p)){symbol=p.toUpperCase();parts.splice(j,1);break;}}const name=parts.join(' ').trim()||slug.replace(/-/g,' ');const td=$(tr).find('td').map((_,el)=>$(el).text().replace(/\s+/g,' ').trim()).get();const pct=td.filter(x=>/^-?\d+(?:\.\d+)?%$/.test(x));const money=td.filter(x=>/^\$/.test(x));const rank=td.map(x=>Number(x.replace(/,/g,''))).find(x=>Number.isInteger(x)&&x>0&&x<100000)||null;rows.push({trendRank:i+1,marketRank:rank,name,symbol,slug,price:money[0]||null,change1h:pct[0]||null,change24h:pct[1]||null,change7d:pct[2]||null,volume24h:money[1]||null,marketCap:money[2]||null});});return rows;}

async function runTrending(region='ph',force=false){region=region==='global'?'global':'ph';const c=cache[region];if(!force&&c.data&&Date.now()-c.ts<120000)return c.data;const url=region==='ph'?'https://www.coingecko.com/en/highlights/trending-crypto/philippines':'https://www.coingecko.com/en/highlights/trending-crypto';const page=await fetchText({name:region==='ph'?'CoinGecko PH Trending':'CoinGecko Global Trending',url,type:'trending'});if(!page.ok)throw new Error(page.error||'Trending source unavailable');const market=await runScan('all',false);const bySymbol=new Map(market.tokens.map(t=>[t.symbol,t]));const rows=parseTrendingTable(page.text).map(r=>({...r,...(bySymbol.get(r.symbol)||{action:'WATCH',opportunity:50,risk:50,quality:null,confidence:25,independentSources:0,bullishSignals:0,bearishSignals:0,suspiciousSignals:0,momentum:0,categories:[],evidence:[],headlines:[],hold:'Insufficient cross-source evidence.',exit:'N/A'})}));const result={region,generatedAt:new Date().toISOString(),source:'CoinGecko public trending page',rows};cache[region]={ts:Date.now(),data:result};return result;}

app.get('/scan',async(req,res)=>{try{res.json(await runScan(req.query.mode,req.query.force==='1'));}catch(e){res.status(500).json({error:String(e.message||e)});}});
app.get('/trending',async(req,res)=>{try{res.json(await runTrending(req.query.region,req.query.force==='1'));}catch(e){res.status(500).json({error:String(e.message||e)});}});
app.get('/health',(_,res)=>res.json({ok:true,app:'CryptoScope + MemeWatch',now:new Date().toISOString()}));
app.listen(port,()=>console.log(`CryptoScope crawler listening on ${port}`));