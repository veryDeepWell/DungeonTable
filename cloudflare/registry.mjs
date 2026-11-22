const TTL=45_000;
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export default {async fetch(request,env){
 const origin=request.headers.get('Origin'),allowed=origin===env.CLIENT_ORIGIN;
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:allowed?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, OPTIONS','Vary':'Origin'}:{}});
 if(new URL(request.url).pathname!=='/host')return json({error:'Not found'},404);
 if(request.method!=='GET'&&(!env.HOST_KEY||request.headers.get('Authorization')!=='Bearer '+env.HOST_KEY))return json({error:'Unauthorized'},401);
 if(!['GET','PUT','DELETE'].includes(request.method))return json({error:'Method not allowed'},405);
 const response=await env.REGISTRY.get(env.REGISTRY.idFromName('dungeon-table-host')).fetch(request);
 if(!allowed)return response;const headers=new Headers(response.headers);headers.set('Access-Control-Allow-Origin',origin);headers.set('Vary','Origin');return new Response(response.body,{status:response.status,headers});
}};
export class DungeonRegistry{
 constructor(ctx){this.sql=ctx.storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS host (id INTEGER PRIMARY KEY CHECK(id=1), session TEXT NOT NULL, origin TEXT NOT NULL, expires INTEGER NOT NULL)')}
 async fetch(request){
 if(request.method==='GET'){const [row]=this.sql.exec('SELECT origin FROM host WHERE expires > ?',Date.now());return json({origin:row?.origin||null})}
 let data;try{data=await request.json()}catch{return json({error:'Invalid JSON'},400)}
 if(!/^[a-f0-9]{32}$/.test(data?.session||''))return json({error:'Invalid session'},400);
 if(request.method==='DELETE'){this.sql.exec('DELETE FROM host WHERE session=?',data.session);return json({ok:true})}
 if(!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(data.origin||''))return json({error:'Invalid tunnel address'},400);
 const now=Date.now(),[active]=this.sql.exec('SELECT session FROM host WHERE expires > ?',now);
 if(active&&active.session!==data.session)return json({error:'Another host is already online'},409);
 this.sql.exec('INSERT OR REPLACE INTO host VALUES(1,?,?,?)',data.session,data.origin,now+TTL);return json({ok:true});
 }
}
