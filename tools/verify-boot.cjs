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

  /* ---------- ① 完全禁用 JS：证明启动屏不依赖 JS ---------- */
  const noJs = await b.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  const p1 = await noJs.newPage();
  await p1.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p1.waitForTimeout(600);
  await shot(p1, 'boot-nojs.png');
  const probe = await p1.evaluate(() => 'js-on').catch(() => 'js-off');
  console.log('① 禁用 JS 时 evaluate 结果:', probe, '（应为 js-off，证明这张图里没有任何 JS 参与）');
  await noJs.close();

  /* ---------- ② 模拟慢网：把语料延迟 6 秒 ---------- */
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const p2 = await ctx.newPage();
  await p2.route('**/cards.json', async (route) => {
    await new Promise((r) => setTimeout(r, 6000));
    await route.continue();
  });

  await p2.goto('http://127.0.0.1:3100/', { waitUntil: 'commit', timeout: 30000 });
  await p2.waitForTimeout(1200);
  await shot(p2, 'boot-loading.png');
  const mid = await p2.evaluate(() => {
    const b = document.getElementById('boot');
    return {
      boot存在: !!b,
      boot可见: b ? getComputedStyle(b).opacity : null,
      状态文字: b?.querySelector('.boot-status')?.textContent ?? null,
      进度: b?.querySelector('.boot-bar i')?.style.inlineSize ?? null,
    };
  });
  console.log('② 加载中:', JSON.stringify(mid));

  await p2.waitForTimeout(2000);
  await shot(p2, 'boot-loading2.png');
  const mid2 = await p2.evaluate(() => ({
    状态文字: document.querySelector('.boot-status')?.textContent ?? null,
    进度: document.querySelector('.boot-bar i')?.style.inlineSize ?? null,
  }));
  console.log('   稍后:', JSON.stringify(mid2));

  // 等启动屏消失
  for (let i = 0; i < 40; i++) {
    const done = await p2.evaluate(() => !document.getElementById('boot'));
    if (done) break;
    await p2.waitForTimeout(500);
  }
  const after = await p2.evaluate(() => ({
    启动屏已移除: !document.getElementById('boot'),
    资源栏有样式: getComputedStyle(document.getElementById('res')).position,
    规则页可见: !document.getElementById('help').hidden,
  }));
  console.log('③ 启动完成后:', JSON.stringify(after));
  await shot(p2, 'boot-done.png');

  /* ---------- ③ 启动失败时的表现 ---------- */
  const ctx3 = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const p3 = await ctx3.newPage();
  await p3.route('**/cards.json', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await p3.goto('http://127.0.0.1:3100/', { waitUntil: 'commit', timeout: 30000 });
  await p3.waitForTimeout(3500);
  const fail = await p3.evaluate(() => ({
    状态文字: document.querySelector('.boot-status')?.textContent ?? null,
    错误文本: document.querySelector('.boot-error')?.textContent ?? null,
  }));
  console.log('④ 语料 500 时:', JSON.stringify(fail));
  await shot(p3, 'boot-fail.png');

  await b.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
