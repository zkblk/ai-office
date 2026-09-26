#!/usr/bin/env node
// Imports old Instagram Saved into the Notion queue. Input: the JSON export from
// Instagram → Accounts Center → Your information and permissions → Download your information → Saved (JSON).
// Usage: NOTION_TOKEN=… NOTION_DATA_SOURCE_ID=… node processor/import-instagram.mjs <export folder or saved_posts.json> [--dry-run]
import{readFile,readdir,stat}from'node:fs/promises';import{join}from'node:path';
const env=process.env,[target]=process.argv.slice(2).filter(a=>!a.startsWith('--')),dry=process.argv.includes('--dry-run');
if(!target||(!dry&&(!env.NOTION_TOKEN||!env.NOTION_DATA_SOURCE_ID))){console.error('usage: NOTION_TOKEN=… NOTION_DATA_SOURCE_ID=… node processor/import-instagram.mjs <path> [--dry-run]');process.exit(1)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function notion(path,method='GET',body){for(let i=0;;i++){const r=await fetch((env.NOTION_API||'https://api.notion.com/v1/')+path,{method,headers:{authorization:'Bearer '+env.NOTION_TOKEN,'notion-version':'2025-09-03','content-type':'application/json'},body:body&&JSON.stringify(body)});
if(r.status===429&&i<5){await sleep(Number(r.headers.get('retry-after')||1)*1000);continue}const d=await r.json();if(!r.ok)throw new Error(`notion ${r.status}: ${d.message}`);return d}}
async function files(p){if(!(await stat(p)).isDirectory())return[p];const out=[];for(const e of await readdir(p,{withFileTypes:true}))out.push(...(e.isDirectory()?await files(join(p,e.name)):/saved.*\.json$/i.test(e.name)?[join(p,e.name)]:[]));return out}
// The export format has changed over the years, so walk the JSON and pick up any post/reel link with its nearest author name and timestamp.
function collect(node,found,ctx={}){if(Array.isArray(node))return node.forEach(n=>collect(n,found,ctx));if(!node||typeof node!=='object')return;
const here={...ctx,...(typeof node.title==='string'&&node.title?{author:node.title}:{}),...(typeof node.timestamp==='number'?{ts:node.timestamp}:{})};
for(const v of Object.values(node)){if(typeof v==='string'&&/instagram\.com\/(p|reel|reels|tv)\//.test(v))found.set(v.split('?')[0].replace(/\/?$/,'/'),{...here});else collect(v,found,here)}}
const found=new Map();for(const f of await files(target))collect(JSON.parse(await readFile(f,'utf8')),found);
console.log(`found ${found.size} saved posts`);if(dry){for(const[u,m]of[...found].slice(0,5))console.log(' ',u,m.author||'',m.ts?new Date(m.ts*1000).toISOString().slice(0,10):'');process.exit(0)}
// Skip links already in the database.
const existing=new Set();let cursor;do{const d=await notion(`data_sources/${env.NOTION_DATA_SOURCE_ID}/query`,'POST',{page_size:100,...(cursor?{start_cursor:cursor}:{})});d.results.forEach(p=>p.properties.URL?.url&&existing.add(p.properties.URL.url.split('?')[0].replace(/\/?$/,'/')));cursor=d.has_more&&d.next_cursor}while(cursor);
let added=0;for(const[url,m]of[...found].sort((a,b)=>(a[1].ts||0)-(b[1].ts||0))){if(existing.has(url))continue;
await notion('pages','POST',{parent:{type:'data_source_id',data_source_id:env.NOTION_DATA_SOURCE_ID},properties:{Name:{title:[{text:{content:'Instagram'+(m.author?' · '+m.author:'')}}]},URL:{url},Status:{select:{name:'New'}},Source:{select:{name:'Instagram'}},Author:{rich_text:m.author?[{text:{content:m.author}}]:[]}}});
added++;if(added%25===0)console.log('added',added);await sleep(350)}
console.log(`added ${added}, skipped ${found.size-added} already present`)
