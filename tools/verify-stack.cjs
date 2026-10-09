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
  await p.click('#start .start-card[data-mode="game"]');
  await p.waitForTimeout(400);
  await p.click('#help-close');

  /*
   * 一张牌都不出，让风险全部落地堆起来。
   *
   * 三个坑：
   * 1. 每次落地都会弹讲解卡并 hold 住回合，不点掉就再也不会有下一块方块。
   * 2. 下落时长已经放慢到 24s（首手），加上无头软渲染的固定步长钳制，
   *    真等自然落地要一分钟以上。所以用 scene.slamRisk() 加速下坠。
   *    它走的是**同一条** riskLanded → bankLanded → settleFalling 路径，
   *    只是把剩余时长压短，堆叠逻辑照样被完整覆盖。
   * 3. **每块方块只能砸一次**。slamRisk 会把下落计时重置成 0，
   *    反复调用等于每 180ms 把进度清零，方块永远到不了底。
   */
  const marks = [];
  let slammed = false;
  for (let i = 0; i < 5; i++) {
    for (let w = 0; w < 100; w++) {
      const st = await p.evaluate(() => ({
        layers: window.__game.scene.debugState().layers,
        falling: window.__game.scene.debugState().falling,
        lesson: !document.getElementById('lesson').hidden,
        over: window.__game.state().over,
      }));
      if (st.layers >= i + 1 || st.over) break;
      if (st.lesson) {
        // 读完讲解，开下一手，下一块方块可以重新砸
        await p.click('#lesson-next');
        slammed = false;
      } else if (st.falling && !slammed) {
        await p.evaluate(() => window.__game.scene.slamRisk());
        slammed = true;
      }
      await p.waitForTimeout(180);
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
