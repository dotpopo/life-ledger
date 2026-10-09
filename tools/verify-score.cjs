/*
 * 计分 / 判定 / 讲解 / 暂停 / 结束 的验证。
 *
 * 断言的是「规则」本身，不是某次随机跑出来的数：
 *   1. 理论满分 = 1008
 *   2. 手上一定有一张原书指向的答案卡，另外两张来自别的域
 *   3. 判定按 risk.keys，不是「同域就行」
 *   4. 每手加分构成对得上；连击 +2 递增、封顶 +10、漏一次归零
 *   5. 一锤定音：选错或付不起都算这一手没了，方块砸下去堆一层
 *   6. 讲解卡会 hold 住回合，读完点继续才开下一手
 *   7. 暂停真的冻住下落
 *   8. 结束按钮能主动收局
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
/** 讲解卡开着的时候把它关掉，等价于玩家点「继续」 */
const dismissLesson = async (p) => {
  const open = await p.evaluate(() => !document.getElementById('lesson').hidden);
  if (open) {
    await p.click('#lesson-next');
    await p.waitForTimeout(120);
  }
  return open;
};
/**
 * 重开一局。走真实的「再来一局」按钮，因为它同时会清场景、收讲解卡、收暂停。
 * 直接 engine.start() 会把这些状态留在场上，测试就测不出真实行为了。
 */
const freshGame = async (p) => {
  await p.evaluate(() => document.getElementById('again-btn').click());
  await p.waitForTimeout(400);
  await dismissLesson(p);
};

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
  await p.click('#start .start-card[data-mode="game"]');
  await p.waitForTimeout(400);
  await p.click('#help-close');
  await p.waitForTimeout(600);

  /* ---------- ① 理论满分 ---------- */
  const perfect = await p.evaluate(() => window.__game.perfectAge);
  console.log('① 理论满分:', perfect);
  check('理论满分 = 1008', perfect === 1008, String(perfect));

  /* ---------- ② 发牌：手上一定有答案卡，干扰项跨域 ---------- */
  const deal = await p.evaluate(() => {
    const g = window.__game;
    const bad = [];
    const steps = [];
    const riskIds = [];
    for (let n = 0; n < 40; n++) {
      const st = g.state();
      if (st.over || !st.risk) break;
      const keys = st.risk.keys;
      const answers = st.hand.filter((c) => keys.includes(c.id));
      const others = st.hand.filter((c) => !keys.includes(c.id));
      if (answers.length !== 1) bad.push(`第${st.turn}手答案数=${answers.length}`);
      if (others.some((c) => c.group === st.risk.group)) {
        bad.push(`第${st.turn}手干扰项跟风险同域`);
      }
      riskIds.push(st.risk.id);
      const idx = g.engine.playableIndexes()[0];
      if (idx === undefined) break;
      const card = st.hand[idx];
      const before = st.age;
      g.play(idx, 0); // 进度 0 = 最从容
      steps.push({ delta: g.state().age - before, combo: g.state().combo, grade: card.grade });
      g.engine.resumeTurn();
    }
    return { bad, steps, riskIds, over: g.state().over, age: g.state().age };
  });
  console.log('② 连打到底:', JSON.stringify(deal.bad), '→', JSON.stringify({ over: deal.over, age: deal.age }));
  check('每手都恰好一张答案卡', deal.bad.filter((x) => x.includes('答案数')).length === 0, JSON.stringify(deal.bad));
  check('干扰项不跟风险同域', deal.bad.filter((x) => x.includes('干扰项')).length === 0, JSON.stringify(deal.bad));
  // 这一条直接盯住「题库太小」那个抱怨：19 手之内不该出现重复的风险
  const uniq = new Set(deal.riskIds).size;
  check(
    '一局之内风险不重复（题库够大）',
    uniq === deal.riskIds.length,
    `${deal.riskIds.length} 手出现 ${uniq} 个不同的风险`
  );
  check('19 手走完就结束', deal.over === true, `over=${deal.over}`);
  check('最终净值不超过满分', deal.age <= perfect, `${deal.age} ≤ ${perfect}`);
  const composeOk = deal.steps.every(
    (s) => s.delta === 8 + 16 + GRADE_BONUS[gradeOf(s.grade)] + calmBonus(0) + comboBonus(s.combo)
  );
  console.log('   每手加分:', deal.steps.map((s) => `×${s.combo}:+${s.delta}`).join(' '));
  check('每手加分 = 活过+接住+证据+从容+连击', composeOk, `${deal.steps.length} 手`);
  check('连击一手一手加上去', deal.steps.every((s, i) => s.combo === i + 1), deal.steps.map((s) => s.combo).join(','));

  /* ---------- ③ 判定按 keys，不是同域 ---------- */
  await freshGame(p);
  const byKeys = await p.evaluate(() => {
    const g = window.__game;
    const st = g.state();
    // 找一张同域但不在 keys 里的卡（语料里一定存在，比如「每天补维生素」对「车祸」）
    const sameGroupWrong = g.engine.corpus.cards.find(
      (c) => c.group === st.risk.group && !st.risk.keys.includes(c.id)
    );
    if (!sameGroupWrong) return { skipped: true };
    g.engine.hand[0] = sameGroupWrong;
    const before = { landed: st.landed.length, age: st.age };
    g.play(0, 0);
    return {
      before,
      title: sameGroupWrong.title.slice(0, 18),
      group: sameGroupWrong.group,
      riskGroup: st.risk.group,
    };
  });
  if (byKeys.skipped) {
    console.log('③ 语料里找不到同域但不对的卡，跳过');
  } else {
    console.log('③ 同域但不对的卡:', JSON.stringify(byKeys.title), `（${byKeys.group}）`);
    // 方块要砸下去才堆层，所以层数得等落地之后再读
    for (let i = 0; i < 40; i++) {
      if (await p.evaluate(() => !document.getElementById('lesson').hidden)) break;
      await p.waitForTimeout(250);
    }
    const landed = await read(p);
    check(
      '同域但不在 keys 里也算选错',
      landed.landed.length === byKeys.before.landed + 1,
      `井 ${byKeys.before.landed} → ${landed.landed.length}`
    );
    check('选错只拿「活过」的 +8', landed.age - byKeys.before.age === 8, `${landed.age - byKeys.before.age}`);
    const lesson = await p.evaluate(() => ({
      open: !document.getElementById('lesson').hidden,
      verdict: document.getElementById('lesson-verdict').textContent,
      body: document.getElementById('lesson-body').textContent.slice(0, 200),
      holding: window.__game.state().holding,
    }));
    console.log('④ 讲解卡:', JSON.stringify(lesson.verdict), '| holding =', lesson.holding);
    check('选错后弹讲解卡', lesson.open === true, String(lesson.open));
    check('讲解卡说没接住', lesson.verdict.includes('没接住'), lesson.verdict);
    check('讲解卡里有正确答案的正文', lesson.body.length > 40, `正文 ${lesson.body.length} 字`);
    check('讲解期间引擎 hold 住', lesson.holding === true, String(lesson.holding));

    // hold 期间出牌应该无效
    const duringHold = await p.evaluate(() => {
      const g = window.__game;
      const before = g.state().age;
      const idx = g.engine.playableIndexes()[0];
      if (idx !== undefined) g.play(idx, 0);
      return { before, after: g.state().age, turn: g.state().turn };
    });
    check('讲解期间出牌无效', duringHold.before === duringHold.after, `${duringHold.before} → ${duringHold.after}`);

    await dismissLesson(p);
    await p.waitForTimeout(300);
    const afterResume = await p.evaluate(() => ({ holding: window.__game.state().holding, risk: !!window.__game.state().risk }));
    check('点继续后开了下一手', afterResume.holding === false && afterResume.risk === true, JSON.stringify(afterResume));
  }

  /* ---------- ⑤ 付不起：答案卡也在手上，但出不起 ---------- */
  await freshGame(p);
  const broke = await p.evaluate(() => {
    const g = window.__game;
    const st = g.state();
    const answer = g.engine.corpus.cards.find(
      (c) => st.risk.keys.includes(c.id) && (c.tags.will !== '否' || c.tags.money !== '0' || c.tags.time !== '少')
    );
    if (!answer) return { skipped: true };
    g.engine.hand[0] = answer;
    g.engine.resources.money = 0;
    g.engine.resources.time = 0;
    g.engine.resources.will = 0;
    g.play(0, 0);
    return { title: answer.title.slice(0, 18) };
  });
  if (broke.skipped) {
    console.log('⑤ 找不到有成本的答案卡，跳过');
  } else {
    const toast = await p.evaluate(() => document.getElementById('toast').textContent);
    for (let i = 0; i < 40; i++) {
      if (await p.evaluate(() => !document.getElementById('lesson').hidden)) break;
      await p.waitForTimeout(250);
    }
    const lesson = await p.evaluate(() => ({
      verdict: document.getElementById('lesson-verdict').textContent,
      body: document.getElementById('lesson-body').textContent,
    }));
    console.log('⑤ 付不起:', JSON.stringify(broke.title), '| toast:', JSON.stringify(toast));
    check('付不起的提示是「出不起」', toast.includes('出不起'), toast);
    check('付不起的讲解卡标出原因', lesson.body.includes('出不起'), lesson.body.slice(0, 80));
    await dismissLesson(p);
  }

  /* ---------- ⑥ 暂停 ---------- */
  await freshGame(p);
  const pause = await p.evaluate(async () => {
    const g = window.__game;
    const a = g.scene.fallProgress();
    document.getElementById('pause-btn').click();
    const pausedNow = g.scene.isPaused;
    const overlay = !document.getElementById('paused').hidden;
    await new Promise((r) => setTimeout(r, 1600));
    const b = g.scene.fallProgress();
    document.getElementById('resume-btn').click();
    await new Promise((r) => setTimeout(r, 1600));
    const c = g.scene.fallProgress();
    return { a, b, c, pausedNow, overlay, stillPaused: g.scene.isPaused };
  });
  console.log('⑥ 暂停前后进度:', JSON.stringify(pause));
  check('暂停按钮进入暂停态', pause.pausedNow === true && pause.overlay === true, JSON.stringify(pause));
  check('暂停期间下落进度不动', pause.a === pause.b, `${pause.a} → ${pause.b}`);
  check('继续之后下落恢复', pause.c > pause.b, `${pause.b} → ${pause.c}`);
  check('继续之后不再是暂停态', pause.stillPaused === false, String(pause.stillPaused));

  /* ---------- ⑦ 结束 ---------- */
  const quit = await p.evaluate(() => {
    const g = window.__game;
    document.getElementById('quit-btn').click();
    return {
      over: g.state().over,
      cause: document.getElementById('settle-cause').textContent,
      visible: !document.getElementById('settle').hidden,
    };
  });
  console.log('⑦ 结束:', JSON.stringify(quit));
  check('结束按钮收局', quit.over === true && quit.visible === true, JSON.stringify(quit));
  check('死因写明是主动结束', quit.cause.includes('结束'), quit.cause);

  /* ---------- ⑧ 重开清旧数据 ---------- */
  const restart = await p.evaluate(async () => {
    const g = window.__game;
    // 先堆几层出来
    document.getElementById('settle').hidden = true;
    g.engine.start();
    for (let i = 0; i < 3; i++) {
      if (g.state().over) break;
      g.engine.passRisk();
      await new Promise((r) => setTimeout(r, 260));
      g.engine.resumeTurn();
    }
    const before = { layers: g.scene.debugState().layers, age: g.state().age };
    document.getElementById('again-btn').click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      before,
      after: { layers: g.scene.debugState().layers, turn: g.state().turn, age: g.state().age },
      lessonHidden: document.getElementById('lesson').hidden,
      pausedHidden: document.getElementById('paused').hidden,
    };
  });
  console.log('⑧ 重开:', JSON.stringify(restart));
  check('重开后井清空', restart.after.layers === 0, `${restart.before.layers} → ${restart.after.layers}`);
  check('重开后回到第 1 手', restart.after.turn === 1, String(restart.after.turn));
  check('重开后净值归位', restart.after.age === 88, String(restart.after.age));
  check('重开后讲解卡和暂停都收掉', restart.lessonHidden && restart.pausedHidden, JSON.stringify(restart));

  /* ---------- ⑨ HUD ---------- */
  const hud = await p.evaluate(() => ({
    age: document.getElementById('hud-age').textContent,
    turn: document.getElementById('hud-turn').textContent,
    turnMax: document.getElementById('hud-turn-max').textContent,
    layerMax: document.getElementById('hud-layer-max').textContent,
  }));
  console.log('⑨ HUD:', JSON.stringify(hud));
  check('HUD 分母来自常量', hud.turnMax === '/19' && hud.layerMax === '/10', `${hud.turnMax} ${hud.layerMax}`);

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
