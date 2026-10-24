// cycle.js 自测：合成诊断 K1–K9（含质检 K2/K3/K6 构造），node tests/lamp/cycle-test.js
const fs=require('fs'),cp=require('child_process'),path=require('path'),os=require('os');const tmp=path.join(os.tmpdir(),'cycle-k.json');let bad=0;const T0=Date.parse('2026-10-24T01:00:00Z');
const P=(s,busy,rule,view='main',acc=0)=>({t:T0+s*1000,lamp:'probe',acc,view,busy,rule});const Lt=(s,on,acc=0)=>({t:T0+s*1000,lamp:'light',acc,on});
const Rg=(s)=>({t:T0+s*1000,lamp:'reply',acc:0,view:'main',state:'growing',n:2});const Rs=(s,at)=>({t:T0+s*1000,lamp:'reply',acc:0,view:'main',state:'stable',at:T0+at*1000,n:2});
const R0=Rs(0,0);
const cases={
'K1 单周期正常 PASS':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),Rs(105,100),P(100,false),Lt(108,false),P(200,false,undefined,'inbox')],
'K2 周期2常驻红至导出 FAIL':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),Rs(105,100),P(100,false),Lt(108,false),P(200,true,'live-run-pill'),Lt(200,true),P(900,true,'live-run-pill','inbox')],
'K3 周期2结束30s内复红 FAIL':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),Rs(105,100),P(100,false),Lt(108,false),P(300,true,'live-run-pill'),Rg(302),Rs(335,330),P(330,false),Lt(338,false),P(350,true,'live-run-pill'),P(352,false),P(500,false,undefined,'inbox')],
'K4 仅stop-button FAIL':[P(0,false),R0,P(70,true,'stop-button'),Lt(70,true),Rg(72),Rs(105,100),P(100,false),Lt(108,false),P(200,false,undefined,'inbox')],
'K5 灯灭晚20s FAIL':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),Rs(105,100),P(100,false),Lt(120,false),P(200,false,undefined,'inbox')],
'K6 独立结束75 pill滞留至100 FAIL':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),Rs(80,75),P(100,false),Lt(108,false),P(200,false,undefined,'inbox')],
'K6b 独立结束与pill消失同为100 PASS':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),Rs(105,100),P(100,false),Lt(108,false),P(200,false,undefined,'inbox')],
'K7 开头即忙 FAIL':[P(0,true,'live-run-pill'),R0,Lt(0,true),Rg(5),Rs(35,30),P(30,false),Lt(38,false),P(200,false,undefined,'inbox')],
'K8 无独立结束标志 FAIL':[P(0,false),P(70,true,'live-run-pill'),Lt(70,true),P(100,false),Lt(108,false),P(200,false,undefined,'inbox')],
'K9 两周期都好 PASS':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),Rs(105,100),P(100,false),Lt(108,false),P(200,true,'live-run-pill'),Lt(200,true),Rg(202),Rs(235,230),P(230,false),Lt(238,false),P(400,false,undefined,'inbox')],
'K10 灯提前灭 pill80 灯88 回复增长到120 FAIL':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),P(80,false),Lt(88,false),Rs(125,120),P(300,false,undefined,'inbox')],
'K11 独立结束100 pill109 灯117 FAIL':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),Rs(105,100),P(109,false),Lt(117,false),P(300,false,undefined,'inbox')],
'K12 独立结束100 pill101 灯109 PASS':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),Rs(105,100),P(101,false),Lt(109,false),P(300,false,undefined,'inbox')],
'K13 回复在探针转闲后35s才出现 FAIL':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),P(100,false),Lt(108,false),Rg(135),Rs(141,135),P(300,false,undefined,'inbox')],
'K14 下次运行前用户新消息不算本周期结束 PASS':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),Rs(105,100),P(100,false),Lt(106,false),Rg(230),Rs(236,230),P(238,true,'live-run-pill'),Lt(238,true),Rg(240),Rs(250,245),P(245,false),Lt(251,false),P(400,false,undefined,'inbox')],
'T1 转闲后15s用户再发消息 不算本周期结束 PASS':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),P(130,false),Rs(136,130),Lt(136,false),Rg(145),Rs(151,145),P(299,false,undefined,'inbox')],
'T1b 用户消息后开下一轮 PASS':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),P(130,false),Rs(136,130),Lt(136,false),Rg(145),Rs(151,145),P(160,true,'live-run-pill'),Lt(160,true),Rg(162),P(200,false),Rs(206,200),Lt(206,false),P(299,false,undefined,'inbox')],
'T2 对照无消息 PASS':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),P(130,false),Rs(136,130),Lt(136,false),P(299,false,undefined,'inbox')],
'K15 复红后才出现回复增长 不得当作用户触发 FAIL':[P(0,false),R0,P(70,true,'live-run-pill'),Lt(70,true),Rg(72),P(100,false),Rs(105,100),Lt(106,false),P(120,true,'live-run-pill'),Lt(120,true),Rg(125),P(140,false),Rs(146,140),Lt(147,false),P(300,false,undefined,'inbox')],
};
for(const [k,lamp] of Object.entries(cases)){fs.writeFileSync(tmp,JSON.stringify({lamp}));let o,rc=0;try{o=cp.execFileSync(process.execPath,[path.join(__dirname,'cycle.js'),tmp]).toString()}catch(e){o=e.stdout.toString();rc=e.status}const want=/ PASS$/.test(k)?0:1,good=rc===want;if(!good)bad++;console.log((good?'PASS ':'FAIL ')+k,'=>',o.trim().split('\n').pop(),'rc='+rc);}
console.log(bad?bad+' failed':'all passed');process.exit(bad?1:0);
