// DOM adapter tests use synthetic elements, not an automated browser session.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as core from '../src/core.mjs';

test('client boots, renders all panels and keeps combat when restoring local state',async()=>{
 const elements=new Map();
 class Element{
 constructor(){this.style={};this.dataset={};this.tagName='DIV';this.children=[];this.value='';this.hidden=false;this.html='';this.classList={toggle(){}}}
 get innerHTML(){return this.html}set innerHTML(value){this.html=value}
 addEventListener(){}removeEventListener(){}append(e){this.children.push(e)}contains(){return false}getBoundingClientRect(){return {width:1000,height:650,left:0,top:0}}setPointerCapture(){}remove(){}click(){}showModal(){this.open=true}close(){this.open=false}
 }
 const get=key=>{if(!elements.has(key))elements.set(key,new Element());return elements.get(key)};
 let saved=core.createCampaign();const gm={id:'local-gm',name:'GM',role:'gm'};
 core.execute(saved,{type:'combatStart',data:{participants:[{actor:saved.actors[0].id,side:'party'}]}},gm,{die:()=>12});
 const fakeDB={transaction(){const tx={objectStore(){return {get(){const req={};queueMicrotask(()=>{req.result=structuredClone(saved);req.onsuccess?.()});return req},put(data){saved=structuredClone(data)}}}};queueMicrotask(()=>tx.oncomplete?.());return tx}};
 const document={querySelector:get,activeElement:{tagName:'BODY'},addEventListener(){},createElement:()=>new Element()};
 const local=new Map();const ctx=vm.createContext({...core,document,window:{addEventListener(){}},location:{protocol:'http:',origin:'http://127.0.0.1:8787'},indexedDB:{open(){const r={};queueMicrotask(()=>{r.result=fakeDB;r.onsuccess()});return r}},localStorage:{getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v)},crypto:globalThis.crypto,structuredClone,URL,Blob,console,setTimeout:()=>0,clearTimeout(){},Date});
 const code=readFileSync(new URL('../src/app.mjs',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');vm.runInContext(code,ctx);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(vm.runInContext('state.combat.round',ctx),1);
 assert(get('#navigation').innerHTML.includes('Персонажи'));
 for(const panel of ['table','scenes','actors','inventory','library','journal','players','settings']){
 vm.runInContext(`section=${JSON.stringify(panel)};renderPanel()`,ctx);assert(get('#panel').innerHTML.length>20,panel+' should render');
 }
 const initial=vm.runInContext('full.items.find(i=>i.type==="potion").qty',ctx);
 await vm.runInContext(`dispatch('combatEnd',{})`,ctx);
 await vm.runInContext(`dispatch('itemUse',{id:full.items.find(i=>i.type==='potion').id})`,ctx);
 assert.equal(vm.runInContext('full.items.find(i=>i.type==="potion").qty',ctx),initial-1);
 await vm.runInContext(`dispatch('undo',{})`,ctx);assert.equal(vm.runInContext('full.items.find(i=>i.type==="potion").qty',ctx),initial);
 const acts=[...code.matchAll(/btn\([^\n]*?/g)];assert(acts.length>0);
 // Every action emitted by the navigation, tools and all panels has a handler.
 for(const panel of ['table','scenes','actors','inventory','library','journal','players','settings']){
 vm.runInContext(`section=${JSON.stringify(panel)};render()`,ctx);
 for(const el of [get('#panel'),get('#navigation'),get('#toolbar'),get('#initiative')])for(const match of el.innerHTML.matchAll(/data-act="([^"]+)"/g))assert.equal(vm.runInContext(`typeof actions[${JSON.stringify(match[1])}]`,ctx),'function',match[1]);
 }
});
