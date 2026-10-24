// 质检 S8：导出诊断 entries 不得含账户 ID / 会话 ID / 令牌。抽出 lampPath、diagUrl、diagAdd 实跑。node tests/lamp/diagscrub.js [真机诊断.json]
const fs = require('fs'), vm = require('vm'), path = require('path');
const s = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
const grab = re => { const m = s.match(re); if (!m) throw new Error('抽取失败 ' + re); return m[0]; };
const ctx = { URL, String }; vm.createContext(ctx);
vm.runInContext([/const lampPath = [^\n]*\n/, /const diag = \[\];\n/, /const diagUrl = [^\n]*\n/, /function diagAdd\(x\)[^\n]*\n/].map(grab).join('') + ';this.diagAdd=diagAdd;this.diag=diag;', ctx);
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const acct = 'a1b2c3d4e5f60718293a4b5c6d7e8f90', uuid = 'e49660a8-2955-49ae-bf10-88a0c1d2e3f4', tok = '8f2c1d0e9b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f';
const urls = [`https://auth.hark.com/api/avatars/${acct}`, `https://app.hark.com/api/conversations/${uuid}/viewed`, `https://app.hark.com/api/presence/sessions/${uuid}`,
  `https://app.hark.com/cdn-cgi/challenge-platform/h/g/jsd/r/0.123:1761270000:${tok}/9a8b7c6d5e4f3a2b`, `https://app.hark.com/api/users/alice.chen@example.com/threads?q=secret`, `wss://app.hark.com/ws/${uuid}?token=${tok}`];
for (const u of urls) ctx.diagAdd({ t: 1, url: u, status: 200 });
ctx.diagAdd({ t: 1, ws: true, url: `wss://rt.hark.com/socket/${acct}` });
ctx.diagAdd({ t: 1, stream: 'text', len: 42 });
const out = JSON.stringify(ctx.diag);
for (const v of [acct, uuid, tok, 'alice', 'example.com', 'secret', '9a8b7c6d5e4f3a2b', '1761270000']) ok(`导出不含 ${v.slice(0, 12)}…`, !out.includes(v));
ok('主机保留', ctx.diag[0].url === 'https://auth.hark.com/api/avatars/:x' && ctx.diag[2].url === 'https://app.hark.com/api/presence/sessions/:id');
ok('ws 记录 url 同样脱敏', ctx.diag.find(x => x.ws).url === 'wss://rt.hark.com/socket/:x');
ok('文本流只留长度、无 hint', !/hint/.test(out) && /"len":42/.test(s.includes("stream: 'text', len: String(data).length") ? out : 'x'));
ok('导出 usageCfg.url 也走 diagUrl', /usageCfg: usageCfg\.url \? \{ url: diagUrl\(usageCfg\.url\) \}/.test(s));
ok('diagAdd 只有一处定义，调用点不再自拼 url', (s.match(/function diagAdd/g) || []).length === 1);
// 可选：对真机诊断原件里每条 url 重新过一遍，原始 ID/令牌段出现次数 = 0
if (process.argv[2]) { const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); ctx.diag.length = 0;
  const raw = d.entries.filter(x => x.url).map(x => x.url); raw.forEach(u => ctx.diagAdd({ t: 1, url: u }));
  const o = JSON.stringify(ctx.diag), segs = [...new Set(raw.flatMap(u => { try { return new URL(u).pathname.split('/'); } catch { return []; } }).filter(x => /[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-|[A-Za-z0-9_-]{24,}|:\d{6,}/i.test(x)))];
  ok(`真机原件 ${raw.length} 条 url：${segs.length} 个标识/令牌段出现次数 = ${segs.filter(x => o.includes(x)).length}`, segs.every(x => !o.includes(x))); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
