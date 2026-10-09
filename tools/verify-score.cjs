/*
 * 计分与「一锤定音」的验证。
 *
 * 断言的是「规则」本身，不是「某次随机跑出来的数」：
 *   1. 理论满分 = 1008（起始 88 + 19 手 × 40 + 连击 160）
 *   2. 每手加分的构成对得上：活过 8 + 打掉 16 + 等级 + 从容 + 连击
 *   3. 连击按 +2 递增、封顶 +10，漏一次归零
 *   4. 一锤定音：域错或付不起都算选错，方块落地堆一层、只拿 +8
 *   5. 发牌保证至少一张「域对且付得起」
 *   6. 19 手走完就通关，最终净值 = 88 + 各手之和
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
const ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu-sandbox',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
];

const GRADE_BONUS = { A: 8, B: 5, C: 2 };
/** 和 src/data/groups.ts 的 gradeOf 同一规则：取开头的 A/B/C，其余算 C。
 *  语料里有 3 条标成「A（争议）」，不归一化会算成 0 分。 */
const gradeOf = (raw) => {
  const m = (raw || '').match(/^[ABC]/);
  return m ? m[0] : 'C';
};
const calmBonus = (p) => (p <= 0.4 ? 8 : p <= 0.75 ? 4 : 1);
const comboBonus = (n) => Math.min(10, Math.max(0, n - 1) * 2);

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const read = (p) => p.evaluate(() => window.__game.state());

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
  await p.click('#help-close');
  await p.waitForTimeout(600);

  /* ---------- ① 理论满分 ---------- */
  const perfect = await p.evaluate(() => window.__game.perfectAge);
  console.log('① 理论满分:', perfect);
  check('理论满分 = 1008', perfect === 1008, String(perfect));

  /* ---------- ② 单手动牌：公式对得上 ---------- */
  const one = await p.evaluate(() => {
    const g = window.__game;
    const st = g.state();
    const idx = g.engine.playableIndexes()[0];
    const card = st.hand[idx];
    const before = st.age;
    g.play(idx, 0); // 进度 0 = 最从容
    const after = g.state().age;
    return { idx, grade: card.grade, delta: after - before, combo: g.state().combo, turn: g.state().turn };
  });
  const expectOne = 8 + 16 + GRADE_BONUS[gradeOf(one.grade)] + calmBonus(0) + comboBonus(1);
  console.log('② 第一手:', JSON.stringify(one), '期望 delta =', expectOne);
  check('第一手加分 = 8+16+等级+从容+连击', one.delta === expectOne, `${one.delta} vs ${expectOne}`);
  check('连击从 1 开始', one.combo === 1, String(one.combo));

  /* ---------- ③ 连击递增 ---------- */
  const comboSeq = await p.evaluate(() => {
    const g = window.__game;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const idx = g.engine.playableIndexes()[0];
      const grade = g.state().hand[idx].grade;
      const before = g.state().age;
      g.play(idx, 0);
      const st = g.state();
      out.push({ delta: st.age - before, combo: st.combo, grade });
    }
    return out;
  });
  console.log('③ 连击序列:', JSON.stringify(comboSeq));
  const comboOk = comboSeq.every(
    (r) => r.delta === 8 + 16 + GRADE_BONUS[gradeOf(r.grade)] + 8 + comboBonus(r.combo)
  );
  check('连击 2/3/4/5 手的加成按 +2 递增', comboOk, comboSeq.map((r) => `×${r.combo}:+${r.delta}`).join(' '));

  /* ---------- ④ 一锤定音：点错就砸 ---------- */
  const miss = await p.evaluate(() => {
    const g = window.__game;
    const st = g.state();
    const riskGroup = st.risk.group;
    // 故意挑一张域不对的
    const wrong = st.hand.findIndex((c) => c.group !== riskGroup);
    if (wrong < 0) return { skipped: true };
    const before = {
      age: st.age,
      landed: st.landed.length,
      combo: st.combo,
      money: st.resources.money,
      time: st.resources.time,
      will: st.resources.will,
    };
    g.play(wrong, 0);
    return { wrong, riskGroup, wrongGroup: st.hand[wrong].group, before, token: g.state().turn };
  });
  if (miss.skipped) {
    console.log('④ 这一手三张都同域，跳过');
  } else {
    // 等方块砸下去（slamRisk 0.28s 仿真时间，软渲染下会慢一些）
    for (let i = 0; i < 40; i++) {
      const st = await read(p);
      if (st.landed.length > miss.before.landed) break;
      await p.waitForTimeout(250);
    }
    const after = await read(p);
    console.log('④ 点错:', JSON.stringify(miss.wrongGroup), '≠', miss.riskGroup, '→', JSON.stringify({
      age: after.age, landed: after.landed.length, combo: after.combo,
    }));
    check('点错后井多一层', after.landed.length === miss.before.landed + 1, `${miss.before.landed} → ${after.landed.length}`);
    check('点错后连击归零', after.combo === 0, String(after.combo));
    check('点错只拿「活过」的 +8', after.age - miss.before.age === 8, `${after.age - miss.before.age}`);
    // 注意：这一手结束后会进下一手，而下一手开头有资源回复（钱时间 +2、毅力 +1）。
    // 所以断言是「三种资源都不减」，不是「完全不变」。
    const r = after.resources;
    check(
      '点错不扣资源（三种资源都不减，只走每手回复）',
      r.money >= miss.before.money && r.time >= miss.before.time && r.will >= miss.before.will,
      `钱 ${miss.before.money}→${r.money} 时间 ${miss.before.time}→${r.time} 毅力 ${miss.before.will}→${r.will}`
    );
  }

  /* ---------- ⑤ 付不起也算选错 ---------- */
  /*
   * 不能靠「手牌里碰巧有一张付不起的同域卡」——发牌保证了至少有一张
   * 「域对且付得起」，而且资源在一手之内不会变，所以那种牌本来就不该出现。
   * 能出现的情况是：手上有两张同域，玩家挑了贵的那张。
   * 这里直接把这个局面造出来。
   */
  const broke = await p.evaluate(() => {
    const g = window.__game;
    const eng = g.engine;
    const st = g.state();
    const card = eng.corpus.cards.find((c) => c.group === st.risk.group && c.tags.will === '是');
    if (!card) return { skipped: true };
    eng.hand[0] = card; // state 里返回的是同一个数组引用
    eng.resources.will = 0; // 要 3 点毅力，现在一点都没有
    const before = { landed: st.landed.length, age: st.age };
    g.play(0, 0);
    return { before, group: card.group, riskGroup: st.risk.group };
  });
  if (broke.skipped) {
    console.log('⑤ 语料里找不到要 3 点毅力的同域卡，跳过');
  } else {
    const toastText = await p.evaluate(() => document.getElementById('toast').textContent);
    console.log('⑤ 域对但付不起:', broke.group, '==', broke.riskGroup, '→ 提示:', JSON.stringify(toastText));
    check('付不起的提示是「付不起」', toastText.includes('付不起'), toastText);
    for (let i = 0; i < 40; i++) {
      const st = await read(p);
      if (st.landed.length > broke.before.landed) break;
      await p.waitForTimeout(250);
    }
    const after = await read(p);
    check('付不起也算选错（井多一层）', after.landed.length === broke.before.landed + 1, `${broke.before.landed} → ${after.landed.length}`);
    check('付不起也只拿「活过」的 +8', after.age - broke.before.age === 8, `${after.age - broke.before.age}`);
  }

  /* ---------- ⑥ 发牌保证：每一手都有「域对且付得起」 ---------- */
  await p.evaluate(() => window.__game.engine.start());
  await p.waitForTimeout(300);
  const deal = await p.evaluate(() => {
    const g = window.__game;
    const bad = [];
    for (let i = 0; i < 60; i++) {
      const st = g.state();
      if (st.over || !st.risk) break;
      const ok = g.engine.playableIndexes().length;
      if (ok < 1) bad.push({ turn: st.turn, risk: st.risk.group, res: st.resources });
      const idx = g.engine.playableIndexes()[0];
      if (idx === undefined) break;
      g.play(idx, 0);
    }
    return { bad, over: g.state().over, age: g.state().age, turns: g.state().turn };
  });
  console.log('⑥ 连打到底:', JSON.stringify(deal.bad), '→', JSON.stringify({ over: deal.over, age: deal.age }));
  check('每一手都至少有一张「域对且付得起」', deal.bad.length === 0, JSON.stringify(deal.bad));
  check('19 手走完就结束', deal.over === true, `over=${deal.over}`);
  check('最终净值不超过满分', deal.age <= perfect, `${deal.age} ≤ ${perfect}`);
  check(
    '最终净值落在合理区间（下限 = 全 C 卡零连击）',
    deal.age >= 88 + 19 * (8 + 16 + 2 + 8),
    `${deal.age} ≥ ${88 + 19 * 34}`
  );

  /* ---------- ⑦ 结算页 ---------- */
  const settle = await p.evaluate(() => ({
    visible: !document.getElementById('settle').hidden,
    kicker: document.getElementById('settle-kicker').textContent,
    age: document.getElementById('settle-age').textContent,
    stat: document.getElementById('settle-stat').textContent,
    perfect: document.getElementById('settle-perfect').textContent,
  }));
  console.log('⑦ 结算页:', JSON.stringify(settle));
  check('结算页显示通关', settle.visible && settle.kicker === '通关', `${settle.visible} / ${settle.kicker}`);
  check('结算页有满分参照', settle.perfect.includes(String(perfect)), settle.perfect);
  check('结算页统计里有最长连击', settle.stat.includes('最长连击'), settle.stat);

  /* ---------- ⑧ HUD ---------- */
  const hud = await p.evaluate(() => ({
    age: document.getElementById('hud-age').textContent,
    turn: document.getElementById('hud-turn').textContent,
    turnMax: document.getElementById('hud-turn-max').textContent,
    layerMax: document.getElementById('hud-layer-max').textContent,
  }));
  console.log('⑧ HUD:', JSON.stringify(hud));
  check('HUD 分母来自常量', hud.turnMax === '/19' && hud.layerMax === '/10', `${hud.turnMax} ${hud.layerMax}`);
  check('HUD 的净值和结算页一致', hud.age === settle.age, `${hud.age} vs ${settle.age}`);

  console.log('页面报错:', errs.length, errs.slice(0, 3).join(' | '));
  if (fails.length || errs.length) {
    console.log('结论: 失败 →', [...fails, ...errs.map(() => '页面报错')].join('、'));
    process.exitCode = 1;
  } else {
    console.log('结论: 全部通过');
  }
  await b.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
