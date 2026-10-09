/*
 * 查账模式的验证。
 *
 * 分两段：
 *   ① 本地检索：一组已知答案的查询，断言正确答案排在前 N
 *   ② Jev 复核：把 window.fetch 换成桩，验证请求形状、判定解析、排序合成
 *      （线上 classifier.dev 从这台机器被 403 了，见 README 的说明，
 *       所以这里用桩验逻辑，不假装验证了线上）
 */
const { chromium } = require('playwright-core');
const path = require('path');
const EXE = path.join(
  process.env.LOCALAPPDATA,
  'ms-playwright',
  'chromium_headless_shell-1243',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe'
);
const ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'];

/** 查询 → 期望命中的条号（我按语料手写的，不是跑出来的） */
const CASES = [
  ['房东不退我押金怎么办', '15-1'],
  ['我家孩子一年近视涨了一百度', '30-4'],
  ['吃了头孢之后喝酒了', '34-11'],
  ['公司欠我加班费不给', '19-1'],
  ['被狗咬了怎么办', '13-13'],
  ['失业了没收入', '07-1'],
  ['结婚前要不要查对方婚姻状况', '08-26'],
  ['手机丢了怎么办', '14-4'],
  ['两种感冒药能不能一起吃', '34-1'],
  ['电动车推进楼道充电行不行', '01-6'],
  ['被裁了能拿多少补偿', '19-4'],
  ['孩子被同学欺负', '30-3'],
  ['怀孕要补什么', '27-1'],
  ['老人卧床长了褥疮', '17-8'],
  ['买的基金亏了要不要补仓', '05-37'],
];

const TOPN = 5;

(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ARGS });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !document.getElementById('boot'))) break;
    await p.waitForTimeout(400);
  }

  /* ---------- ① 本地检索 ---------- */
  const local = await p.evaluate(
    async ({ cases, topN }) => {
      const mod = await import('/src/search.ts');
      const cards = await (await fetch('/cards.json')).json();
      const risks = window.__game.risks;
      const t0 = performance.now();
      const index = mod.buildIndex(cards, risks);
      const buildMs = performance.now() - t0;
      const out = [];
      let total = 0;
      for (const [q, want] of cases) {
        const t = performance.now();
        const hits = mod.searchLocal(index, q, 20);
        total += performance.now() - t;
        const rank = hits.findIndex((h) => h.id === want);
        out.push({
          q,
          want,
          rank: rank < 0 ? -1 : rank + 1,
          top: hits.slice(0, topN).map((h) => `${h.id}:${h.score.toFixed(1)}`),
          got: rank >= 0 ? hits[rank].title.slice(0, 20) : null,
        });
      }
      return { docs: index.docs.length, buildMs, avgMs: total / cases.length, out };
    },
    { cases: CASES, topN: TOPN }
  );

  console.log('=== ① 本地检索 ===');
  console.log(`索引 ${local.docs} 条（672 卡 + 284 风险），构建 ${local.buildMs.toFixed(0)}ms，平均查询 ${local.avgMs.toFixed(1)}ms`);
  let pass = 0;
  for (const r of local.out) {
    const ok = r.rank > 0 && r.rank <= TOPN;
    if (ok) pass++;
    console.log(
      `   ${ok ? '✅' : '❌'} 「${r.q}」 期望 ${r.want} → 第 ${r.rank} 名` +
        (r.got ? ` 「${r.got}」` : '') +
        (ok ? '' : `\n       top: ${r.top.join('  ')}`)
    );
  }
  console.log(`   命中率：${pass}/${CASES.length}（前 ${TOPN} 名内）`);

  /* ---------- ② Jev 复核（打桩） ---------- */
  const jev = await p.evaluate(async () => {
    const mod = await import('/src/search.ts');
    const cards = await (await fetch('/cards.json')).json();
    const index = mod.buildIndex(cards, window.__game.risks);
    const hits = mod.searchLocal(index, '房东不退我押金怎么办', 6);

    const seen = [];
    const realFetch = window.fetch;
    /*
     * 桩：把**靠后的**一条判成「直接回答了」，其余「完全无关」。
     * 故意不判第一条：只有把低分的那条顶上来，才真的验证了
     * 「Jev 的判定参与排序」，而不是碰巧本地第一条就是对的。
     */
    const PROMOTE = 2;
    window.fetch = async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      const n = JSON.parse(init.body).inputs.length;
      const results = Array.from({ length: n }, (_, i) => ({
        label: i === PROMOTE ? '直接回答了这个问题' : '完全无关',
        confidence: null,
        scores: null,
      }));
      return new Response(JSON.stringify({ model: 'stub-model', results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const r = await mod.jevCheck('房东不退我押金怎么办', hits);
    const shuffled = hits.map((h, i) => ({ ...h, verdict: r.verdicts[i] }));
    // 打乱输入顺序，确认排序不是靠原顺序
    const merged = mod.mergeHits([...shuffled].reverse());

    // 失败路径：500
    window.fetch = async () =>
      new Response(JSON.stringify({ error: 'Anonymous proxy traffic requires a funded API key.', code: 'proxy_requires_payment' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    const bad = await mod.jevCheck('房东不退我押金怎么办', hits);

    window.fetch = realFetch;
    return {
      ok: r.ok,
      verdicts: r.verdicts,
      model: r.model,
      req: seen[0]
        ? {
            url: seen[0].url,
            labels: seen[0].body.labels,
            nInputs: seen[0].body.inputs.length,
            hasInstructions: typeof seen[0].body.instructions === 'string',
            firstInput: seen[0].body.inputs[0].slice(0, 60),
            shareHeader: seen[0].headers['X-Classifier-Share-Data'],
          }
        : null,
      mergedTop: merged[0]?.id,
      mergedFirstVerdict: merged[0]?.verdict,
      /** 本地第 3 名（桩把它判成了 direct，它应该被顶到第一） */
      expectTop: hits[2]?.id,
      localTop: hits[0]?.id,
      badOk: bad.ok,
      badError: bad.error,
      badVerdicts: bad.verdicts,
    };
  });

  console.log('\n=== ② Jev 复核（打桩）===');
  console.log('   请求:', JSON.stringify(jev.req));
  console.log('   判定:', JSON.stringify(jev.verdicts), '| ok =', jev.ok, '| model =', jev.model);
  console.log('   本地第一名:', jev.localTop, '| 被桩判成 direct 的是:', jev.expectTop);
  console.log('   排序合成后第一名:', jev.mergedTop, '| 它的判定:', jev.mergedFirstVerdict);
  console.log('   失败路径: ok =', jev.badOk, '| error =', jev.badError);
  console.log('   失败时的判定（应为 null，不能假称 Jev 判过）:', JSON.stringify(jev.badVerdicts));

  const checks = [
    ['请求打到 classifier.dev', jev.req && jev.req.url.includes('classifier.dev')],
    ['带了三个自然语言标签', jev.req && jev.req.labels.length === 3],
    ['标签里有「都不匹配」的出口', jev.req && jev.req.labels.some((l) => l.includes('完全无关'))],
    ['inputs 条数与候选一致', jev.req && jev.req.nInputs === 6],
    ['instructions 是字符串且非空', jev.req && jev.req.hasInstructions],
    ['请求里带了不用于训练的声明', jev.req && jev.req.shareHeader === 'false'],
    ['判定被正确解析', jev.ok && jev.verdicts[0] === 'off' && jev.verdicts[2] === 'direct'],
    ['Jev 判 direct 的那条被顶到第一', jev.mergedTop === jev.expectTop && jev.mergedTop !== jev.localTop],
    ['403 时 ok=false 并带原因', jev.badOk === false && /403|proxy/.test(jev.badError || '')],
    ['失败时判定为 null（界面不会假称 Jev 判过）', jev.badVerdicts.every((v) => v === null)],
  ];
  console.log('\n=== 断言 ===');
  let allOk = true;
  for (const [name, ok] of checks) {
    console.log(`   ${ok ? '✅' : '❌'} ${name}`);
    if (!ok) allOk = false;
  }

  console.log('\n页面报错:', errs.length, errs.slice(0, 2).join(' | '));
  const localPass = pass >= Math.ceil(CASES.length * 0.8);
  console.log(
    localPass && allOk && !errs.length
      ? '结论: 通过'
      : `结论: 有问题（本地 ${pass}/${CASES.length}，逻辑 ${allOk ? 'ok' : 'fail'}）`
  );
  if (!(localPass && allOk && !errs.length)) process.exitCode = 1;
  await b.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
