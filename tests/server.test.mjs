import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server/main.mjs';
import {createCampaign,uid} from '../src/core.mjs';

test('real HTTP rooms: auth, private views, commands, conflicts, persistence and replay',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'dt-test-'));
 let app=createServer({dataDir,adminKey:'test-admin'});let origin;
 async function start(){await new Promise(r=>app.server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+app.server.address().port}
 await start();t.after(async()=>{if(app.server.listening)await app.close()});
 async function api(path,{method='GET',key,body,headers={}}={}){const response=await fetch(origin+path,{method,headers:{...headers,...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()}}
 assert.equal((await api('/data/admin-key.txt')).status,404);
 assert.equal((await api('/api/lobby/status',{headers:{Origin:'https://evil.example'}})).status,403);
 const input={room:'test-room',password:'test-pass',name:'ГМ',campaign:createCampaign()};
 assert.equal((await api('/api/lobby',{method:'POST',body:input})).status,403);
 const created=await api('/api/lobby',{method:'POST',body:input,key:'test-admin'});assert.equal(created.status,201);const room=created.body;
 assert.equal((await api('/api/lobby/join',{method:'POST',body:{room:input.room,password:'bad!',name:'Плохой'}})).status,403);
 const joined=await api('/api/lobby/join',{method:'POST',body:{room:input.room,password:input.password,name:'Игрок',role:'gm'}});assert.equal(joined.status,201);const player=joined.body;assert.equal(player.user.role,'player');
 const root='/api/lobby/'+room.id;
 const initial=await api(root+'/state',{key:room.key});assert.equal(initial.status,200);const actor=initial.body.state.actors[0],other=initial.body.state.actors[1],potion=initial.body.state.items.find(i=>i.type==='potion');
 const cmd=(command,key=room.key,id=uid())=>api(root+'/command',{method:'POST',key,body:{id,command}});
 assert.equal((await cmd({type:'assign',data:{actor:actor.id,owner:player.user.id}})).status,200);
 const pv=await api(root+'/state',{key:player.key});assert.equal(pv.body.state.actors.find(a=>a.id===other.id).hp,undefined);
 assert.equal((await api(root+'/export',{key:player.key})).status,403);
 assert.equal((await cmd({type:'actorEdit',data:{actor:other.id,name:'hacked'}},player.key)).status,403);
 assert.equal((await cmd({type:'combatStart',data:{participants:[{actor:actor.id,side:'party'}]}},player.key)).status,403);
 const replayId=uid(),use={type:'itemUse',data:{id:potion.id}};
 assert.equal((await cmd(use,player.key,replayId)).status,200);assert.equal((await cmd(use,player.key,replayId)).status,200);
 let view=await api(root+'/state',{key:room.key});assert.equal(view.body.state.items.find(i=>i.id===potion.id).qty,2);
 const unchanged=await api(root+'/state?since='+view.body.digest,{key:room.key});assert.equal(unchanged.body.unchanged,true);
 // Failure after a partially prepared action must roll back all of its mutations.
 const slots={type:'slotEdit',data:{actor:actor.id,level:1,max:2,current:2}};await cmd(slots);
 const failed=await cmd({type:'cast',data:{actor:actor.id,level:1,targets:['missing'],formula:'2d6'}},player.key);assert.equal(failed.status,404);
 view=await api(root+'/state',{key:room.key});assert.equal(view.body.state.actors[0].slots['1'].current,2);
 await app.close();app=createServer({dataDir,adminKey:'test-admin'});await start();
 assert.equal((await cmd(use,player.key,replayId)).status,200);
 view=await api(root+'/state',{key:room.key});assert.equal(view.body.state.items.find(i=>i.id===potion.id).qty,2);assert.equal(view.body.state.actors[0].owner,player.user.id);
 assert.equal((await cmd({type:'undo',data:{}})).status,200);
 const status=await api('/api/lobby/status');assert.equal(status.body.service,'dungeon-table');
});
