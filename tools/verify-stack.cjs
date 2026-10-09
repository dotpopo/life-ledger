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
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  await p.goto('http://localhost:3100/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await p.waitForTimeout(4000);
  await p.click('#help-close');

  // 关键：一张牌都不出，让风险全部自然落地
  const marks = [];
  for (let i = 0; i < 5; i++) {
    for (let w = 0; w < 60; w++) {
      const n = await p.evaluate(() => window.__game.scene.debugState().layers);
      if (n >= i + 1) break;
      await p.waitForTimeout(500);
    }
    const st = await p.evaluate(() => window.__game.scene.debugState());
    marks.push({ 第几层: st.layers, layerYs: st.layerYs });
  }

  console.log('=== 自然落地，逐层检查 ===');
  for (const m of marks) console.log('  ', JSON.stringify(m));

  const final = await p.evaluate(() => window.__game.scene.debugState());
  const ys = final.layerYs;
  const ascending = ys.every((y, i) => i === 0 || y > ys[i - 1]);
  const spacing = ys.length > 1 ? Number((ys[1] - ys[0]).toFixed(2)) : 0;
  console.log('=== 结论 ===');
  console.log('  层数:', ys.length);
  console.log('  各层 y:', JSON.stringify(ys));
  console.log('  是否严格递增（真堆叠）:', ascending);
  console.log('  层间距:', spacing, '（应为 1）');

  const hud = await p.evaluate(() => document.getElementById('hud-layers').textContent);
  console.log('  HUD 显示层数:', hud);

  for (let i = 0; i < 4; i++) {
    try {
      await p.screenshot({ path: path.join(OUT, 'stack.png'), timeout: 40000 });
      break;
    } catch {
      await p.waitForTimeout(2000);
    }
  }

  console.log('错误数:', errs.length);
  await b.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
