import express from 'express';
import * as cheerio from 'cheerio';

const app = express();
const port = process.env.PORT || 3000;
app.use(express.static('public'));

const UA = 'Mozilla/5.0 (compatible; CryptoScopeCrawler/3.0; +https://example.invalid/bot)';
const TIMEOUT = 10000;
const MAX_CONCURRENCY = 6;
const MAX_CATALOG_PAGES = 30;
const history = new Map();
const cache = { all:{ts:0,data:null}, meme:{ts:0,data:null}, ph:{ts:0,data:null}, global:{ts:0,data:null} };

const commonSources = [
  { name:'DexScreener', url:'https://dexscreener.com/', type:'market' },
  { name:'GeckoTerminal', url:'https://www.geckoterminal.com/', type:'market' },
  { name:'Etherscan Tokens', url:'https://etherscan.io/tokens', type:'onchain' },
  { name:'Solscan Tokens', url:'https://solscan.io/tokens', type:'onchain' },
  { name:'BscScan Tokens', url:'https://bscscan.com/tokens', type:'onchain' },
  { name:'Reddit CryptoCurrency', url:'https://www.reddit.com/r/CryptoCurrency/', type:'social' },
  { name:'DeFiLlama Unlocks', url:'https://defillama.com/unlocks', type:'tokenomics' },
  { name:'DeFiLlama Hacks', url:'https://defillama.com/hacks', type:'security' },
  { name:'CoinGlass Liquidation', url:'https://www.coinglass.com/LiquidationData', type:'derivatives' },
  { name:'Binance Announcements', url:'https://www.binance.com/en/support/announcement', type:'exchange' },
  { name:'Coinbase Blog', url:'https://www.coinbase.com/blog', type:'exchange' },
  { name:'GitHub Trending', url:'https://github.com/trending', type:'developer' },
  { name:'Fear & Greed', url:'https://alternative.me/crypto/fear-and-greed-index/', type:'macro' }
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
  ['RWA','real-world-assets-rwa'], ['Gaming','gaming'], ['Layer 1','layer-1'], ['Layer 2','layer-2'],
  ['Privacy','privacy-coins'], ['Exchange','centralized-exchange-token-cex'], ['Stablecoin','stablecoins']
];

const fallbackAll = [
  ['BTC','Bitcoin'],['ETH','Ethereum'],['USDT','Tether'],['BNB','BNB'],['SOL','Solana'],['USDC','USDC'],
  ['XRP','XRP'],['DOGE','Dogecoin'],['ADA','Cardano'],['AVAX','Avalanche'],['LINK','Chainlink'],['DOT','Polkadot'],
  ['TRX','TRON'],['SUI','Sui'],['TON','Toncoin'],['UNI','Uniswap'],['AAVE','Aave'],['NEAR','NEAR Protocol']
];
const fallbackMeme = [['DOGE','Dogecoin'],['SHIB','Shiba Inu'],['PEPE','Pepe'],['BONK','Bonk'],['WIF','dogwifhat'],['FLOKI','FLOKI'],['BRETT','Brett'],['MOG','Mog Coin'],['POPCAT','Popcat'],['TURBO','Turbo']];

const suspiciousTerms = ['guaranteed profit','100x guaranteed','risk free','send funds','presale ending','double your','airdrop claim','wallet validation','connect wallet now','urgent claim','cannot lose','pump now','ape now'];
const bullishTerms = ['listing','partnership','upgrade','adoption','integration','volume surge','all time high','breakout','accumulation','whale buy','institutional','mainnet','launch'];
const bearishTerms = ['rug pull','rugpull','honeypot','exploit','hack','blacklist','liquidity removed','developer sold','insider dump','scam','delist','lawsuit','breach','unlock'];
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
function buildUniverse(catalogPages,mode){const found=parseCatalogTokens(catalogPages,mode),bySymbol=new Map();for(const t of found.values()){if(!bySymbol.has(t.symbol))bySymbol.set(t.symbol,[]);bySymbol.get(t.symbol).push(t);}for(const[s,n]of(mode==='meme'?fallbackMeme:fallbackAll)){if(!bySymbol.has(s)){const t={id:`seed:${s}`,symbol:s,name:n,mentions:0,catalog:false,categories:mode==='meme'?['Meme']:[],evidenceRecords:[],headlines:[]};found.set(t.id,t);bySymbol.set(s,[t]);}}return{found,bySymbol};}
async function fetchCategoryMembership(){return mapLimit(categorySources.map(([label,slug])=>({name:`Category ${label}`,label,url:`https://www.coingecko.com/en/categories/${slug}?items=300&page=1`,type:'category'})),MAX_CONCURRENCY,fetchText);}
function indexCategories(found,pages){const bySlug=new Map([...found.values()].filter(t=>t.slug).map(t=>[t.slug,t]));for(const p of pages){if(!p.ok)continue;const $=cheerio.load(p.text||'');$('a[href*="/en/coins/"]').each((_,a)=>{const m=($(a).attr('href')||'').match(/\/en\/coins\/([^/?#]+)/);const t=m&&bySlug.get(m[1].toLowerCase());if(t&&!t.categories.includes(p.label))t.categories.push(p.label);});}}

function indexEvidence(found,bySymbol,pages){for(const p of pages){if(!p.ok||['catalog','category','news'].includes(p.type))continue;const text=cleanText(p.text).toUpperCase(),counts=new Map();for(const m of text.matchAll(/\b[A-Z][A-Z0-9._-]{1,19}\b/g)){const s=m[0];if(bySymbol.has(s))counts.set(s,Math.min(20,(counts.get(s)||0)+1));}for(const[s,count]of counts)for(const t of bySymbol.get(s)){t.mentions+=count;t.evidenceRecords.push({name:p.name,type:p.type,text:cleanText(p.text).slice(0,30000)});}}
}
function indexNews(bySymbol,items){for(const n of items){const upper=(n.title||'').toUpperCase(),matched=new Set();for(const m of upper.matchAll(/\b[A-Z][A-Z0-9._-]{1,19}\b/g)){if(bySymbol.has(m[0]))for(const t of bySymbol.get(m[0]))matched.add(t);}for(const t of matched){t.headlines.push(n);t.mentions++;t.evidenceRecords.push({name:'Google News',type:'news',text:n.title||''});}}}

function sourceTypes(records){return new Set(records.map(r=>r.type));}
function layer(name,types,records,positive=0,negative=0,note=''){const hits=records.filter(r=>types.includes(r.type));const coverage=[...new Set(hits.map(r=>r.name))].length;if(!coverage)return{name,status:'INSUFFICIENT DATA',score:null,coverage:0,note:note||'No token-specific evidence collected from this layer.'};const score=Math.max(0,Math.min(100,50+positive-negative));return{name,status:score>=65?'BULLISH':score<=35?'BEARISH':'NEUTRAL',score,coverage,note};}
function buildIntel(token,s){const records=token.evidenceRecords||[],text=[...records.map(r=>r.text||''),...(token.headlines||[]).map(h=>h.title||'')].join(' ');const bull=termCount(text,bullishTerms),bear=termCount(text,bearishTerms),sus=termCount(text,suspiciousTerms);const socialHits=records.filter(r=>r.type==='social');const socialText=socialHits.map(r=>r.text||'').join(' ').toLowerCase();const repeated=(socialText.match(/guaranteed|100x|ape now|pump now|risk free/g)||[]).length;const manipulationRisk=Math.min(100,sus*22+repeated*12+(socialHits.length?5:0));const layers=[
  layer('Market & liquidity',['market','derivatives'],records,Math.min(30,bull*5),Math.min(35,bear*6),'DEX/market and derivatives corroboration.'),
  layer('On-chain',['onchain'],records,Math.min(20,bull*4),Math.min(30,bear*6),'Explorer-visible token activity. Wallet attribution remains limited without chain APIs/nodes.'),
  layer('Social',['social'],records,Math.min(24,token.mentions*2),Math.min(35,manipulationRisk*.35),'Public social chatter; popularity alone is not bullish.'),
  layer('Bot / manipulation',['social'],records,0,manipulationRisk*.5,manipulationRisk?`Manipulation-risk heuristic ${manipulationRisk}/100 from suspicious/repetitive promotion language.`:'No strong manipulation pattern observed in collected public social text.'),
  layer('Tokenomics / unlocks',['tokenomics'],records,0,Math.min(35,bear*6),'Public unlock/tokenomics pages; exact schedules require token-specific confirmation.'),
  layer('Security',['security','onchain'],records,Math.min(10,bull*2),Math.min(45,(bear+sus)*8),'Exploit/hack/rug language and explorer corroboration.'),
  layer('Exchange',['exchange'],records,Math.min(25,bull*5),Math.min(30,bear*6),'Public listing/delisting and exchange announcements.'),
  layer('Developer health',['developer'],records,Math.min(20,termCount(text,qualityTerms)*3),0,'Public developer activity. Repository-to-token mapping may be incomplete.'),
  layer('Catalysts / news',['news','exchange'],records,Math.min(30,bull*6),Math.min(35,bear*7),'Listings, launches, upgrades, partnerships and adverse news.'),
  layer('Macro',['macro'],records,Math.min(12,bull*2),Math.min(15,bear*3),'Broad crypto risk environment; token-specific impact is limited.'),
  layer('Geographic trend',['geo'],records,0,0,'Philippines/global popularity signal when available.')
];
 const covered=layers.filter(x=>x.score!==null);const corroboration=Math.min(100,Math.round((new Set(records.map(r=>r.name)).size/6)*100));const overall=covered.length?Math.round(covered.reduce((a,x)=>a+x.score,0)/covered.length):null;return{layers,coveredLayers:covered.length,totalLayers:layers.length,overall,corroboration,manipulationRisk,warning:'Scores summarize collected public evidence only. Missing layers lower confidence; unavailable evidence is never assumed positive.'};}

function finishScore(token,s){const key=`${s.mode}:${token.id}`,prev=history.get(key)||[];prev.push({t:Date.now(),mentions:token.mentions,opportunity:s.opportunity,risk:s.risk});while(prev.length>40)prev.shift();history.set(key,prev);const older=prev.length>1?prev[Math.max(0,prev.length-6)]:prev[0],momentum=older?token.mentions-older.mentions:0;const evidenceQuality=Math.min(100,s.independentSources*14+(s.marketPresence?14:0)+(s.onchainPresence?14:0)+(s.headlines.length?10:0)+(token.catalog?8:0));let confidence=Math.round(Math.min(92,Math.max(15,.62*evidenceQuality+.38*Math.abs(s.opportunity-50)*2)));let action='WATCH';if(s.risk>=60)action='AVOID';else if(s.opportunity>=76&&s.independentSources>=3)action='BUY CANDIDATE';else if(s.opportunity<30)action='AVOID';const intel=buildIntel(token,s);confidence=Math.round(confidence*Math.max(.55,Math.min(1,intel.coveredLayers/7)));if(intel.manipulationRisk>=65){action='AVOID';s.risk=Math.max(s.risk,65);}else if(action==='BUY CANDIDATE'&&intel.coveredLayers<3)action='WATCH';const hold=action==='BUY CANDIDATE'?(s.risk<30&&momentum>=0?'Hold while opportunity remains ≥68 and risk remains controlled; reassess each scan.':'Short-duration setup; reassess on the next scan.'):'No new entry recommended.';const exit=action==='BUY CANDIDATE'?'Reduce/exit if opportunity falls below 60, risk rises above 45, manipulation risk spikes, or momentum reverses across consecutive scans.':'N/A';const{evidenceRecords,...clean}=token;return{...clean,opportunity:s.opportunity,risk:s.risk,rugRisk:s.risk,quality:s.quality,confidence,action,momentum,independentSources:s.independentSources,bullishSignals:s.bullish,bearishSignals:s.bearish,suspiciousSignals:s.suspicious,evidenceQuality,hold,exit,evidence:s.names.slice(0,8),headlines:s.headlines,intel};}
function scoreToken(token,mode){const records=token.evidenceRecords||[],headlines=(token.headlines||[]).slice(0,5),text=[...records.map(r=>r.text||''),...headlines.map(x=>x.title||'')].join(' '),bullish=termCount(text,bullishTerms),bearish=termCount(text,bearishTerms),suspicious=termCount(text,suspiciousTerms),qualityHits=termCount(text,qualityTerms),names=[...new Set(records.map(x=>x.name))],independentSources=names.length,marketPresence=records.some(x=>['market','derivatives'].includes(x.type)),onchainPresence=records.some(x=>x.type==='onchain'),categoryBreadth=(token.categories||[]).filter(x=>x!=='Stablecoin').length;let quality=mode==='meme'?null:Math.min(100,35+(token.catalog?15:0)+(onchainPresence?10:0)+Math.min(15,independentSources*3)+Math.min(15,qualityHits*4)+Math.min(10,categoryBreadth*3));let opportunity=(mode==='meme'?30:32)+Math.min(24,token.mentions*2)+bullish*7-bearish*(mode==='meme'?14:10)-suspicious*(mode==='meme'?18:16)+(marketPresence?8:0)+(token.catalog?5:0)+(quality!=null?Math.round((quality-50)*.18):0);opportunity=Math.max(0,Math.min(100,opportunity));let risk=(mode==='meme'?10:18)+bearish*(mode==='meme'?20:13)+suspicious*22+(!onchainPresence?8:0)+(independentSources<2?7:0);risk=Math.max(0,Math.min(100,risk));return finishScore(token,{opportunity,risk,quality,bullish,bearish,suspicious,names,headlines,independentSources,marketPresence,onchainPresence,mode});}

async function runScan(mode='all',force=false){mode=mode==='meme'?'meme':'all';const c=cache[mode];if(!force&&c.data&&Date.now()-c.ts<120000)return c.data;const sourceList=[...commonSources,...modeSources[mode]];const tasks=[fetchCatalog(mode),mapLimit(sourceList,MAX_CONCURRENCY,fetchText)];if(mode==='all')tasks.push(fetchCategoryMembership());const[catalogPages,otherPages,categoryPages=[]]=await Promise.all(tasks);const{found,bySymbol}=buildUniverse(catalogPages,mode);if(mode==='all')indexCategories(found,categoryPages);indexEvidence(found,bySymbol,otherPages);const newsItems=otherPages.filter(p=>p.ok&&p.type==='news').flatMap(p=>extractNews(p.text));indexNews(bySymbol,newsItems);const tokens=[...found.values()].map(t=>scoreToken(t,mode));tokens.sort((a,b)=>(b.action==='BUY CANDIDATE')-(a.action==='BUY CANDIDATE')||b.opportunity-a.opportunity||b.confidence-a.confidence);const sourceHealth=[...catalogPages,...otherPages,...categoryPages].map(p=>({name:p.name,type:p.type,ok:p.ok,error:p.error||null}));const result={mode,generatedAt:new Date().toISOString(),catalogCount:tokens.filter(t=>t.catalog).length,totalTokens:tokens.length,sourceHealth,intelTypes:['market','derivatives','onchain','social','tokenomics','security','exchange','developer','news','macro'],warnings:['Signals are heuristic and do not guarantee profit.','Missing intel is shown as INSUFFICIENT DATA and lowers confidence.','Private Discord/Telegram data is not accessed without authorization.','Public HTML crawling cannot observe every wallet, trade, unlock, repository or social message in real time.'],tokens};cache[mode]={ts:Date.now(),data:result};return result;}

async function fetchTrending(region='global',force=false){region=region==='ph'?'ph':'global';const c=cache[region];if(!force&&c.data&&Date.now()-c.ts<120000)return c.data;const url=region==='ph'?'https://www.coingecko.com/en/highlights/trending-crypto/philippines':'https://www.coingecko.com/en/highlights/trending-crypto';const page=await fetchText({name:region==='ph'?'CoinGecko PH Trending':'CoinGecko Global Trending',url,type:'geo'});const rows=[];if(page.ok){const $=cheerio.load(page.text);$('table tbody tr').each((i,tr)=>{const link=$(tr).find('a[href*="/en/coins/"]').first();if(!link.length)return;const txt=$(tr).text().replace(/\s+/g,' ').trim();const slug=((link.attr('href')||'').match(/\/en\/coins\/([^/?#]+)/)||[])[1]||'';const name=link.text().replace(/\s+/g,' ').trim()||slug.replace(/-/g,' ');const symMatch=txt.match(/\b[A-Z0-9]{2,12}\b/);const symbol=symMatch?symMatch[0]:name.slice(0,8).toUpperCase();const token={id:`trend:${region}:${slug||symbol}`,slug,symbol,name,mentions:1,catalog:true,categories:[],evidenceRecords:[{name:page.name,type:'geo',text:txt}],headlines:[]};const scored=scoreToken(token,'all');rows.push({...scored,trendRank:i+1,marketRank:null,price:null,change1h:null,change24h:null,change7d:null,volume24h:null,marketCap:null});});}
 const result={region,generatedAt:new Date().toISOString(),rows,sourceHealth:[{name:page.name,type:'geo',ok:page.ok,error:page.error||null}]};cache[region]={ts:Date.now(),data:result};return result;}

app.get('/scan',async(req,res)=>{try{res.json(await runScan(req.query.mode,req.query.force==='1'));}catch(e){res.status(500).json({error:String(e.message||e)});}});
app.get('/trending',async(req,res)=>{try{res.json(await fetchTrending(req.query.region,req.query.force==='1'));}catch(e){res.status(500).json({error:String(e.message||e)});}});
app.get('/intel/sources',async(_,res)=>{const pages=await mapLimit(commonSources,MAX_CONCURRENCY,fetchText);res.json({generatedAt:new Date().toISOString(),sources:pages.map(p=>({name:p.name,type:p.type,ok:p.ok,error:p.error||null})),limits:{discord:'Authorized/private Discord channels require a connected bot or approved access.',telegram:'Public Telegram monitoring requires configured public-channel access; private groups are not crawled.',walletAttribution:'Deep wallet attribution requires chain nodes or permitted APIs beyond HTML-only crawling.'}});});
app.get('/health',(_,res)=>res.json({ok:true,app:'CryptoScope Intelligence v3',now:new Date().toISOString()}));
app.listen(port,()=>console.log(`CryptoScope Intelligence v3 listening on ${port}`));
