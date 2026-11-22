import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCampaign,validateCampaign,viewCampaign,execute,clone,uid,requireThat} from '../src/core.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=s=>createHash('sha256').update(String(s)).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
export function createServer({dataDir=resolve(ROOT,'data'),adminKey,allowedOrigin=process.env.DT_ORIGIN||'https://verydeepwell.github.io',clock=Date.now}={}){
 mkdirSync(dataDir,{recursive:true});
 const keyFile=resolve(dataDir,'admin-key.txt');
 if(!adminKey){if(!existsSync(keyFile))writeFileSync(keyFile,secret(),{mode:0o600});adminKey=readFileSync(keyFile,'utf8').trim()}
 const db=new DatabaseSync(resolve(dataDir,'dungeon.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,password TEXT NOT NULL,salt TEXT NOT NULL,campaign TEXT NOT NULL,members TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands(room TEXT NOT NULL,member TEXT NOT NULL,id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(room,member,id)); CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT,room TEXT NOT NULL,campaign TEXT NOT NULL);`);
 const rooms=new Map(db.prepare('SELECT * FROM rooms').all().map(r=>[r.id,{...r,campaign:JSON.parse(r.campaign),members:JSON.parse(r.members)}]));
 const limits=new Map();
 function throttle(key,max=120){const now=clock();for(const [k,v]of limits)if(v.until<now)limits.delete(k);const item=limits.get(key)||{count:0,until:now+60000};requireThat(item.count++<max,'Слишком много запросов. Попробуйте через минуту.',429);limits.set(key,item)}
 function storeRoom(room){db.prepare('INSERT INTO rooms VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET campaign=excluded.campaign,members=excluded.members').run(room.id,room.name,room.password,room.salt,JSON.stringify(room.campaign),JSON.stringify(room.members))}
 function campaignWithMembers(room){const s=clone(room.campaign);s.participants=room.members.map(m=>({id:m.id,name:m.name,role:m.role,online:clock()-m.lastSeen<30000}));return s}
 function projection(room,member){return viewCampaign(campaignWithMembers(room),member,false)}
 function authenticated(room,req){const token=req.headers.authorization?.replace(/^Bearer /,'');requireThat(token,'Нет личного ключа.',401);const member=room.members.find(m=>m.hash===hash(token)&&!m.revoked);requireThat(member,'Ключ отозван или относится к другой комнате.',401);member.lastSeen=clock();return member}
 function saveCredentials(room){storeRoom(room)}
 async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;requireThat(size<=36e6,'Запрос слишком большой.',413);chunks.push(chunk)}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{const e=new Error('Некорректный JSON.');e.status=400;throw e}}
 const server=http.createServer(async(req,res)=>{
 const origin=req.headers.origin;
 const localOrigin=`http://${req.headers.host}`;
 const allowed=!origin||origin===allowedOrigin||origin===localOrigin&&/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host||'');
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 if(allowed&&origin){headers['Access-Control-Allow-Origin']=origin;headers.Vary='Origin'}
 const reply=(status,data)=>{res.writeHead(status,headers);res.end(JSON.stringify(data))};
 try{
 requireThat(allowed,'Источник запроса не разрешён.',403);
 if(req.method==='OPTIONS'){headers['Access-Control-Allow-Methods']='GET, POST, OPTIONS';headers['Access-Control-Allow-Headers']='Authorization, Content-Type';headers['Access-Control-Max-Age']='600';res.writeHead(204,headers);res.end();return}
 const url=new URL(req.url,'http://localhost'),path=url.pathname;
 if(path==='/api/lobby/status'){reply(200,{service:'dungeon-table',protocol:1,rooms:rooms.size});return}
 if(path==='/api/lobby'||path==='/api/lobby/join'){
 requireThat(req.method==='POST','Нужен POST.',405);throttle('join:'+req.socket.remoteAddress,20);const input=await body(req);
 requireThat(typeof input.room==='string'&&/^[a-z0-9_-]{3,40}$/.test(input.room),'Комната: 3–40 латинских букв, цифр, _ или -.');requireThat(typeof input.name==='string'&&input.name.trim()&&input.name.length<=80,'Введите имя до 80 символов.');requireThat(typeof input.password==='string'&&input.password.length>=4&&input.password.length<=100,'Пароль: 4–100 символов.');
 let room,member;const key=secret();
 if(path==='/api/lobby'){
 requireThat(req.headers.authorization==='Bearer '+adminKey,'Для создания комнаты нужен ключ хозяина сервера из data/admin-key.txt.',403);requireThat(![...rooms.values()].some(r=>r.name===input.room),'Имя комнаты уже занято.',409);requireThat(rooms.size<50,'Лимит 50 комнат.');
 const salt=secret();const campaign=input.campaign?validateCampaign(input.campaign):createCampaign();for(const a of campaign.actors)a.owner=null;member={id:uid(),name:input.name.trim(),role:'gm',hash:hash(key),lastSeen:clock()};room={id:uid(),name:input.room,password:scryptSync(input.password,salt,32).toString('hex'),salt,campaign,members:[member]};storeRoom(room);rooms.set(room.id,room);
 }else{
 room=[...rooms.values()].find(r=>r.name===input.room);requireThat(room,'Комната не найдена.',404);const check=scryptSync(input.password,room.salt,32);requireThat(timingSafeEqual(check,Buffer.from(room.password,'hex')),'Неверный пароль.',403);requireThat(room.members.filter(m=>!m.revoked).length<30,'Комната заполнена.');member={id:uid(),name:input.name.trim(),role:'player',hash:hash(key),lastSeen:clock()};room.members.push(member);saveCredentials(room)
 }
 reply(201,{id:room.id,key,user:{id:member.id,name:member.name,role:member.role},roomName:room.name});return;
 }
 const match=/^\/api\/lobby\/([a-f0-9-]+)(?:\/(state|command|export|asset|members)(?:\/([\w-]+))?)?$/.exec(path);
 if(match){const room=rooms.get(match[1]);requireThat(room,'Комната не найдена.',404);const member=authenticated(room,req),action=match[2]||'state';
 if(action==='state'&&req.method==='GET'){const state=projection(room,member);const digest=hash(JSON.stringify(state));if(url.searchParams.get('since')===digest)reply(200,{unchanged:true,version:state.version,user:{id:member.id,name:member.name,role:member.role}});else reply(200,{state,digest,user:{id:member.id,name:member.name,role:member.role},roomName:room.name});return}
 if(action==='asset'&&req.method==='GET'){const asset=projection(room,member).assets[match[3]];requireThat(asset,'Изображение недоступно.',404);reply(200,{data:room.campaign.assets[match[3]].data});return}
 if(action==='export'&&req.method==='GET'){requireThat(member.role==='gm','Полный экспорт доступен ГМ.',403);reply(200,room.campaign);return}
 if(action==='members'&&req.method==='POST'){requireThat(member.role==='gm','Только ГМ.',403);const input=await body(req),target=room.members.find(m=>m.id===input.id&&m.role!=='gm');requireThat(target,'Игрок не найден.');if(input.revoke){target.revoked=true;for(const a of room.campaign.actors)if(a.owner===target.id)a.owner=null;saveCredentials(room);reply(200,{ok:true})}else{const key=secret();target.hash=hash(key);target.revoked=false;saveCredentials(room);reply(200,{key,id:room.id,user:{id:target.id,name:target.name,role:target.role}})}return}
 if(action==='command'&&req.method==='POST'){
 throttle(member.id,300);const input=await body(req);requireThat(typeof input.id==='string'&&/^[\w-]{8,100}$/.test(input.id),'Нет уникального ID команды.');const previous=db.prepare('SELECT result FROM commands WHERE room=? AND member=? AND id=?').get(room.id,member.id,input.id);if(previous){reply(200,JSON.parse(previous.result));return}
 const before=clone(room.campaign);let next=clone(before);const command=input.command;
 requireThat(command&&command.type,'Неизвестная команда.');let undoing=false;
 if(command.type==='undo'){
 requireThat(member.role==='gm','Отмена доступна ГМ.',403);const row=db.prepare('SELECT * FROM history WHERE room=? ORDER BY seq DESC LIMIT 1').get(room.id);requireThat(row,'Нет изменений для отмены.');next=JSON.parse(row.campaign);next.log=before.log;next.log.unshift({id:uid(),at:clock(),title:'Отмена мастером',detail:'Последнее изменение восстановлено. Исходные броски остаются в журнале.',author:member.name,visibility:'public'});next.version=before.version+1;undoing=row.seq;
 }else if(command.type==='import'){
 requireThat(member.role==='gm','Импорт доступен ГМ.',403);next=validateCampaign(command.data.campaign);next.version=before.version+1;for(const a of next.actors)a.owner=room.members.some(m=>m.id===a.owner&&!m.revoked)?a.owner:null;
 }else execute(next,command,member);
 const result={ok:true,version:next.version};
 db.exec('BEGIN IMMEDIATE');try{
 if(undoing)db.prepare('DELETE FROM history WHERE seq=?').run(undoing);else if(!['chat','ping'].includes(command.type)){db.prepare('INSERT INTO history(room,campaign) VALUES(?,?)').run(room.id,JSON.stringify(before));db.prepare('DELETE FROM history WHERE room=? AND seq NOT IN(SELECT seq FROM history WHERE room=? ORDER BY seq DESC LIMIT 20)').run(room.id,room.id)}
 db.prepare('UPDATE rooms SET campaign=?,members=? WHERE id=?').run(JSON.stringify(next),JSON.stringify(room.members),room.id);db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(room.id,member.id,input.id,JSON.stringify(result));db.exec('COMMIT');room.campaign=next;
 }catch(error){db.exec('ROLLBACK');throw error}
 reply(200,result);return;
 }
 reply(405,{error:'Метод не поддерживается.'});return;
 }
 if(req.method==='GET'&&!path.startsWith('/api/')){
 const decoded=decodeURIComponent(path),relative=decoded==='/'?'index.html':decoded.replace(/^\//,'');
 requireThat(relative==='index.html'||relative==='config.js'||relative==='interface-preview.html'||/^src\/[a-zA-Z0-9_.-]+\.(mjs|css)$/.test(relative),'Файл недоступен.',404);
 const file=resolve(ROOT,relative);requireThat(file.startsWith(ROOT+sep)&&existsSync(file),'Файл не найден.',404);const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
 res.writeHead(200,{...headers,'Content-Type':types[extname(file)],'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'"});res.end(readFileSync(file));return;
 }
 reply(404,{error:'Не найдено.'});
 }catch(error){reply(error.status||400,{error:error.status?error.message:'Не удалось обработать запрос. '+(process.env.NODE_ENV==='test'?error.message:'')})}
 });
 return {server,db,rooms,close:()=>new Promise(resolve=>server.close(()=>{db.close();resolve()})),adminKey};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=createServer();app.server.listen(Number(process.env.PORT||8787),process.env.HOST||'127.0.0.1',()=>{const port=app.server.address().port;console.log(`DungeonTable: http://127.0.0.1:${port}`);console.log('Ключ создания комнат: data/admin-key.txt (не передавайте игрокам).')});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
