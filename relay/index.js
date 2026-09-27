// Notion webhook → GitHub workflow_dispatch. Makes a new Idea Inbox row start processing immediately
// instead of waiting for the (unreliable) cron schedule. No storage, no UI.
// Secrets: GITHUB_TOKEN (fine-grained, Actions: read & write on zkblk/ai-office),
//          NOTION_VERIFICATION_TOKEN (shown once when the Notion webhook subscription is verified).
const DISPATCH="https://api.github.com/repos/zkblk/ai-office/actions/workflows/idea-inbox.yml/dispatches";
const hex=buf=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
// NOTION_VERIFICATION_TOKEN may hold several comma-separated tokens (one per subscription / re-verification).
async function signed(env,body,header){if(!env.NOTION_VERIFICATION_TOKEN)return true;
  for(const t of env.NOTION_VERIFICATION_TOKEN.split(",")){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(t.trim()),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    if(header==="sha256="+hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body))))return true}
  console.log("bad signature");return false}
export default{async fetch(request,env,ctx){
  if(request.method!=="POST")return new Response("idea-inbox relay ok");
  const body=await request.text();let event;try{event=JSON.parse(body)}catch{return new Response("bad json",{status:400})}
  // One-time handshake: Notion posts a verification token that has to be pasted back into the Notion UI. Read it with `wrangler tail`.
  if(event.verification_token){console.log("NOTION VERIFICATION TOKEN:",event.verification_token);return new Response("ok")}
  if(!await signed(env,body,request.headers.get("x-notion-signature")))return new Response("bad signature",{status:401});
  if(event.type!=="page.created")return new Response("ignored");
  ctx.waitUntil(fetch(DISPATCH,{method:"POST",headers:{authorization:"Bearer "+env.GITHUB_TOKEN,accept:"application/vnd.github+json","user-agent":"idea-inbox-relay","content-type":"application/json"},body:JSON.stringify({ref:"main"})})
    .then(async r=>console.log("dispatch",r.status,r.ok?"":await r.text())));
  return new Response("queued")}};
