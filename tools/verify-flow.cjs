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

(async () => {
  const b = await chromium.launch({
    executablePath: EXE,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-sandbox',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });

  const errs = [];
  p.on('console', (m) => {
    if (m.type() === 'error') errs.push('CONSOLE: ' + m.text());
  });
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  const shot = async (name) => {
    for (let i = 0; i < 4; i++) {
      try {
        await p.screenshot({ path: path.join(OUT, name), timeout: 40000 });
        return true;
      } catch {
        await p.waitForTimeout(2000);
      }
    }
    return false;
  };

  await p.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await p.waitForTimeout(4500);
  await shot('a-help.png');

  // 关掉规则开始
  await p.click('#help-close');
  await p.waitForTimeout(2500);

  const st1 = await p.evaluate(() => window.__game?.scene?.debugState?.() ?? null);
  console.log('① 开局:', JSON.stringify(st1));
  await shot('b-start.png');

  // 悬停第一张卡看详情
  const box = await p.evaluate(() => window.__game?.positions?.() ?? null);
  console.log('卡牌屏幕坐标:', JSON.stringify(box));

  if (box && box.length) {
    await p.mouse.move(box[0].x, box[0].y);
    await p.waitForTimeout(1200);
    // 详情面板早就从 #detail 换成了 #preview（VR 式 HUD），这里跟着改
    const det = await p.evaluate(() => {
      const d = document.getElementById('preview');
      return {
        open: !d.hidden,
        title: document.getElementById('pv-title').textContent.slice(0, 20),
        pos: document.getElementById('pv-pos').textContent,
      };
    });
    console.log('② 悬停预览:', JSON.stringify(det));
    await shot('c-hover.png');
  }

  // 找一张能对上的卡并点它
  const pick = await p.evaluate(() => window.__game?.playable?.() ?? null);
  console.log('可出的牌:', JSON.stringify(pick));
  if (pick && pick.index >= 0 && pick.pos) {
    await p.mouse.move(pick.pos.x, pick.pos.y);
    await p.waitForTimeout(300);
    await p.mouse.click(pick.pos.x, pick.pos.y);
    await p.waitForTimeout(1600);
    await shot('d-cleared.png');
    const st2 = await p.evaluate(() => window.__game?.scene?.debugState?.() ?? null);
    console.log('③ 出牌后:', JSON.stringify(st2));
  }

  // 一路放过直到结算，看层堆起来 + 结算页
  for (let i = 0; i < 14; i++) {
    const over = await p.evaluate(() => !document.getElementById('settle').hidden);
    if (over) break;
    await p.click('#pass-btn');
    await p.waitForTimeout(1200);
  }
  await p.waitForTimeout(2000);
  await shot('f-settle.png');
  const settle = await p.evaluate(() => ({
    hidden: document.getElementById('settle').hidden,
    age: document.getElementById('settle-age').textContent,
    cause: document.getElementById('settle-cause').textContent,
    saves: [...document.querySelectorAll('#settle-saves li')].map((li) => li.textContent),
  }));
  console.log('⑥ 结算:', JSON.stringify(settle));
  const st3 = await p.evaluate(() => window.__game?.scene?.debugState?.() ?? null);
  console.log('④ 放过两手后:', JSON.stringify(st3));
  await shot('e-layers.png');

  const ui = await p.evaluate(() => ({
    age: document.getElementById('hud-age').textContent,
    cleared: document.getElementById('hud-cleared').textContent,
    layers: document.getElementById('hud-layers').textContent,
    will: document.getElementById('res-will-v').textContent,
  }));
  console.log('⑤ HUD:', JSON.stringify(ui));

  // 导出分享图，验证传播物能真的画出来
  const dataUrl = await p.evaluate(() => {
    const btn = document.getElementById('share-btn');
    if (!btn) return null;
    const cv = document.createElement('canvas');
    return 'skip';
  });
  try {
    const cv = await p.evaluate(async () => {
      const mod = await import('/src/scene/textures.ts');
      const g = await import('/src/data/groups.ts');
      const st = window.__game.state();
      const last = st.landed[st.landed.length - 1];
      const canvas = mod.makeShareCard({
        age: st.age,
        cause: last ? last.title : '意外',
        scene: last ? last.scene : '',
        survived: st.landed.length,
        layers: st.landed.map((r) => ({ group: r.group, title: r.title, color: g.GROUPS[r.group].css })),
        saves: [],
        cleared: st.cleared,
      });
      return canvas.toDataURL('image/png');
    });
    if (cv && cv.startsWith('data:image')) {
      fs.writeFileSync(path.join(OUT, 'g-share.png'), Buffer.from(cv.split(',')[1], 'base64'));
      console.log('⑦ 分享图已导出');
    }
  } catch (e) {
    console.log('分享图导出失败:', e.message);
  }

  console.log('错误数:', errs.length);
  errs.slice(0, 8).forEach((e) => console.log('  ', e));
  await b.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
