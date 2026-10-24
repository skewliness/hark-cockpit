// 诊断不得拖慢点灯（质检 E10/E11）：用 vm 抽出 workTick 及其依赖，桩视图下量灯推送时刻与 light 记录时刻。node tests/lamp/ticklat.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const s = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
const grab = re => { const m = s.match(re); if (!m) throw new Error('抽取失败 ' + re); return m[0]; };
const code = [/const lampSeen = [^\n]*\n/, /const lampLog = [^\n]*\n/, /const lampProbeLast = [^\n]*\n/, /const LAMP_QUOTA = [^\n]*\n/, /function lampAdd\(x\)[^\n]*\n/, /function lampDiag\(seen\) \{[\s\S]*?\n\}\n/,
  /function workProbe\(wc\) \{[\s\S]*?\n\}\n/, /const replyJs = [^\n]*\n/, /const REPLY_STABLE_MS[^\n]*\n/, /const replyLast[^\n]*\n/, /function replyProbe\(wc\) \{[\s\S]*?\n\}\n/, /function replyDiag\([\s\S]*?\n\}\n/,
  /const replyPending[^\n]*\n/, /let workTicking = false;\nasync function workTick\(\) \{[\s\S]*?\n\}\n/].map(grab).join('');
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
async function run(delay) {
  let pushedAt = null; const t0 = Date.now();
  const wc = { isDestroyed: () => false, isLoading: () => false, executeJavaScript: js => js.includes('message-bubble') ? new Promise(r => setTimeout(() => r({ n: 1, len: 5 }), delay)) : Promise.resolve({ busy: true, rule: 'live-run-pill' }) };
  const ctx = { console, Date, setTimeout, Promise, Map, Set, String, accounts: [{ id: 'a' }], loginState: { a: true }, views: new Map([['a', { webContents: wc }]]), inboxViews: new Map(), work: {}, WORK_IDLE_MS: 8000,
    workOf: id => ctx.work[id] || (ctx.work[id] = { busyAt: 0, working: false }), pushState: () => { pushedAt = Date.now(); }, stopJs: () => 'stop' };
  vm.createContext(ctx); vm.runInContext(code + ';this.workTick=workTick;this.L=lampLog;', ctx);
  await ctx.workTick(); const lt = ctx.L.find(x => x.lamp === 'light');
  ok(`replyJs 延迟 ${delay}ms：灯推送 ${pushedAt - t0}ms ≤ 50ms`, pushedAt !== null && pushedAt - t0 <= 50);
  ok(`replyJs 延迟 ${delay}ms：|light 记录 − 推送| = ${lt ? Math.abs(lt.t - pushedAt) : 'none'}ms ≤ 50ms`, !!lt && Math.abs(lt.t - pushedAt) <= 50);
  await ctx.workTick();   // 在飞时不重复发起
  await new Promise(r => setTimeout(r, Math.min(delay, 1500) + 100));
  const rec = ctx.L.filter(x => x.lamp === 'reply');
  ok(`replyJs 延迟 ${delay}ms：reply 记录${delay < 1500 ? '照常产生' : '超时不产生'}且只含结构字段`, (delay < 1500 ? rec.length === 1 : rec.length === 0) && rec.every(x => Object.keys(x).sort().join(',') === 'acc,at,lamp,n,state,t,view'));
}
(async () => { for (const d of [0, 1400, 5000]) await run(d); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
