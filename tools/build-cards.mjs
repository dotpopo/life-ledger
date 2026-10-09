/**
 * 把 HowToLiveBetter 的 book/*.md 解析成结构化 JSON。
 *
 * 源格式（每条高度规整）：
 *   ### N. 标题
 *   <!-- 成本标签: 钱=0 时间=少 毅力=否 收益=大 口径=死亡率 -->
 *   - 成本：…
 *   - 说人话：…
 *   - 收益：…
 *   - 证据等级：A
 *   - 来源：…
 *   - 备注：…
 *
 * 用法：
 *   node tools/build-cards.mjs [书稿目录]
 * 默认读 ../.htlb/HowToLiveBetter/book
 *
 * 内容许可：CC BY 4.0（署名 eternity4719 / HowToLiveBetter）。本文件只做结构化，
 * 不改写任何正文，生成的 JSON 里保留原始出处。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BOOK_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(ROOT, '..', '.htlb', 'HowToLiveBetter', 'book');
const OUT = path.resolve(ROOT, 'public', 'cards.json');

/**
 * 34 章归到 7 个域。分组只用于玩法的风险匹配，不改动正文归属。
 * 第 06 章「反面清单」讲的是「做了也没用甚至有害的事」，单列成「误区」，
 * 不能塞进「法律」（原来这么分是错的，会把讲维生素的条目归到法律）。
 */
const GROUP_OF = {
  '01': '身体', '02': '身体', '13': '身体', '16': '身体', '21': '身体',
  '24': '身体', '27': '身体', '28': '身体', '33': '身体', '34': '身体',
  '03': '精力', '04': '精力', '22': '精力', '29': '精力',
  '05': '钱', '07': '钱', '12': '钱', '15': '钱',
  '08': '法律', '09': '法律', '11': '法律', '14': '法律', '26': '法律',
  '19': '工作', '23': '工作', '31': '工作', '32': '工作',
  '10': '家庭', '17': '家庭', '18': '家庭', '20': '家庭', '25': '家庭', '30': '家庭',
  '06': '误区',
};

const FIELD_RE = /^-\s*(成本|说人话|收益|证据等级|来源|备注)\s*[:：]\s*(.*)$/;
const ENTRY_RE = /^#{3}\s+(\d+)\.\s+(.+?)\s*$/;
const TAG_RE = /<!--\s*成本标签\s*:\s*(.*?)\s*-->/;
const CHAP_RE = /^#\s+(\d+)\.\s+(.+?)\s*$/;

/** 把「来源」那一行拆成条目数组，并抽出链接 */
function parseSources(raw) {
  if (!raw) return [];
  return raw
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => {
      const links = [...text.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
      return { text: text.replace(/<[^>]+>/g, '').trim(), links };
    });
}

/** 解析「钱=0 时间=少 毅力=否 收益=大 口径=死亡率」 */
function parseTags(raw) {
  const out = { money: '', time: '', will: '', gain: '', lens: '' };
  if (!raw) return out;
  for (const part of raw.split(/\s+/)) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (key === '钱') out.money = val;
    else if (key === '时间') out.time = val;
    else if (key === '毅力') out.will = val;
    else if (key === '收益') out.gain = val;
    else if (key === '口径') out.lens = val;
  }
  return out;
}

function main() {
  if (!fs.existsSync(BOOK_DIR)) {
    console.error(`找不到书稿目录：${BOOK_DIR}`);
    console.error('先克隆：git clone https://github.com/eternity4719/HowToLiveBetter');
    process.exit(1);
  }

  const files = fs
    .readdirSync(BOOK_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const chapters = [];
  const cards = [];
  const groupCount = {};

  for (const file of files) {
    const chapterId = file.slice(0, 2);
    const text = fs.readFileSync(path.join(BOOK_DIR, file), 'utf8');
    const lines = text.split(/\r?\n/);

    let chapterTitle = file.replace(/^\d+-/, '').replace(/\.md$/, '');
    const chapterGroup = GROUP_OF[chapterId] ?? '身体';
    let chapterCardCount = 0;

    let cur = null;
    const flush = () => {
      if (!cur) return;
      const id = `${chapterId}-${cur.num}`;
      cards.push({
        id,
        chapter: chapterId,
        chapterTitle,
        group: chapterGroup,
        num: cur.num,
        title: cur.title,
        tags: cur.tags,
        grade: cur.grade,
        costText: cur.cost,
        plain: cur.plain,
        gainText: cur.gain,
        note: cur.note,
        sources: parseSources(cur.src),
      });
      chapterCardCount += 1;
      cur = null;
    };

    for (const line of lines) {
      const chap = line.match(CHAP_RE);
      if (chap && chap[1] === String(Number(chapterId))) {
        chapterTitle = chap[2].trim();
        continue;
      }

      const entry = line.match(ENTRY_RE);
      if (entry) {
        flush();
        cur = {
          num: Number(entry[1]),
          title: entry[2].trim(),
          tags: { money: '', time: '', will: '', gain: '', lens: '' },
          grade: '',
          cost: '',
          plain: '',
          gain: '',
          note: '',
          src: '',
        };
        continue;
      }

      if (!cur) continue;

      const tag = line.match(TAG_RE);
      if (tag) {
        cur.tags = parseTags(tag[1]);
        continue;
      }

      const field = line.match(FIELD_RE);
      if (field) {
        const [, key, value] = field;
        if (key === '成本') cur.cost = value;
        else if (key === '说人话') cur.plain = value;
        else if (key === '收益') cur.gain = value;
        else if (key === '证据等级') cur.grade = value;
        else if (key === '来源') cur.src = value;
        else if (key === '备注') cur.note = value;
      }
    }
    flush();

    chapters.push({
      id: chapterId,
      title: chapterTitle,
      group: chapterGroup,
      count: chapterCardCount,
    });
    groupCount[chapterGroup] = (groupCount[chapterGroup] ?? 0) + chapterCardCount;
  }

  const gradeCount = {};
  for (const c of cards) {
    const g = (c.grade.match(/^[ABC]/) ?? ['?'])[0];
    gradeCount[g] = (gradeCount[g] ?? 0) + 1;
  }

  const payload = {
    source: {
      name: '高性价比人生指南',
      repo: 'https://github.com/eternity4719/HowToLiveBetter',
      author: 'eternity4719',
      license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      note: '正文、成本、收益、证据等级与来源均来自原书，未作改写。成本栏原书声明为按市面价格的粗略估计，不用于引用。',
    },
    generatedAt: new Date().toISOString(),
    stats: {
      cards: cards.length,
      chapters: chapters.length,
      byGroup: groupCount,
      byGrade: gradeCount,
    },
    chapters,
    cards,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload), 'utf8');

  console.log(`解析完成 → ${path.relative(ROOT, OUT)}`);
  console.log(`  条目 ${cards.length} 条 / 章节 ${chapters.length} 章`);
  console.log(`  分组 ${JSON.stringify(groupCount)}`);
  console.log(`  证据 ${JSON.stringify(gradeCount)}`);

  const noTag = cards.filter((c) => !c.tags.gain).length;
  const noPlain = cards.filter((c) => !c.plain).length;
  const noGrade = cards.filter((c) => !c.grade).length;
  console.log(`  缺成本标签 ${noTag} / 缺说人话 ${noPlain} / 缺证据等级 ${noGrade}`);
}

main();
