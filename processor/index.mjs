#!/usr/bin/env node
// Idea Inbox processor. Notion is the queue and the output:
// rows with empty/New status → media (Cobalt → yt-dlp) → transcript (parakeet.cpp) → summary/tags (Ollama) → back to the same Notion page.
// Runs in GitHub Actions (.github/workflows/idea-inbox.yml). The repo is public, so logs carry page ids only — never URLs or content.
// Usage: node processor/index.mjs            process the queue
//        node processor/index.mjs --count    print number of pending rows
import{execFile}from'node:child_process';import{promisify}from'node:util';import{mkdtemp,readdir,rm,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
const run=promisify(execFile),env=process.env;
const cfg={token:env.NOTION_TOKEN,ds:env.NOTION_DATA_SOURCE_ID,cobalt:(env.COBALT_URL||'').replace(/\/$/,''),parakeet:env.PARAKEET_CLI||'parakeet-cli',model:env.PARAKEET_MODEL,
  ollama:(env.OLLAMA_URL||'http://localhost:11434').replace(/\/$/,''),llm:env.LLM_MODEL||'qwen2.5:7b',lang:env.SUMMARY_LANGUAGE||'the same language as the content',
  ytCookies:env.YTDLP_COOKIES_FILE,maxItems:Number(env.MAX_ITEMS||15),budgetMs:Number(env.TIME_BUDGET_MIN||45)*60000,maxAttempts:3};
const CATEGORIES=(env.CATEGORIES||'AI tools,Design & UX,Development,Product,Marketing,Business,Productivity,Career,Finance,Health,Lifestyle,Other').split(',');
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
async function writeBody(id,botId,sections){let cursor;do{const d=await notion(`blocks/${id}/children?page_size=100${cursor?'&start_cursor='+cursor:''}`);for(const b of d.results)if(b.created_by?.id===botId)await notion('blocks/'+b.id,'DELETE');cursor=d.has_more&&d.next_cursor}while(cursor);
const blocks=[];for(const[h,body]of sections){if(!body)continue;blocks.push({type:'heading_2',heading_2:{rich_text:text(h)}});for(const chunk of paragraphs(body))blocks.push({type:'paragraph',paragraph:{rich_text:text(chunk)}})}
for(let i=0;i<blocks.length;i+=100)await notion(`blocks/${id}/children`,'PATCH',{children:blocks.slice(i,i+100)})}
// ~1800-char paragraphs split on sentence boundaries so Notion stays readable and under its 2000-char limit.
function paragraphs(s){const out=[];let cur='';for(const part of String(s).split(/(?<=[.!?…])\s+|\n+/)){if((cur+' '+part).length>1800&&cur){out.push(cur);cur=''}cur=cur?cur+' '+part:part}if(cur)out.push(cur);return out.flatMap(p=>p.match(/[\s\S]{1,1900}/g)||[])}

// ---------- Extraction ----------
const source=u=>/instagram\.com/.test(u)?'Instagram':/threads\.(net|com)/.test(u)?'Threads':/youtu\.?be/.test(u)?'YouTube':/linkedin\.com/.test(u)?'LinkedIn':'Web';
const ytArgs=()=>['--no-warnings','--no-playlist','--quiet',...(cfg.ytCookies?['--cookies',cfg.ytCookies]:[])];
async function metadata(url){try{const{stdout}=await run('yt-dlp',['-J','--skip-download',...ytArgs(),url],{timeout:90000,maxBuffer:64<<20});const j=JSON.parse(stdout),d=j.upload_date;
  return{title:j.title||'',author:j.uploader||j.channel||j.creator||'',caption:j.description||'',published:d?`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`:''}}catch{return{}}}
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
async function media(url,dir){const errors=[];for(const[name,fn]of[['cobalt',viaCobalt],['yt-dlp',viaYtDlp]]){try{return{file:await fn(url,dir),via:name}}catch(e){errors.push(`${name}: ${(e.stderr||'').split('\n').find(l=>l.startsWith('ERROR'))||e.message.split('\n')[0]}`)}}return{errors}}

// ---------- Transcript + digest ----------
async function transcribe(file,dir){const wav=join(dir,'audio.wav');
  // Videos without an audio track (or photo posts) make ffmpeg fail — treat as "no speech", not as an error.
  try{await run('ffmpeg',['-y','-v','error','-i',file,'-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav],{timeout:10*60000})}catch{return''}
  const{stdout}=await run(cfg.parakeet,['transcribe','--model',cfg.model,'--input',wav],{timeout:60*60000,maxBuffer:64<<20});return stdout.trim()}
async function digest(input){const prompt=`You file saved social posts, videos and articles into a personal knowledge base.
Transcripts are machine-generated: product and brand names may be spelled phonetically — write them correctly.
Return JSON: {"title": short descriptive title (max 90 chars), "summary": 2-4 sentences on what it says, "why_useful": 1-2 sentences on why it could be useful later,
"category": one of ${JSON.stringify(CATEGORIES)}, "tags": 3-6 lowercase topic tags, "tools": products/tools/services/companies mentioned, "people": people mentioned, "links": URLs or domains mentioned}.
Write title, summary and why_useful in ${cfg.lang}. Use [] when nothing fits. Do not invent facts.`;
  const r=await fetch(cfg.ollama+'/api/chat',{method:'POST',body:JSON.stringify({model:cfg.llm,stream:false,format:'json',options:{temperature:0.2,num_ctx:16384},messages:[{role:'system',content:prompt},{role:'user',content:input.slice(0,40000)}]}),signal:AbortSignal.timeout(20*60000)});
  if(!r.ok)throw new Error('ollama '+r.status);const j=JSON.parse((await r.json()).message?.content||'{}');return{...j,category:CATEGORIES.includes(j.category)?j.category:'Other'}}

// ---------- Job ----------
async function handle(page,botId){const p=page.properties,id=page.id,title=plain(p.Name);
  const url=(p.URL?.url||(/^https?:\/\//.test(title.trim())?title.trim():'')).trim();const attempts=(p.Attempts?.number||0)+1;
  await update(id,{Status:{select:{name:'Processing'}},Attempts:{number:attempts},Error:{rich_text:[]}});
  const dir=await mkdtemp(join(tmpdir(),'idea-inbox-'));try{if(!url)throw new Error('No URL on this page. Share a link or put it in the URL property.');
  const src=source(url),[meta,page2,m]=await Promise.all([metadata(url),pageText(url),media(url,dir)]);
  const transcript=m.file?await transcribe(m.file,dir):'';const caption=meta.caption||page2.caption||'';const article=!transcript&&src==='Web'?page2.article||'':'';
  if(!transcript&&!caption&&!article)throw new Error('Nothing extracted. '+(m.errors||[]).join('; '));
  const input=[`Source: ${src}`,`URL: ${url}`,meta.author&&`Author: ${meta.author}`,(meta.title||page2.title)&&`Original title: ${meta.title||page2.title}`,caption&&`Post text:\n${caption}`,transcript&&`Transcript:\n${transcript}`,article&&`Article:\n${article}`].filter(Boolean).join('\n\n');
  const d=await digest(input);const links=[...new Set([...(d.links||[]),...(caption.match(/https?:\/\/\S+/g)||[])])];
  await update(id,{Name:{title:text(d.title||meta.title||page2.title||title||url)},URL:{url},Status:{select:{name:'Done'}},Source:{select:{name:src}},Category:{select:{name:d.category}},
    Author:{rich_text:text(meta.author||page2.author||'')},...(meta.published?{Published:{date:{start:meta.published}}}:{}),Summary:{rich_text:text(d.summary)},'Why useful':{rich_text:text(d.why_useful)},
    Tags:{multi_select:opts(d.tags)},Tools:{multi_select:opts(d.tools)},People:{multi_select:opts(d.people)},Links:{rich_text:text(links.join('\n'))}});
  await writeBody(id,botId,[['Summary',[d.summary,d.why_useful].filter(Boolean).join('\n\n')],['Post text',caption],['Transcript',transcript||(m.file?'No speech detected.':'')],['Article text',article]]);
  log(id,'done',m.via||'text-only',transcript.length,'chars')}
  catch(e){const retry=attempts<cfg.maxAttempts;await update(id,{Status:{select:{name:retry?'New':'Error'}},Error:{rich_text:text(String(e.message).slice(0,1900))}}).catch(()=>{});log(id,retry?'failed, will retry':'failed')}
  finally{await rm(dir,{recursive:true,force:true})}}

if(!cfg.token||!cfg.ds){console.error('NOTION_TOKEN and NOTION_DATA_SOURCE_ID are required');process.exit(1)}
if(process.argv.includes('--count')){console.log((await pending()).length);process.exit(0)}
if(!cfg.model){console.error('PARAKEET_MODEL is required');process.exit(1)}
const botId=(await notion('users/me')).id,start=Date.now();let done=0;
for(const page of await pending(cfg.maxItems)){if(Date.now()-start>cfg.budgetMs)break;await handle(page,botId);done++;
  // Be gentle with Instagram when draining an old backlog.
  if(source(page.properties.URL?.url||plain(page.properties.Name))==='Instagram')await sleep(Number(env.INSTAGRAM_DELAY_SEC||20)*1000)}
log('processed',done)
