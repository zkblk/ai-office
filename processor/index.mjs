#!/usr/bin/env node
// Idea Inbox processor. Notion is the queue and the output:
// rows with empty/New status → media (Cobalt → yt-dlp) → transcript (parakeet.cpp) → summary/tags (Ollama) → back to the same Notion page.
// Runs in GitHub Actions (.github/workflows/idea-inbox.yml). The repo is public, so logs carry page ids only — never URLs or content.
// Usage: node processor/index.mjs            process the queue
//        node processor/index.mjs --count    print number of pending rows
import{execFile}from'node:child_process';import{promisify}from'node:util';import{mkdtemp,readdir,rm,stat,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
const run=promisify(execFile),env=process.env;
const cfg={token:env.NOTION_TOKEN,ds:env.NOTION_DATA_SOURCE_ID,cobalt:(env.COBALT_URL||'').replace(/\/$/,''),parakeet:env.PARAKEET_CLI||'parakeet-cli',model:env.PARAKEET_MODEL,
  ollama:(env.OLLAMA_URL||'http://localhost:11434').replace(/\/$/,''),llm:env.LLM_MODEL||'qwen2.5:7b',lang:env.SUMMARY_LANGUAGE||'the same language as the content',
  ytCookies:env.YTDLP_COOKIES_FILE,maxItems:Number(env.MAX_ITEMS||15),budgetMs:Number(env.TIME_BUDGET_MIN||45)*60000,maxAttempts:3,
  // Resource Catalog (Notion data source). Every tool found in a capture is filed there as 📥 Inbox unless it already exists.
  catalog:env.CATALOG_DATA_SOURCE_ID};
const CATEGORIES=(env.CATEGORIES||'AI tools,Design & UX,Development,Product,Marketing,Business,Productivity,Career,Finance,Health,Lifestyle,Other').split(',');
// Option lists of the Resource Catalog schema (Super Category, "I want to…", Pricing). Keep in sync with Notion.
const SUPER=['🎨 Inspiration & Galleries','🧩 UI Components & Code','✨ Motion & Effects','🖼️ Visual Assets','🤖 AI Agents & Coding','🛠️ Dev Tools & Infra','🔓 Open-Source SaaS Alts','💼 Productivity & Career'];
const WANT=['Sections & Landing','Backgrounds & Gradients','Icons','Fonts & Typography','Colors & Palettes','Illustrations & SVG','3D & WebGL','Motion & Effects','Image Effects','UI Components','Design System','Framer & Figma Resources','Accessibility','Moodboard & Inspiration','Mobile & App Flows','Loaders / 404 / States','Forms','Charts & Maps','Mockups & Screenshots','Video & Media','Branding & Identity','Portfolio & CV','E-commerce','Website Templates','AI Prompts for Design','AI Coding & Agents','Terminal & CLI','Deploy & Hosting','Monitoring & Analytics','SEO & Launch','CMS & Backend','Automation & Scraping','Dev Utilities','Project Mgmt & Team','Personal Productivity','Business & Marketing','Learning & Tutorials'];
const PRICING=['Free','Open-Source','Freemium','Free Trial','One-time','Paid'];
const log=(...a)=>console.log(new Date().toISOString().slice(11,19),...a);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// ---------- Notion ----------
async function notion(path,method='GET',body){for(let i=0;;i++){const r=await fetch((env.NOTION_API||'https://api.notion.com/v1/')+path,{method,headers:{authorization:'Bearer '+cfg.token,'notion-version':'2025-09-03','content-type':'application/json'},body:body&&JSON.stringify(body)});
if(r.status===429&&i<5){await sleep(Number(r.headers.get('retry-after')||1)*1000);continue}const d=await r.json();if(!r.ok)throw new Error(`notion ${r.status}: ${d.message}`);return d}}
const text=s=>{const out=[];s=String(s||'');for(let i=0;i<s.length&&out.length<100;i+=2000)out.push({type:'text',text:{content:s.slice(i,i+2000)}});return out};
const plain=p=>(p?.title||p?.rich_text||[]).map(t=>t.plain_text).join('');
const opts=a=>[...new Set((a||[]).map(x=>String(x).replace(/,/g,' ').trim().slice(0,100)).filter(Boolean))].slice(0,15).map(name=>({name}));
const STALE=()=>new Date(Date.now()-2*3600000).toISOString();
async function pending(limit=100){const d=await notion(`data_sources/${cfg.ds}/query`,'POST',{page_size:limit,sorts:[{timestamp:'created_time',direction:'ascending'}],filter:{or:[{property:'Status',select:{is_empty:true}},{property:'Status',select:{equals:'New'}},
  {and:[{property:'Status',select:{equals:'Processing'}},{timestamp:'last_edited_time',last_edited_time:{before:STALE()}}]}]}});return d.results}
const update=(id,properties)=>notion('pages/'+id,'PATCH',{properties});
// Replace blocks this integration wrote earlier (re-processing), keep anything the user or Web Clipper added.
async function writeBody(id,botId,sections,url){let cursor;do{const d=await notion(`blocks/${id}/children?page_size=100${cursor?'&start_cursor='+cursor:''}`);for(const b of d.results)if(b.created_by?.id===botId)await notion('blocks/'+b.id,'DELETE');cursor=d.has_more&&d.next_cursor}while(cursor);
// A section body is either text (→ paragraphs) or an array (→ bullet list).
// First line of every page: a clickable link to the original post/video/article.
const blocks=url?[{type:'paragraph',paragraph:{rich_text:[{type:'text',text:{content:'🔗 Оригинал: '}},{type:'text',text:{content:url.slice(0,1900),link:{url}}}]}}]:[];for(const[h,body]of sections){if(!body?.length)continue;blocks.push({type:'heading_2',heading_2:{rich_text:text(h)}});
  // A list item is a string or a ready rich_text array (used for links).
  if(Array.isArray(body))for(const item of body)blocks.push({type:'bulleted_list_item',bulleted_list_item:{rich_text:Array.isArray(item)?item:text(String(item).slice(0,1900))}});
  else for(const chunk of paragraphs(body))blocks.push({type:'paragraph',paragraph:{rich_text:text(chunk)}})}
for(let i=0;i<blocks.length;i+=100)await notion(`blocks/${id}/children`,'PATCH',{children:blocks.slice(i,i+100)})}
// ~1800-char paragraphs split on sentence boundaries so Notion stays readable and under its 2000-char limit.
function paragraphs(s){const out=[];let cur='';for(const part of String(s).split(/(?<=[.!?…])\s+|\n+/)){if((cur+' '+part).length>1800&&cur){out.push(cur);cur=''}cur=cur?cur+' '+part:part}if(cur)out.push(cur);return out.flatMap(p=>p.match(/[\s\S]{1,1900}/g)||[])}

// ---------- Extraction ----------
const source=u=>/instagram\.com/.test(u)?'Instagram':/threads\.(net|com)/.test(u)?'Threads':/youtu\.?be/.test(u)?'YouTube':/linkedin\.com/.test(u)?'LinkedIn':'Web';
const ytArgs=()=>['--no-warnings','--no-playlist','--quiet',...(cfg.ytCookies?['--cookies',cfg.ytCookies]:[])];
async function metadata(url){try{const{stdout}=await run('yt-dlp',['-J','--skip-download',...ytArgs(),url],{timeout:90000,maxBuffer:64<<20});const j=JSON.parse(stdout),d=j.upload_date;
  // Carousel slides come back as playlist entries; the largest thumbnail of a photo entry is the photo itself, of a video entry its poster frame.
  const pic=e=>e?.thumbnails?.at(-1)?.url||e?.thumbnail||'';const images=[...new Set((j.entries?.length?j.entries.map(pic):[pic(j)]).filter(Boolean))].slice(0,20);
  return{title:j.title||'',author:j.uploader||j.channel||j.creator||'',caption:j.description||'',published:d?`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`:'',images}}catch{return{}}}
// Plain page text for articles and text posts: og tags + visible text.
async function pageText(url){try{const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; IdeaInbox/1.0)'},signal:AbortSignal.timeout(30000)});if(!r.ok)return{};const html=await r.text();
  const meta=k=>html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']*)`,'i'))?.[1]||'';const dec=s=>s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(parseInt(h,16)));
  const body=(html.match(/<article[\s\S]*?<\/article>/i)?.[0]||html.match(/<body[\s\S]*<\/body>/i)?.[0]||'').replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  return{title:dec(meta('og:title')||html.match(/<title>([^<]*)/i)?.[1]||''),author:dec(meta('author')),caption:dec(meta('og:description')||meta('description')),article:dec(body).slice(0,30000)}}catch{return{}}}
async function download(url,file){const r=await fetch(url,{signal:AbortSignal.timeout(10*60000)});if(!r.ok)throw new Error('download '+r.status);await writeFile(file,Buffer.from(await r.arrayBuffer()));return file}
async function viaCobalt(url,dir){if(!cfg.cobalt)throw new Error('not configured');const r=await fetch(cfg.cobalt+'/',{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({url,downloadMode:'audio',audioFormat:'best'})});const d=await r.json().catch(()=>({}));
  const media=d.status==='tunnel'||d.status==='redirect'?d.url:d.status==='picker'?(d.audio||d.picker?.find(p=>p.type==='video')?.url):d.status==='local-processing'?(d.audio||d.tunnel?.[0]):null;
  if(!media)throw new Error(d.error?.code||d.status||'http '+r.status);return download(media,join(dir,'cobalt.media'))}
async function viaYtDlp(url,dir){await run('yt-dlp',['-f','bestaudio/best',...ytArgs(),'-o',join(dir,'ytdlp.%(ext)s'),url],{timeout:10*60000});const f=(await readdir(dir)).find(n=>n.startsWith('ytdlp.'));if(!f)throw new Error('no file');return join(dir,f)}
// First extractor whose file ffmpeg can turn into 16 kHz mono WAV wins; a bad or silent-less file falls through to the next one.
async function media(url,dir){const errors=[],wav=join(dir,'audio.wav');for(const[name,fn]of[['cobalt',viaCobalt],['yt-dlp',viaYtDlp]]){try{const file=await fn(url,dir);
  try{await run('ffmpeg',['-y','-v','error','-i',file,'-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav],{timeout:10*60000})}catch(e){throw new Error(`no usable audio (${(await stat(file)).size} bytes): ${(e.stderr||e.message).trim().split('\n')[0]}`)}
  log('audio via',name,Math.round((await stat(wav)).size/32000),'s');return{wav,via:name}}
  catch(e){const why=(e.stderr||'').split('\n').find(l=>l.startsWith('ERROR'))||e.message.split('\n')[0];errors.push(`${name}: ${why}`);log(name,'failed:',why.replace(/https?:\/\/\S+/g,'<url>').slice(0,160))}}return{errors}}

// OCR output → lines that are mostly letters/digits (drops noise).
const ocrLines=s=>s.split('\n').map(l=>l.trim()).filter(l=>l.length>2&&(l.match(/[\p{L}\p{N}]/gu)||[]).length/l.length>0.6);
// Photos and carousel slides → text with Tesseract (rus+eng). Cobalt returns every slide as a "picker" item;
// when it gives at most one (login wall, tracking params), fall back to the slide images yt-dlp listed (needs cookies).
async function slides(url,dir,images=[]){let urls=[];try{if(cfg.cobalt){const clean=url.replace(/\?.*$/,'');// Cobalt is picky about ?img_index=&stkn= params
    const r=await fetch(cfg.cobalt+'/',{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({url:clean,downloadMode:'auto'})});const d=await r.json();
    urls=d.status==='picker'?d.picker.filter(p=>p.type==='photo').map(p=>p.url):(d.status==='tunnel'||d.status==='redirect')&&/\.(jpe?g|png|webp|heic)$/i.test(d.filename||'')?[d.url]:[];
    log('cobalt slides:',d.status,d.error?.code||'',urls.length)}}catch(e){log('cobalt slides skipped:',e.message.slice(0,120))}
  if(urls.length<=1&&images.length>urls.length){urls=images;log('slides from yt-dlp thumbnails:',images.length)}
  const out=[];for(const[i,u]of urls.slice(0,20).entries()){try{const img=await download(u,join(dir,`slide-${i}`));const{stdout}=await run('tesseract',[img,'stdout','-l','rus+eng'],{timeout:120000});
    const t=ocrLines(stdout).join('\n');if(t)out.push(`Slide ${i+1}:\n${t}`)}catch(e){log('slide',i+1,'failed:',e.message.split('\n')[0].slice(0,120))}}
  log('slides',urls.length,'with text',out.length);return{text:out.join('\n\n'),count:urls.length}}

// Videos often show their list, tool names and domains on screen without saying them. Sample up to 40 frames:
// short clips at scene changes (every 2 s if there are few cuts), long videos evenly across the whole duration.
// OCR each frame and keep every line once, in order of appearance.
async function screenText(url,dir){try{await run('yt-dlp',['-f','bv*[height<=1080]/b',...ytArgs(),'-o',join(dir,'video.%(ext)s'),url],{timeout:10*60000});
  const video=(await readdir(dir)).find(n=>n.startsWith('video.'));if(!video)return'';const frames=async()=>(await readdir(dir)).filter(n=>/^(scene|tick)-/.test(n)).sort();
  const dur=Number((await run('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',join(dir,video)]).catch(()=>({stdout:'0'}))).stdout)||0;
  if(dur>150)await run('ffmpeg',['-y','-v','error','-i',join(dir,video),'-vf',`fps=${40/dur},scale=1080:-2`,'-frames:v','40',join(dir,'tick-%03d.png')],{timeout:10*60000});
  else await run('ffmpeg',['-y','-v','error','-i',join(dir,video),'-vf',"select='eq(n\\,0)+gt(scene\\,0.2)',scale=1080:-2",'-fps_mode','vfr','-frames:v','40',join(dir,'scene-%03d.png')],{timeout:5*60000});
  if((await frames()).length<4)await run('ffmpeg',['-y','-v','error','-i',join(dir,video),'-vf','fps=1/2,scale=1080:-2','-frames:v','40',join(dir,'tick-%03d.png')],{timeout:5*60000});
  const seen=new Set(),out=[],list=await frames();for(const f of list){const{stdout}=await run('tesseract',[join(dir,f),'stdout','-l','rus+eng'],{timeout:120000}).catch(()=>({stdout:''}));
    for(const l of ocrLines(stdout)){const k=l.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');if(k.length>2&&!seen.has(k)){seen.add(k);out.push(l)}}}
  log('screen frames',list.length,'lines',out.length);return out.join('\n')}catch(e){log('screen text skipped:',(e.stderr||e.message).split('\n').find(l=>l.startsWith('ERROR'))?.slice(0,160)||e.message.split('\n')[0].slice(0,120));return''}}

// ---------- Transcript + digest ----------
async function transcribe(wav){const{stdout}=await run(cfg.parakeet,['transcribe','--model',cfg.model,'--input',wav],{timeout:60*60000,maxBuffer:64<<20});return stdout.trim()}
async function digest(input){const prompt=`You file saved social posts, videos and articles into a personal knowledge base.
Transcripts are machine-generated: product and brand names may be spelled phonetically — write them correctly.
Return JSON: {"title": short descriptive title (max 90 chars), "summary": 2-4 sentences on what it says, "why_useful": 1-2 sentences on why it could be useful later,
"key_points": the concrete points, steps, tips or list items exactly as the author gives them, in order — one short sentence each, keep names, numbers and specifics (up to 12; if the author says "5 things", return those 5),
"category": one of ${JSON.stringify(CATEGORIES)}, "tags": 3-6 lowercase topic tags, "people": people mentioned, "links": URLs or domains mentioned,
"tools": [{"name": product name as written on its site, "url": its URL or domain if it appears anywhere in the text, transcript or on-screen text — else "", "what": one line in English: what it is and what it is used for, "super_category": one of ${JSON.stringify(SUPER)}, "want": 1-3 of ${JSON.stringify(WANT)}, "pricing": one of ${JSON.stringify(PRICING)} or "" if unknown}]}.
"tools" = only things one can open and use: apps, web services, websites, libraries, plugins, models, extensions. Not the author's own studio or channel, not client brands, not people, not activities or generic categories like "video editing".
A tool must literally appear (its name or domain) in the provided text. If the post promises "7 sites" but names none, return "tools": [] — never fill the list with well-known tools that are not in the text.
OCR text of slides and video frames counts as text: a site or product name written on a slide (e.g. "minimal gallery", "godly design", "klikkenthéke") is a tool even when no domain is shown — return it with "url": "". Slide lists usually name one resource per slide; OCR is noisy, so keep the name as it appears and ignore the noise around it.
Names and domains on screen matter: a domain like "figma.com" on a slide is a tool even if never spoken. Use the exact spelling from on-screen text or URLs over the phonetic transcript spelling.
Write title, summary, why_useful and key_points in ${cfg.lang}. Use [] when nothing fits. Do not invent facts or URLs.`;
  // Streamed: on CPU the prompt can take minutes, and a non-streamed call trips Node's 300 s headers timeout. Input capped so one item stays ~1–2 min.
  const r=await fetch(cfg.ollama+'/api/chat',{method:'POST',body:JSON.stringify({model:cfg.llm,stream:true,format:'json',options:{temperature:0.2,num_ctx:8192},messages:[{role:'system',content:prompt},{role:'user',content:input.slice(0,12000)}]}),signal:AbortSignal.timeout(20*60000)});
  if(!r.ok)throw new Error('ollama '+r.status);let out='';for(const line of(await r.text()).split('\n'))if(line.trim())out+=JSON.parse(line).message?.content||'';const j=JSON.parse(out||'{}');
  // Tools may come back as strings (older prompt / model shortcut) — normalise to objects.
  const all=(Array.isArray(j.tools)?j.tools:[]).map(t=>typeof t==='string'?{name:t}:t).filter(t=>t&&t.name).map(t=>({...t,name:String(t.name).trim().slice(0,100),url:String(t.url||'').trim(),what:String(t.what||'').trim().slice(0,300)}));
  // Hard guard against invented tools: keep only those whose name or domain occurs in the source text.
  const hay=norm(input),raw=input.toLowerCase();
  const tools=all.filter(t=>{const n=norm(t.name),dom=domainOf(t.url);return(n.length>=3&&hay.includes(n))||(dom&&raw.includes(dom))});
  const dropped=all.length-tools.length;if(dropped)log('tools not in source, dropped:',dropped,'of',all.length);
  return{...j,tools,category:CATEGORIES.includes(j.category)?j.category:'Other'}}

// ---------- Resource Catalog ----------
const domainOf=u=>{try{return new URL(/^https?:\/\//i.test(u)?u:'https://'+u).hostname.replace(/^www\./,'').toLowerCase()}catch{return''}};
const norm=s=>String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const pageUrl=id=>'https://www.notion.so/'+id.replace(/-/g,'');
// Name-only tools (named on a slide, no domain shown): best-effort URL from a Bing search (DuckDuckGo serves a bot
// challenge). Bing hides targets in ck/a?…&u=a1<base64url>. Kept only when the result's domain or title echoes the
// name, so a wrong hit is unlikely; the catalog row still says "verify".
async function findUrl(name){try{const r=await fetch('https://www.bing.com/search?cc=US&setlang=en&q='+encodeURIComponent(name),{headers:{'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36','accept-language':'en-US,en'},signal:AbortSignal.timeout(15000)});if(!r.ok)return'';const html=await r.text();
  // The whole name (spaces/punctuation removed) must occur in the result's domain or title; a partial match is not enough.
  const key=norm(name);if(key.length<4)return'';const b64=s=>Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
  const hits=[...html.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map(m=>{const u=/[?&]u=a1([A-Za-z0-9_-]+)/.exec(m[1].replace(/&amp;/g,'&'));return{url:u?b64(u[1]):m[1],title:m[2].replace(/<[^>]+>/g,'')}})
    .filter(h=>/^https?:/.test(h.url)&&!/instagram\.|youtube\.|facebook\.|tiktok\.|wikipedia\.|reddit\.|pinterest\.|linkedin\.|bing\./.test(h.url));
  const top=hits.slice(0,5),hit=top.find(h=>norm(domainOf(h.url)).includes(key))||top.find(h=>norm(h.title).includes(key));return hit?'https://'+domainOf(hit.url):''}catch{return''}}
let catalogDown='';// set once the catalog turns out to be unreachable, so we stop retrying within the run
// Files every tool of a capture into the Resource Catalog as 📥 Inbox (skips ones already there, matched by domain or name).
// Returns rich_text lines for the page body: name → catalog page, added / already there.
async function catalogAdd(tools,captureId){if(!cfg.catalog||catalogDown||!tools.length)return[];const lines=[];
  for(const t of tools.slice(0,10)){try{if(!t.url){const u=await findUrl(t.name);if(u){t.url=u;t.searched=true;log('url by search for',t.name)}}
    const domain=domainOf(t.url),url=domain?'https://'+domain+(t.url.includes('/')&&!/^https?:\/\/[^/]+\/?$/.test(t.url)?new URL(/^https?:\/\//i.test(t.url)?t.url:'https://'+t.url).pathname.replace(/\/$/,''):''):'';
    const filter=domain?{property:'URL',url:{contains:domain}}:{property:'Name',title:{contains:t.name}};
    const found=(await notion(`data_sources/${cfg.catalog}/query`,'POST',{page_size:3,filter})).results.find(r=>domain||plain(r.properties.Name).trim().toLowerCase()===t.name.toLowerCase());
    if(found){lines.push([{type:'text',text:{content:t.name,link:{url:pageUrl(found.id)}}},{type:'text',text:{content:' — уже в каталоге'}}]);continue}
    const live=url?await fetch(url,{method:'HEAD',redirect:'follow',signal:AbortSignal.timeout(10000)}).then(r=>r.ok||r.status===405,()=>false):false;
    const page=await notion('pages','POST',{parent:{type:'data_source_id',data_source_id:cfg.catalog},properties:{Name:{title:text(t.name)},...(url?{URL:{url}}:{}),Description:{rich_text:text(t.what)},'Use it for':{rich_text:text(t.what)},
      Status:{select:{name:'📥 Inbox'}},Link:{select:{name:live?'✅ Live':'❓ Unknown'}},...(SUPER.includes(t.super_category)?{'Super Category':{select:{name:t.super_category}}}:{}),
      'I want to…':{multi_select:opts((Array.isArray(t.want)?t.want:[t.want]).filter(w=>WANT.includes(w)))},...(PRICING.includes(t.pricing)?{Pricing:{select:{name:t.pricing}}}:{}),
      Notes:{rich_text:text(`From Idea Inbox: ${pageUrl(captureId)}`+(t.searched?'\nURL found by web search, not in the source — verify.':url?'':'\nURL not in the source — verify.'))},Keywords:{rich_text:text(t.name.toLowerCase())}}});
    lines.push([{type:'text',text:{content:t.name,link:{url:pageUrl(page.id)}}},{type:'text',text:{content:' — добавлен в каталог'+(t.searched?' (ссылка найдена поиском, проверь)':url?'':' (без ссылки)')}}]);log('catalog +',page.id)}
    catch(e){if(/notion 404|object_not_found|Could not find/i.test(e.message)){catalogDown='Каталог ресурсов не открыт для интеграции Idea Inbox: страница 🧰 Resource Catalog → ••• → Connections → Idea Inbox.';log('catalog unreachable');return lines}
      log('catalog failed:',e.message.slice(0,120))}}
  return lines}

// ---------- Job ----------
async function handle(page,botId){const p=page.properties,id=page.id,title=plain(p.Name);
  const url=(p.URL?.url||(/^https?:\/\//.test(title.trim())?title.trim():'')).trim();const attempts=(p.Attempts?.number||0)+1;
  await update(id,{Status:{select:{name:'Processing'}},Attempts:{number:attempts},Error:{rich_text:[]}});
  const dir=await mkdtemp(join(tmpdir(),'idea-inbox-'));try{if(!url)throw new Error('No URL on this page. Share a link or put it in the URL property.');
  const src=source(url),[meta,page2,m]=await Promise.all([metadata(url),pageText(url),media(url,dir)]);
  const transcript=m.wav?await transcribe(m.wav):'';const caption=meta.caption||page2.caption||'';const article=!transcript&&src==='Web'?page2.article||'':'';
  // Posts that are not Reels (/p/ = photo, carousel or mixed) and Threads posts may carry their text on images.
  const sl=(/instagram\.com\/p\//.test(url)||src==='Threads'||!m.wav)&&src!=='Web'?await slides(url,dir,meta.images||[]):{text:'',count:0},slideText=sl.text;
  // Every video, not only Reels: read what is shown on screen (lists, tool names and domains are often only there).
  const isVideo=!!m.wav||/instagram\.com\/(reels?|tv)\//.test(url)||src==='Threads'||src==='YouTube';
  const screen=isVideo&&src!=='Web'?await screenText(url,dir):'';
  if(!transcript&&!caption&&!article&&!slideText&&!screen)throw new Error('Nothing extracted. '+(m.errors||[]).join('; '));
  // Say what is missing instead of calling a thin page "Done".
  const gated=/\bcomment\s+["“'«]?[\w-]+["”'»]?\s+(for|to get|and)\b|коммент\S*\s+["«“]?\S+["»”]?\s+(и|чтобы|для)(?=\s)/i.test(caption);
  const missing=[isVideo&&!m.wav&&!screen&&'Видео не скачалось, речь и текст на экране не прочитаны. '+(m.errors||[]).join('; ').replace(/https?:\/\/\S+/g,'<url>'),
    src==='Instagram'&&!m.wav&&sl.count<=1&&`Из карусели получено слайдов: ${sl.count}. Остальные закрыты логином Instagram.`,
    gated&&'Автор выдаёт полный список по комментарию в DM: в самом посте его может не быть.'].filter(Boolean);
  // On-screen and slide text go before the transcript: the digest input is capped, and tool names/domains live there.
  const input=[`Source: ${src}`,`URL: ${url}`,meta.author&&`Author: ${meta.author}`,(meta.title||page2.title)&&`Original title: ${meta.title||page2.title}`,caption&&`Post text:\n${caption}`,screen&&`Text on screen (OCR of video frames):\n${screen.slice(0,4000)}`,slideText&&`Text on images (OCR):\n${slideText.slice(0,4000)}`,transcript&&`Transcript:\n${transcript}`,article&&`Article:\n${article}`,
    gated&&'Note: the author gives the full list only by comment/DM. Do not invent the missing items; say that the list is not in the post.'].filter(Boolean).join('\n\n');
  const d=await digest(input);const links=[...new Set([...(d.links||[]),...(caption.match(/https?:\/\/\S+/g)||[]),...d.tools.map(t=>t.url).filter(Boolean)])];
  const catalog=await catalogAdd(d.tools,id);const warnings=[...missing,catalogDown].filter(Boolean);
  // Catalog verdict for the board: filed / nothing to file / needs a second pass (content incomplete or catalog unreachable).
  const added=catalog.filter(l=>l[1].text.content.includes('добавлен')).map(l=>l[0].text.content),were=catalog.filter(l=>l[1].text.content.includes('уже')).map(l=>l[0].text.content);
  const verdict=d.tools.length&&!catalogDown&&!missing.length?'✅ В каталоге':d.tools.length||missing.length||gated?'🔁 Второй проход':'⚪ Не про инструменты';
  const catalogNote=[added.length&&`В каталоге: ${added.join(', ')}.`,were.length&&`Уже были: ${were.join(', ')}.`,!d.tools.length&&!missing.length&&'Конкретных инструментов в посте нет.',...warnings].filter(Boolean).join(' ');
  await update(id,{Name:{title:text(d.title||meta.title||page2.title||title||url)},URL:{url},Status:{select:{name:missing.length?'Partial':'Done'}},Source:{select:{name:src}},Category:{select:{name:d.category}},
    Author:{rich_text:text(meta.author||page2.author||'')},...(meta.published?{Published:{date:{start:meta.published}}}:{}),Summary:{rich_text:text(d.summary)},'Why useful':{rich_text:text(d.why_useful)},
    Tags:{multi_select:opts(d.tags)},Tools:{multi_select:opts(d.tools.map(t=>t.name))},People:{multi_select:opts(d.people)},Links:{rich_text:text(links.join('\n'))},Error:{rich_text:text(warnings.join('\n'))},Catalog:{select:{name:verdict}},'Catalog note':{rich_text:text(catalogNote.slice(0,1900))}});
  await writeBody(id,botId,[['Не получено',warnings],['Key points',Array.isArray(d.key_points)?d.key_points.filter(Boolean):[]],['Summary',[d.summary,d.why_useful].filter(Boolean).join('\n\n')],['Инструменты',d.tools.map(t=>[t.name,t.url,t.what].filter(Boolean).join(' — '))],['Каталог ресурсов',catalog],['Post text',caption],['Transcript',transcript||(m.wav?'No speech detected.':'')],['Slides text',slideText],['Text on screen',screen],['Article text',article]],url);
  log(id,missing.length?'partial':'done',m.via||'text-only',transcript.length,'chars',screen.length,'screen chars',d.tools.length,'tools',catalog.length,'catalog')}
  catch(e){const retry=attempts<cfg.maxAttempts;await update(id,{Status:{select:{name:retry?'New':'Error'}},Error:{rich_text:text(String(e.message).slice(0,1900))}}).catch(()=>{});log(id,retry?'failed, will retry':'failed')}
  finally{await rm(dir,{recursive:true,force:true})}}

if(!cfg.token||!cfg.ds){console.error('NOTION_TOKEN and NOTION_DATA_SOURCE_ID are required');process.exit(1)}
// Same request the iOS Shortcut sends (docs/ios-shortcut.md), so the Shortcut body can be tested from the workflow.
const addUrl=process.argv[process.argv.indexOf('--add')+1];if(process.argv.includes('--add')){const p=await notion('pages','POST',{parent:{type:'data_source_id',data_source_id:cfg.ds},properties:{Name:{title:[{text:{content:addUrl}}]},URL:{url:addUrl},Status:{select:{name:'New'}}}});log('added',p.id);process.exit(0)}
if(process.argv.includes('--count')){console.log((await pending()).length);process.exit(0)}
if(!cfg.model){console.error('PARAKEET_MODEL is required');process.exit(1)}
const botId=(await notion('users/me')).id,start=Date.now();let done=0;const queue=await pending(cfg.maxItems);
for(const[i,page]of queue.entries()){if(Date.now()-start>cfg.budgetMs)break;await handle(page,botId);done++;
  // Be gentle with Instagram when draining a backlog; no pause after the last item.
  if(i<queue.length-1&&source(page.properties.URL?.url||plain(page.properties.Name))==='Instagram')await sleep(Number(env.INSTAGRAM_DELAY_SEC||20)*1000)}
log('processed',done)
