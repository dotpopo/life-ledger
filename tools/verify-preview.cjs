const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const EXE = path.join(
  process.env.LOCALAPPDATA,
  'ms-playwright',
  'chromium_headless_shell-1243',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe'
);
// 截图写到仓库根的 .shots/，不要写死本机路径，别人克隆下来也能跑
const OUT = path.join(__dirname, '..', '.shots');
fs.mkdirSync(OUT, { recursive: true });
const ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu-sandbox',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
];

(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ARGS });
  const errs = [];
  const fails = [];
  /** 真正断言，不只是打日志：失败会汇总到末尾并把退出码置 1 */
  const check = (name, ok, detail = '') => {
    console.log(`   ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) fails.push(name);
  };
  const shot = async (p, name) => {
    for (let i = 0; i < 3; i++) {
      try {
        await p.screenshot({ path: path.join(OUT, name), timeout: 40000 });
        return;
      } catch {
        await p.waitForTimeout(1500);
      }
    }
  };
  const waitBoot = async (p) => {
    for (let i = 0; i < 60; i++) {
      if (await p.evaluate(() => !document.getElementById('boot'))) return;
      await p.waitForTimeout(400);
    }
  };
  const pvState = (p) =>
    p.evaluate(() => {
      const el = document.getElementById('preview');
      if (!el || el.hidden) return { open: false };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        open: true,
        pos: document.getElementById('pv-pos').textContent,
        title: document.getElementById('pv-title').textContent.slice(0, 18),
        group: document.getElementById('pv-group').textContent,
        页码点: (() => {
          const ds = Array.from(document.querySelectorAll('#pv-dots .pv-dot'));
          return `${ds.length} 个 / 第 ${ds.findIndex((d) => d.classList.contains('is-on')) + 1} 个亮`;
        })(),
        背景: cs.backgroundColor,
        模糊: cs.backdropFilter,
        矩形: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      };
    });

  /* ================= 桌面端 ================= */
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  await p.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await waitBoot(p);
  await p.click('#help-close');
  await p.waitForTimeout(2200);

  /*
   * 这里的两条约束决定了下面的写法，别改回去：
   * 1) #preview 挂着 7.5s 无限循环的 pvFloat 浮动动画，包围盒逐帧都在变。
   *    Playwright 的 actionability 要求「连续两帧包围盒完全一致」，
   *    对面板内部按钮用普通 click 永远等不到 stable，会 30s 超时。
   *    → 面板内部的按钮一律 force 点。
   * 2) 游戏时钟一直在走，风险落地进下一手时 onHand 会 closePreview()。
   *    → 每次交互前重新悬停一次把面板拉回来（被关过说明 pvPinned 已复位，
   *      悬停就会重新打开）。
   */
  const hoverCard = async (i = 0) => {
    /*
     * 先挪开、再挪回来。
     * 鼠标如果已经停在这张牌上，再 move 到同一坐标不会产生 pointermove，
     * three.js 的悬停判定就不会重新触发，预览也就不会重开
     * （表现为后面读到 undefined）。
     */
    await p.mouse.move(720, 210);
    await p.waitForTimeout(140);
    const pos = await p.evaluate(() => window.__game.positions());
    await p.mouse.move(pos[i].x, pos[i].y);
    await p.waitForTimeout(500);
  };

  await hoverCard(0);
  const d1 = await pvState(p);
  console.log('① 桌面悬停出预览:', JSON.stringify(d1));
  await shot(p, 'pv-desktop.png');

  // 点下一张，并且检查是否固定（鼠标移开后仍留着）
  await p.click('#pv-next', { force: true });
  await p.waitForTimeout(400);
  const d2 = await pvState(p);
  await p.mouse.move(700, 120);
  await p.waitForTimeout(700);
  const d3 = await pvState(p);
  console.log('② 点下一张:', JSON.stringify(d2));
  console.log('   鼠标移开后是否还留着（固定）:', d3.open, '位置:', d3.pos);

  // 预览有没有压住手牌
  await hoverCard(0);
  const cover = await p.evaluate(() => {
    const r = document.getElementById('preview').getBoundingClientRect();
    const cards = window.__game.positions();
    const hit = cards.filter((c) => {
      const w = 130, h = 150;
      return !(c.x + w <= r.left || c.x - w >= r.right || c.y + h <= r.top || c.y - h >= r.bottom);
    });
    return { 遮住手牌数: hit.length };
  });
  console.log('③ 预览遮住手牌:', JSON.stringify(cover));

  // 键盘切换 + Esc
  await hoverCard(0);
  await p.keyboard.press('ArrowLeft');
  await p.waitForTimeout(300);
  const d4 = await pvState(p);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  const d5 = await pvState(p);
  console.log('④ 方向键切换:', d4.pos, '→ Esc 关闭:', d5.open);

  /* ---------- 循环翻页 + 点空白退出（用户报的三个问题） ---------- */
  /** 先关掉（顺带解掉固定），再悬停 → 保证从第 1 张重新打开 */
  const resetPreview = async () => {
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    await hoverCard(0);
  };

  // ⑤ 循环：第 1 张往前翻应该绕到最后一张，而不是卡住
  await resetPreview();
  const w0 = await pvState(p);
  await p.keyboard.press('ArrowLeft');
  await p.waitForTimeout(350);
  const w1 = await pvState(p);
  console.log('⑤ 循环翻页:', w0.pos, '往前翻 →', w1.pos);
  check('第 1 张往前翻绕到最后一张', w0.pos === '1/3' && w1.pos === '3/3', `${w0.pos} → ${w1.pos}`);

  // ⑥ 点画布空白处应该退出预览
  await resetPreview();
  const b0 = await pvState(p);
  await p.mouse.click(720, 210); // 井的中段：没有手牌，也没有面板
  await p.waitForTimeout(400);
  const b1 = await pvState(p);
  console.log('⑥ 点画布空白:', b0.open, '→', b1.open);
  check('点画布空白退出预览', b0.open === true && b1.open === false, `${b0.open} → ${b1.open}`);

  // ⑦ 点预览面板自己的空白处（半透明，用户眼里就是空白）也要退出
  await resetPreview();
  const c0 = await pvState(p);
  const pvBlank = await p.evaluate(() => {
    const r = document.getElementById('pv-body').getBoundingClientRect();
    return { x: Math.round(r.left + 18), y: Math.round(r.bottom - 8) };
  });
  await p.mouse.click(pvBlank.x, pvBlank.y);
  await p.waitForTimeout(400);
  const c1 = await pvState(p);
  console.log('⑦ 点面板空白:', c0.open, '→', c1.open);
  check('点面板空白退出预览', c0.open === true && c1.open === false, `${c0.open} → ${c1.open}`);

  // ⑧ 页码点：有几张、现在第几张
  await resetPreview();
  const e0 = await pvState(p);
  check('页码点数量与高亮正确', e0.页码点 === '3 个 / 第 1 个亮', e0.页码点);

  // ⑨ 三个选项的按钮文案必须完全一致：
  //    一旦按「对不上 / 资源不够」变文案，就等于替玩家把答案挑出来了
  await resetPreview();
  const btnTexts = [];
  for (let i = 0; i < 3; i++) {
    const st = await pvState(p);
    const btn = await p.evaluate(() => ({
      text: document.getElementById('pv-play').textContent,
      disabled: document.getElementById('pv-play').disabled,
    }));
    btnTexts.push(`${st.pos}「${btn.text}」${btn.disabled ? '(禁用)' : ''}`);
    await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(300);
  }
  console.log('⑨ 三个选项的按钮:', JSON.stringify(btnTexts));
  const uniform = new Set(btnTexts.map((s) => s.replace(/^\d\/\d/, ''))).size === 1;
  check('三个选项按钮呈现一致（不泄题）', uniform, btnTexts.join(' | '));

  /* ================= 手机端 ================= */
  const mctx = await b.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    isMobile: true,
    hasTouch: true,
  });
  const m = await mctx.newPage();
  m.on('pageerror', (e) => errs.push('MOBILE PAGEERROR: ' + e.message));
  await m.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await waitBoot(m);
  await m.click('#help-close');
  await m.waitForTimeout(2400);

  /*
   * 手机端必须用真实触摸事件（CDP Input.dispatchTouchEvent）。
   * Playwright 的 mouse.* 产生的是鼠标事件，不经过浏览器的触摸手势仲裁，
   * 用它测滑动会得到假绿：曾经横滑真的被浏览器发了 pointercancel、
   * 面板根本换不了张，而鼠标测法照样「通过」。
   */
  const cdp = await mctx.newCDPSession(m);
  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({ x: p.x, y: p.y, radiusX: 6, radiusY: 6, force: 1 })),
    });
  const touchSwipe = async (x0, y, dx) => {
    await touch('touchStart', [{ x: x0, y }]);
    for (let i = 1; i <= 8; i++) {
      await m.waitForTimeout(35);
      await touch('touchMove', [{ x: x0 + (dx * i) / 8, y }]);
    }
    await touch('touchEnd', []);
    await m.waitForTimeout(500);
  };

  // 记录面板收到的指针事件，用来抓「被浏览器 pointercancel 打断」这类回归
  await m.evaluate(() => {
    window.__pvEvents = [];
    const el = document.getElementById('preview');
    for (const t of ['pointerdown', 'pointerup', 'pointercancel']) {
      el.addEventListener(t, () => window.__pvEvents.push(t), true);
    }
  });

  const mpos = await m.evaluate(() => window.__game.positions());
  const clearedBefore = await m.evaluate(() => window.__game.state().cleared);
  console.log('   长按之前 picks:', JSON.stringify(await m.evaluate(() => window.__game.picks())));

  // ⑤ 长按第二张（真实触摸）
  await touch('touchStart', [{ x: mpos[1].x, y: mpos[1].y }]);
  await m.waitForTimeout(700);
  await touch('touchEnd', []);
  await m.waitForTimeout(600);

  const clearedAfter = await m.evaluate(() => window.__game.state().cleared);
  const m1 = await pvState(m);
  console.log('⑤ 手机长按:', JSON.stringify(m1));
  check('手机长按打开预览', m1.open === true && m1.pos === '2/3', `${m1.open} / ${m1.pos}`);
  check('长按没有误出牌', clearedBefore === clearedAfter, `${clearedBefore} → ${clearedAfter}`);
  console.log('   出牌入口被触发记录:', JSON.stringify(await m.evaluate(() => window.__game.picks())));
  await shot(m, 'pv-mobile.png');

  // ⑥ 左滑（真实触摸）→ 下一张
  const pr = await m.evaluate(() => {
    const r = document.getElementById('preview').getBoundingClientRect();
    return { x: Math.round(r.right - 40), y: Math.round(r.top + r.height * 0.45) };
  });
  await touchSwipe(pr.x, pr.y, -88);
  const m2 = await pvState(m);
  console.log('⑥ 手机左滑:', m1.pos, '→', m2.pos);
  check('手机左滑切到下一张', m1.pos === '2/3' && m2.pos === '3/3', `${m1.pos} → ${m2.pos}`);
  await shot(m, 'pv-mobile-swiped.png');

  // ⑦ 再左滑一次：3/3 应该绕回 1/3
  await touchSwipe(pr.x, pr.y, -88);
  const m3 = await pvState(m);
  console.log('⑦ 手机左滑绕回:', m2.pos, '→', m3.pos);
  check('手机左滑从最后一张绕回第一张', m2.pos === '3/3' && m3.pos === '1/3', `${m2.pos} → ${m3.pos}`);

  // ⑧ 关键回归：整段滑动里面板不能收到 pointercancel
  const pvEvents = await m.evaluate(() => window.__pvEvents);
  console.log('⑧ 面板收到的指针事件:', JSON.stringify(pvEvents));
  check(
    '横滑没有被浏览器 pointercancel 打断',
    !pvEvents.includes('pointercancel'),
    JSON.stringify(pvEvents)
  );

  const mcover = await m.evaluate(() => {
    const r = document.getElementById('preview').getBoundingClientRect();
    const cards = window.__game.positions();
    return {
      预览矩形: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      手牌y: cards.map((c) => c.y),
      遮住手牌: cards.filter((c) => {
        const w = 70, h = 90;
        return !(c.x + w <= r.left || c.x - w >= r.right || c.y + h <= r.top || c.y - h >= r.bottom);
      }).length,
    };
  });
  console.log('⑨ 手机端遮挡:', JSON.stringify(mcover));

  // ⑩ 手机点面板空白处也要退出预览
  const mOpen = await pvState(m);
  const mBlank = await m.evaluate(() => {
    const r = document.getElementById('pv-body').getBoundingClientRect();
    return { x: Math.round(r.left + 18), y: Math.round(r.bottom - 8) };
  });
  await m.mouse.click(mBlank.x, mBlank.y);
  await m.waitForTimeout(400);
  const mClosed = await pvState(m);
  console.log('⑩ 手机点面板空白:', mOpen.open, '→', mClosed.open);
  check('手机点面板空白退出预览', mOpen.open === true && mClosed.open === false, `${mOpen.open} → ${mClosed.open}`);

  const age = await m.evaluate(() => document.getElementById('hud-age').textContent);
  console.log('⑪ 起始净值:', age);

  console.log('错误数:', errs.length);
  errs.slice(0, 6).forEach((e) => console.log('  ', e));
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
