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

  const shot = async (p, name) => {
    for (let i = 0; i < 4; i++) {
      try {
        await p.screenshot({ path: path.join(OUT, name), timeout: 40000 });
        return;
      } catch {
        await p.waitForTimeout(2000);
      }
    }
  };

  /* ---------- 桌面端：堆到 5 层的状态 ---------- */
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  p.on('console', (m) => {
    if (m.type() === 'error') errs.push('CONSOLE: ' + m.text());
  });
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  await p.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await p.waitForTimeout(4000);
  await p.click('#help-close');
  await p.waitForTimeout(2200);

  for (let i = 0; i < 5; i++) {
    await p.click('#pass-btn');
    await p.waitForTimeout(1100);
  }
  await p.waitForTimeout(1200);
  const st = await p.evaluate(() => window.__game.scene.debugState());
  console.log('桌面端堆层状态:', JSON.stringify(st));
  await shot(p, 'final-layers.png');

  const hud = await p.evaluate(() => ({
    age: document.getElementById('hud-age').textContent,
    layers: document.getElementById('hud-layers').textContent,
    danger: getComputedStyle(document.querySelector('.res-row.is-key .res-track i')).backgroundColor,
  }));
  console.log('HUD:', JSON.stringify(hud));

  /* ---------- 手机端 ---------- */
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    isMobile: true,
    hasTouch: true,
  });
  const m = await ctx.newPage();
  m.on('pageerror', (e) => errs.push('MOBILE PAGEERROR: ' + e.message));
  await m.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await m.waitForTimeout(4000);
  await m.click('#help-close');
  await m.waitForTimeout(2500);
  await shot(m, 'final-mobile.png');
  const mob = await m.evaluate(() => {
    const cards = window.__game.positions();
    return {
      viewport: [innerWidth, innerHeight],
      cards,
      inView: cards.every((c) => c.x > 0 && c.x < innerWidth && c.y > 0 && c.y < innerHeight),
      res: document.getElementById('res').getBoundingClientRect().width,
    };
  });
  console.log('手机端:', JSON.stringify(mob));

  console.log('错误数:', errs.length);
  errs.slice(0, 6).forEach((e) => console.log('  ', e));
  await b.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
