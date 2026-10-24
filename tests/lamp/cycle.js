// 读真机诊断，按质检「闭环所需」三条断言判定运行周期：node tests/lamp/cycle.js hark-cockpit-diag.json
// ① 工作期间 live-run-pill 规则命中 ≥1；② 运行结束后 ≤10s 灯灭（light on=false），之后 60s 内探针 busy=true 次数 = 0；③ 运行开始前 60s 内探针 busy=true 次数 = 0（须有 ≥60s 的空闲记录在前）
const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const L = (d.lamp || []).slice().sort((a, b) => a.t - b.t), probes = L.filter(x => x.lamp === 'probe'), lights = L.filter(x => x.lamp === 'light');
const out = []; let allOk = true;
for (const acc of [...new Set(probes.map(x => x.acc))]) {
  // 每个窗口把主视图 / 收信视图合并成一条「任一视图 busy」时间线
  const st = {}, tl = []; for (const p of probes.filter(x => x.acc === acc)) { st[p.view] = p.busy ? p.rule : ''; const busy = Object.values(st).some(Boolean); if (!tl.length || tl[tl.length - 1].busy !== busy) tl.push({ t: p.t, busy }); }
  const first = probes.find(x => x.acc === acc).t, last = L[L.length - 1].t;
  for (let i = 0; i < tl.length; i++) {
    if (!tl[i].busy) continue;
    const start = tl[i].t, end = tl[i + 1] ? tl[i + 1].t : null;
    const rules = probes.filter(x => x.acc === acc && x.busy && x.t >= start && (end === null || x.t < end)).map(x => x.rule);
    const a1 = rules.includes('live-run-pill');
    const off = end === null ? null : lights.find(x => x.acc === acc && !x.on && x.t >= end);
    const a2 = end !== null && !!off && off.t - end <= 10000 && last - end >= 60000 && !tl.some(x => x.busy && x.t > end && x.t <= end + 60000);
    const a3 = start - first >= 60000 && !tl.some(x => x.busy && x.t >= start - 60000 && x.t < start);
    const ok = a1 && a2 && a3; allOk = allOk && ok;
    out.push({ acc, start: new Date(start).toISOString(), durS: end ? Math.round((end - start) / 1000) : null, rules: [...new Set(rules)], a1_liveRunPill: a1, a2_endGreenWithin10s_no60sRelapse: a2, offAfterS: off ? (off.t - end) / 1000 : null, a3_idle60sBefore: a3, ok });
  }
}
out.forEach(r => console.log(JSON.stringify(r)));
console.log(out.length ? (out.some(r => r.ok) ? 'CYCLE PASS（至少一个完整运行周期三条全满足）' : 'CYCLE FAIL') : 'NO RUN（诊断里没有探针命中记录）');
