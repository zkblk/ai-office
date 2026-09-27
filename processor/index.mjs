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
async function writeBody(id,botId,sections,url){let cursor;do{const d=await notion(`blocks/${id}/children?page_size=100${cursor?'&start_cursor='+cursor:''}`);for(const b of d.results)if(b.created_by?.id===botId)await notion('blocks/'+b.id,'DELETE');cursor=d.has_more&&d.next_cursor}while(cursor);
// A section body is either text (→ paragraphs) or an array (→ bullet list).
// First line of every page: a clickable link to the original post/video/article.
const blocks=url?[{type:'paragraph',paragraph:{rich_text:[{type:'text',text:{content:'🔗 Оригинал: '}},{type:'text',text:{content:url.slice(0,1900),link:{url}}}]}}]:[];for(const[h,body]of sections){if(!body?.length)continue;blocks.push({type:'heading_2',heading_2:{rich_text:text(h)}});
  if(Array.isArray(body))for(const item of body)blocks.push({type:'bulleted_list_item',bulleted_list_item:{rich_text:text(String(item).slice(0,1900))}});
  else for(const chunk of paragraphs(body))blocks.push({type:'paragraph',paragraph:{rich_text:text(chunk)}})}
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
// First extractor whose file ffmpeg can turn into 16 kHz mono WAV wins; a bad or silent-less file falls through to the next one.
async function media(url,dir){const errors=[],wav=join(dir,'audio.wav');for(const[name,fn]of[['cobalt',viaCobalt],['yt-dlp',viaYtDlp]]){try{const file=await fn(url,dir);
  try{await run('ffmpeg',['-y','-v','error','-i',file,'-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav],{timeout:10*60000})}catch(e){throw new Error(`no usable audio (${(await stat(file)).size} bytes): ${(e.stderr||e.message).trim().split('\n')[0]}`)}
  log('audio via',name,Math.round((await stat(wav)).size/32000),'s');return{wav,via:name}}
  catch(e){const why=(e.stderr||'').split('\n').find(l=>l.startsWith('ERROR'))||e.message.split('\n')[0];errors.push(`${name}: ${why}`);log(name,'failed:',why.replace(/https?:\/\/\S+/g,'<url>').slice(0,160))}}return{errors}}

// OCR output → lines that are mostly letters/digits (drops noise).
const ocrLines=s=>s.split('\n').map(l=>l.trim()).filter(l=>l.length>2&&(l.match(/[\p{L}\p{N}]/gu)||[]).length/l.length>0.6);
// Photos and carousel slides → text with Tesseract (rus+eng). Cobalt returns every slide as a "picker" item.
async function slides(url,dir){try{const r=await fetch(cfg.cobalt+'/',{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({url,downloadMode:'auto'})});const d=await r.json();
  const urls=d.status==='picker'?d.picker.filter(p=>p.type==='photo').map(p=>p.url):(d.status==='tunnel'||d.status==='redirect')&&/\.(jpe?g|png|webp|heic)$/i.test(d.filename||'')?[d.url]:[];
  const out=[];for(const[i,u]of urls.slice(0,20).entries()){try{const img=await download(u,join(dir,`slide-${i}`));const{stdout}=await run('tesseract',[img,'stdout','-l','rus+eng'],{timeout:120000});
    const t=ocrLines(stdout).join('\n');if(t)out.push(`Slide ${i+1}:\n${t}`)}catch(e){log('slide',i+1,'failed:',e.message.split('\n')[0].slice(0,120))}}
  log('slides',urls.length,'with text',out.length);return{text:out.join('\n\n'),count:urls.length}}catch(e){log('slides skipped:',e.message.slice(0,120));return{text:'',count:0}}}

// Reels often show their list on screen without saying it. Sample frames at scene changes (every 2 s if the video
// has few cuts), OCR each and keep every line once, in order of appearance.
async function screenText(url,dir){try{await run('yt-dlp',['-f','bv*[height<=1080]/b',...ytArgs(),'-o',join(dir,'video.%(ext)s'),url],{timeout:10*60000});
  const video=(await readdir(dir)).find(n=>n.startsWith('video.'));if(!video)return'';const frames=async()=>(await readdir(dir)).filter(n=>/^(scene|tick)-/.test(n)).sort();
  await run('ffmpeg',['-y','-v','error','-i',join(dir,video),'-vf',"select='eq(n\\,0)+gt(scene\\,0.2)',scale=1080:-2",'-fps_mode','vfr','-frames:v','40',join(dir,'scene-%03d.png')],{timeout:5*60000});
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
"category": one of ${JSON.stringify(CATEGORIES)}, "tags": 3-6 lowercase topic tags, "tools": names of specific products, apps, services or companies (proper nouns only — never activities, techniques or generic categories like "video editing"), "people": people mentioned, "links": URLs or domains mentioned}.
Write title, summary, why_useful and key_points in ${cfg.lang}. Use [] when nothing fits. Do not invent facts.`;
  // Streamed: on CPU the prompt can take minutes, and a non-streamed call trips Node's 300 s headers timeout. Input capped so one item stays ~1–2 min.
  const r=await fetch(cfg.ollama+'/api/chat',{method:'POST',body:JSON.stringify({model:cfg.llm,stream:true,format:'json',options:{temperature:0.2,num_ctx:8192},messages:[{role:'system',content:prompt},{role:'user',content:input.slice(0,12000)}]}),signal:AbortSignal.timeout(20*60000)});
  if(!r.ok)throw new Error('ollama '+r.status);let out='';for(const line of(await r.text()).split('\n'))if(line.trim())out+=JSON.parse(line).message?.content||'';const j=JSON.parse(out||'{}');return{...j,category:CATEGORIES.includes(j.category)?j.category:'Other'}}

// ---------- Job ----------
async function handle(page,botId){const p=page.properties,id=page.id,title=plain(p.Name);
  const url=(p.URL?.url||(/^https?:\/\//.test(title.trim())?title.trim():'')).trim();const attempts=(p.Attempts?.number||0)+1;
  await update(id,{Status:{select:{name:'Processing'}},Attempts:{number:attempts},Error:{rich_text:[]}});
  const dir=await mkdtemp(join(tmpdir(),'idea-inbox-'));try{if(!url)throw new Error('No URL on this page. Share a link or put it in the URL property.');
  const src=source(url),[meta,page2,m]=await Promise.all([metadata(url),pageText(url),media(url,dir)]);
  const transcript=m.wav?await transcribe(m.wav):'';const caption=meta.caption||page2.caption||'';const article=!transcript&&src==='Web'?page2.article||'':'';
  // Posts that are not Reels (/p/ = photo, carousel or mixed) and Threads posts may carry their text on images.
  const sl=cfg.cobalt&&(/instagram\.com\/p\//.test(url)||src==='Threads'||!m.wav)&&src!=='Web'?await slides(url,dir):{text:'',count:0},slideText=sl.text;
  // Short social videos: also read what is shown on screen (lists, tool names and URLs are often only there).
  const isVideo=/instagram\.com\/(reels?|tv)\//.test(url)||src==='Threads'||/youtube\.com\/shorts\//.test(url);
  const screen=isVideo?await screenText(url,dir):'';
  if(!transcript&&!caption&&!article&&!slideText&&!screen)throw new Error('Nothing extracted. '+(m.errors||[]).join('; '));
  // Say what is missing instead of calling a thin page "Done".
  const gated=/\bcomment\s+["“'«]?[\w-]+["”'»]?\s+(for|to get|and)\b|коммент\S*\s+["«“]?\S+["»”]?\s+(и|чтобы|для)(?=\s)/i.test(caption);
  const missing=[isVideo&&!m.wav&&!screen&&'Видео не скачалось, речь и текст на экране не прочитаны. '+(m.errors||[]).join('; ').replace(/https?:\/\/\S+/g,'<url>'),
    src==='Instagram'&&!m.wav&&sl.count<=1&&`Из карусели получено слайдов: ${sl.count}. Остальные закрыты логином Instagram.`,
    gated&&'Автор выдаёт полный список по комментарию в DM: в самом посте его может не быть.'].filter(Boolean);
  const input=[`Source: ${src}`,`URL: ${url}`,meta.author&&`Author: ${meta.author}`,(meta.title||page2.title)&&`Original title: ${meta.title||page2.title}`,caption&&`Post text:\n${caption}`,transcript&&`Transcript:\n${transcript}`,slideText&&`Text on images (OCR):\n${slideText}`,screen&&`Text on screen (OCR of video frames):\n${screen}`,article&&`Article:\n${article}`,
    gated&&'Note: the author gives the full list only by comment/DM. Do not invent the missing items; say that the list is not in the post.'].filter(Boolean).join('\n\n');
  const d=await digest(input);const links=[...new Set([...(d.links||[]),...(caption.match(/https?:\/\/\S+/g)||[])])];
  await update(id,{Name:{title:text(d.title||meta.title||page2.title||title||url)},URL:{url},Status:{select:{name:missing.length?'Partial':'Done'}},Source:{select:{name:src}},Category:{select:{name:d.category}},
    Author:{rich_text:text(meta.author||page2.author||'')},...(meta.published?{Published:{date:{start:meta.published}}}:{}),Summary:{rich_text:text(d.summary)},'Why useful':{rich_text:text(d.why_useful)},
    Tags:{multi_select:opts(d.tags)},Tools:{multi_select:opts(d.tools)},People:{multi_select:opts(d.people)},Links:{rich_text:text(links.join('\n'))},Error:{rich_text:text(missing.join('\n'))}});
  await writeBody(id,botId,[['Не получено',missing],['Key points',Array.isArray(d.key_points)?d.key_points.filter(Boolean):[]],['Summary',[d.summary,d.why_useful].filter(Boolean).join('\n\n')],['Post text',caption],['Transcript',transcript||(m.wav?'No speech detected.':'')],['Slides text',slideText],['Text on screen',screen],['Article text',article]],url);
  log(id,missing.length?'partial':'done',m.via||'text-only',transcript.length,'chars',screen.length,'screen chars')}
  catch(e){const retry=attempts<cfg.maxAttempts;await update(id,{Status:{select:{name:retry?'New':'Error'}},Error:{rich_text:text(String(e.message).slice(0,1900))}}).catch(()=>{});log(id,retry?'failed, will retry':'failed')}
  finally{await rm(dir,{recursive:true,force:true})}}

if(!cfg.token||!cfg.ds){console.error('NOTION_TOKEN and NOTION_DATA_SOURCE_ID are required');process.exit(1)}
// Same request the iOS Shortcut sends (docs/ios-shortcut.md), so the Shortcut body can be tested from the workflow.
const addUrl=process.argv[process.argv.indexOf('--add')+1];if(process.argv.includes('--add')){const p=await notion('pages','POST',{parent:{type:'data_source_id',data_source_id:cfg.ds},properties:{Name:{title:[{text:{content:addUrl}}]},URL:{url:addUrl},Status:{select:{name:'New'}}}});log('added',p.id);process.exit(0)}
if(process.argv.includes('--count')){console.log((await pending()).length);process.exit(0)}
if(!cfg.model){console.error('PARAKEET_MODEL is required');process.exit(1)}
const botId=(await notion('users/me')).id,start=Date.now();let done=0;
for(const page of await pending(cfg.maxItems)){if(Date.now()-start>cfg.budgetMs)break;await handle(page,botId);done++;
  // Be gentle with Instagram when draining an old backlog.
  if(source(page.properties.URL?.url||plain(page.properties.Name))==='Instagram')await sleep(Number(env.INSTAGRAM_DELAY_SEC||20)*1000)}
log('processed',done)
