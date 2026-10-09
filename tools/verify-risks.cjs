/*
 * 校验风险池。
 *
 * 这个文件存在的理由：risk.keys 是手写的条号（章-条），
 * 写错一个字母，游戏里就会出现「答案卡根本不在手上」的死局，
 * 而这种错误在跑游戏时几乎看不出来。所以对着 public/cards.json 硬校验。
 *
 * 同时报告覆盖率，防止「题库悄悄又变回十几条」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'cards.json'), 'utf8'));
const byId = new Map(corpus.cards.map((c) => [c.id, c]));

// 直接从 risks.ts 里抽 R(...) 调用，不为测试去引 TypeScript
const src = fs.readFileSync(path.join(ROOT, 'src', 'data', 'risks.ts'), 'utf8');
const re =
  /R\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*\[([^\]]+)\]\s*\)/g;
const risks = [];
let m;
while ((m = re.exec(src))) {
  risks.push({
    id: m[1],
    group: m[2],
    title: m[3],
    scene: m[4],
    keys: [...m[5].matchAll(/'([^']+)'/g)].map((x) => x[1]),
  });
}

const fails = [];
const seen = new Set();
for (const r of risks) {
  if (seen.has(r.id)) fails.push(`id 重复: ${r.id}`);
  seen.add(r.id);
  if (!r.keys.length) fails.push(`${r.id} 一条 keys 都没有`);
  if (r.title.length > 8) fails.push(`${r.id} 标题超过 8 字：${r.title}`);
  if (!r.scene) fails.push(`${r.id} 没有情境`);
  for (const k of r.keys) {
    if (!byId.has(k)) fails.push(`${r.id} 的 key 不存在：${k}`);
  }
}

const used = new Set(risks.flatMap((r) => r.keys));
const chapters = new Set();
for (const k of used) chapters.add(byId.get(k).chapter);
const byGroup = {};
for (const r of risks) byGroup[r.group] = (byGroup[r.group] || 0) + 1;

console.log('风险条数:', risks.length, '（曾经只有 18 条）');
console.log(
  '用到的答案卡:',
  used.size,
  '/',
  corpus.cards.length,
  `(${Math.round((used.size / corpus.cards.length) * 100)}%)`
);
console.log('覆盖章节:', chapters.size, '/', corpus.chapters.length);
console.log('按域分布:', JSON.stringify(byGroup));
const avgKeys = (risks.reduce((s, r) => s + r.keys.length, 0) / risks.length).toFixed(2);
console.log('平均每条几个答案:', avgKeys);

if (fails.length) {
  console.log('❌ 失败:');
  fails.forEach((f) => console.log('   ', f));
  process.exitCode = 1;
} else {
  console.log('✅ 全部通过');
}
