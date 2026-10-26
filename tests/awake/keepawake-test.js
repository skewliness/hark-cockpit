const fs=require('fs'); const s=fs.readFileSync(''+require('path').join(__dirname,'../../app/main.js')+'','utf8');
const a=s.indexOf('const AWAKE_JS'), b=s.indexOf('app.whenReady().then(() => setInterval(awakeTick');
let code=s.slice(a,b);
let started=new Set(),id=0,lamps=[];
const powerSaveBlocker={start(){id++;started.add(id);return id},stop(i){started.delete(i)},isStarted(i){return started.has(i)}};
const lampAdd=x=>lamps.push(x);
let mail={letters:[]},accounts=[{id:'a'}],busy=false; const isWorking=()=>busy;
const assert=require('assert');
eval(code+';globalThis.keepAwake=keepAwake;globalThis.awakeTick=awakeTick;globalThis.getBlock=()=>awakeBlock;');
function mkwc(attachOk,slow){const cmds=[];let att=false;const h={};return {cmds,h,isDestroyed:()=>false,setBackgroundThrottling(){},on(e,f){h[e]=f},executeJavaScript(){cmds.push('exec');return Promise.resolve(true)},
 debugger:{isAttached:()=>att,attach(){if(!attachOk)throw new Error('x');att=true},sendCommand(m){cmds.push(m);return new Promise(r=>setTimeout(r,slow||1))}}};}
(async()=>{
 let w=mkwc(true); let p=keepAwake(w); assert(p&&typeof p.then==='function'); await p;
 assert(w.cmds.includes('Page.addScriptToEvaluateOnNewDocument')&&w.cmds.includes('Emulation.setFocusEmulationEnabled')&&w.cmds.includes('exec')); console.log('T1 inject before resolve OK');
 w=mkwc(false); p=keepAwake(w); assert(p.then); await p; console.log('T2 attach fail still resolves OK');
 w=mkwc(true,5000); const t0=Date.now(); await keepAwake(w); const dt=Date.now()-t0; assert(dt<2000&&dt>=1400,dt); console.log('T3 1.5s timeout OK',dt);
 const dw={isDestroyed:()=>true}; await keepAwake(dw); console.log('T4 destroyed OK');
 awakeTick(); assert(!getBlock()); mail.letters=[{status:'queued'}]; awakeTick(); assert(powerSaveBlocker.isStarted(getBlock()));
 mail.letters=[]; awakeTick(); assert(getBlock()==null&&started.size===0); busy=true; awakeTick(); assert(started.size===1); busy=false; awakeTick(); assert(started.size===0);
 assert(lamps.filter(x=>x.lamp==='awake').length===4); console.log('T5 power blocker conditional OK');
 // T6 cap: busy stuck > 2h -> stop, stays off until idle
 busy=true; awakeTick(); assert(started.size===1); const real=Date.now; Date.now=()=>real()+2*3600*1000+1000; awakeTick(); assert(started.size===0,'cap'); awakeTick(); assert(started.size===0);
 busy=false; awakeTick(); busy=true; awakeTick(); assert(started.size===1); Date.now=real; busy=false; awakeTick(); console.log('T6 2h cap OK');
 process.exit(0);
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
