import './style.css';
import { WellScene } from './scene/WellScene.js';
import {
  Engine,
  MAX_LAYERS,
  PERFECT_AGE,
  TOTAL_TURNS,
  costOf,
  type Resources,
  type ScoreBreakdown,
  type Summary,
} from './engine.js';
import type { Corpus } from './types.js';
import { GROUPS, GRADE_META, gradeOf } from './data/groups.js';
import { makeShareCard } from './scene/textures.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- DOM ---------- */
const canvas = $<HTMLCanvasElement>('stage');
const hudAge = $('hud-age');
const hudTurn = $('hud-turn');
const hudCleared = $('hud-cleared');
const hudLayers = $('hud-layers');

const resMoney = $('res-money');
const resTime = $('res-time');
const resWill = $('res-will');
const resMoneyV = $('res-money-v');
const resTimeV = $('res-time-v');
const resWillV = $('res-will-v');

const riskEl = $('risk');
const riskGroup = $('risk-group');
const riskTitle = $('risk-title');
const riskHint = $('risk-hint');

const previewEl = $('preview');
const pvGroup = $('pv-group');
const pvId = $('pv-id');
const pvPos = $('pv-pos');
const pvDots = $('pv-dots');
const pvTitle = $('pv-title');
const pvPlain = $('pv-plain');
const pvMeta = $('pv-meta');
const pvSrc = $('pv-src');
const pvBody = $('pv-body');
const pvPlay = $<HTMLButtonElement>('pv-play');

const toastEl = $('toast');
const settleEl = $('settle');
const helpEl = $('help');
const passBtn = $<HTMLButtonElement>('pass-btn');

/* ---------- 启动屏 ---------- */
const bootEl = document.getElementById('boot');
const bootStatus = bootEl?.querySelector<HTMLElement>('.boot-status') ?? null;
const bootBar = bootEl?.querySelector<HTMLElement>('.boot-bar i') ?? null;
const bootStart = performance.now();

function setBoot(pct: number, text: string) {
  if (bootBar) bootBar.style.inlineSize = `${pct}%`;
  if (bootStatus) bootStatus.textContent = text;
}

/** 关掉启动屏。留一个最短展示时间，否则网络快的时候会一闪而过，看着像闪屏。 */
async function hideBoot() {
  if (!bootEl) return;
  setBoot(100, '就绪');
  const elapsed = performance.now() - bootStart;
  const wait = Math.max(0, 520 - elapsed);
  await new Promise((r) => setTimeout(r, wait));
  bootEl.classList.add('is-gone');
  window.setTimeout(() => bootEl.remove(), 620);
}

/** 启动失败时不要把整个 body 换掉，那样连启动屏都没了，只剩一行裸文本 */
function failBoot(err: unknown) {
  if (!bootEl) return;
  const ring = bootEl.querySelector('.boot-ring');
  ring?.remove();
  const bar = bootEl.querySelector('.boot-bar');
  bar?.remove();
  if (bootStatus) bootStatus.textContent = '启动失败';
  const pre = document.createElement('p');
  pre.className = 'boot-error';
  pre.textContent = String(err instanceof Error ? err.message : err);
  bootEl.appendChild(pre);
}

let scene: WellScene;
let engine: Engine;
let corpus: Corpus;
let toastTimer = 0;
let scorePopTimer = 0;
let lastSummary: Summary | null = null;
/** 出牌入口被触发过几次。长按预览绝不该让它增加。 */
let pickCount = 0;
const pickLog: string[] = [];

const RES_CAP: Resources = { money: 12, time: 10, will: 8 };

/* ============================================================
   启动
   ============================================================ */
async function main() {
  setBoot(12, '正在拉取 672 条法则');
  const res = await fetch('/cards.json');
  if (!res.ok) throw new Error(`语料拉取失败：HTTP ${res.status}`);
  corpus = (await res.json()) as Corpus;

  setBoot(52, '正在解析语料');
  await new Promise((r) => setTimeout(r, 0));

  // 字体就绪后再画贴图，否则 Canvas 上量出来的字宽是错的，排版会歪
  if (document.fonts?.ready) await document.fonts.ready;

  setBoot(72, '正在生成 672 张卡面');
  scene = new WellScene(canvas, {
    onCardHover: handleCardHover,
  });
  scene.start();

  setBoot(88, '正在展开井');
  engine = new Engine(corpus, {
    onHand: (cards) => {
      scene.setHand(cards);
      // 换了一手牌，预览里那张可能已经不在手上了
      closePreview();
    },
    onRisk: (risk, fallMs, token) => {
      riskGroup.textContent = risk.group;
      riskGroup.style.color = GROUPS[risk.group].css;
      riskGroup.style.borderColor = GROUPS[risk.group].css;
      riskTitle.textContent = risk.title;
      riskHint.textContent = `出一张「${risk.group}」的卡，只有一次机会`;
      riskEl.classList.add('is-on');
      // 不再按风险所属的域去压暗其他两张牌：那是「哪个是正确选项」的提前泄题，
      // 三张牌要保持一样的呈现，让玩家自己读域来判断。
      scene.spawnRisk(risk, fallMs, () => engine.riskLanded(token));
    },
    onResolved: (risk, by) => {
      riskEl.classList.remove('is-on');
      if (by === 'card') scene.clearRisk(risk);
      else scene.settleFalling(risk);
    },
    /*
     * 一锤定音选错了：这一手直接结束。
     * 这里只负责「说清为什么错」和「让方块动起来」；
     * 堆层、判负、进下一手全在方块落地后的 riskLanded 那条路上。
     */
    onMiss: (m) => {
      scene.rejectCard(m.index);
      toast(
        m.reason === 'group'
          ? `对不上，这一手没了。风险是「${m.risk.group}」，你出的是「${m.card.group}」`
          : '付不起，这一手没了。这张的成本超过了手上的资源'
      );
      scene.slamRisk();
    },
    onScore: showScore,
    onResources: renderResources,
    onStats: (s) => {
      hudAge.textContent = String(s.age);
      hudTurn.textContent = String(Math.min(s.turn, TOTAL_TURNS));
      hudCleared.textContent = String(s.cleared);
      hudLayers.textContent = String(s.landed);
      scene.setDanger(s.landed / MAX_LAYERS);
    },
    onGameOver: (summary) => {
      lastSummary = summary;
      riskEl.classList.remove('is-on');
      closePreview();
      showSettlement(summary);
    },
  });

  // HUD 里的分母和初始值都从常量来，别在 HTML 里写死，否则改了参数就对不上
  const turnMax = document.getElementById('hud-turn-max');
  if (turnMax) turnMax.textContent = `/${TOTAL_TURNS}`;
  const layerMax = document.getElementById('hud-layer-max');
  if (layerMax) layerMax.textContent = `/${MAX_LAYERS}`;
  const helpPerfect = document.getElementById('help-perfect');
  if (helpPerfect) helpPerfect.textContent = String(PERFECT_AGE);
  hudAge.textContent = String(engine.state.age);
  hudTurn.textContent = String(engine.state.turn);

  bindEvents();
  helpEl.hidden = false;

  // 自动化验证用的钩子
  (window as unknown as Record<string, unknown>).__game = {
    scene,
    engine,
    positions: () => scene.cardScreenPositions(),
    playable: () => {
      const idx = engine.playableIndexes();
      const pos = scene.cardScreenPositions();
      return idx.length ? { index: idx[0], pos: pos[idx[0]] } : { index: -1, pos: null };
    },
    state: () => engine.state,
    bootDone: () => !document.getElementById('boot'),
    picks: () => ({ count: pickCount, log: [...pickLog] }),
    perfectAge: PERFECT_AGE,
    /** 验证计分公式用：绕过点击直接出牌，进度可控 */
    play: (index: number, progress = 0) => engine.playCard(index, progress),
  };

  setBoot(96, '就绪');
  await hideBoot();
}

/* ============================================================
   交互
   ============================================================ */
function handleCardPick(index: number, from = 'unknown') {
  pickCount += 1;
  pickLog.push(`${from}#${index}`);
  if (pickLog.length > 20) pickLog.shift();
  const st = engine.state;
  if (st.over || !st.risk) return;
  if (!st.hand[index]) return;

  /*
   * 一锤定音：前端不再预判对错，直接交给引擎。
   * 前端预判会泄题（它得先知道哪张对），也会变成两套判断标准。
   * 出手瞬间的方块进度一起带上，引擎用它算「从容」加成。
   */
  scene.playCard(index);
  engine.playCard(index, scene.fallProgress());
}

/* ============================================================
   预览：一层 HUD，不是面板
   ------------------------------------------------------------
   之前是把三张牌的全部内容一次列出来，问题是内容太多，
   三张同时看根本看不清。改成一次只看一张，左右滑动切换。
   面板压得极透、只做轻模糊，所以看字的同时还能看见
   手牌和正在下落的方块，是「透过 HUD 看现实」而不是「弹窗挡住游戏」。
   ============================================================ */
let pvIndex = 0;
let pvOpen = false;
/** 滑动或按键切换过之后固定住，不再跟随鼠标悬停 */
let pvPinned = false;
/** 指针当前是否停在预览面板上 */
let pvHovering = false;
let pvCloseTimer = 0;

function openPreview(index: number, pin = false) {
  const hand = engine.state.hand;
  if (!hand.length) return;
  pvIndex = ((index % hand.length) + hand.length) % hand.length;
  if (pin) pvPinned = true;
  const wasOpen = pvOpen;
  pvOpen = true;
  previewEl.hidden = false;
  if (!wasOpen) {
    // 淡入：先摘掉 is-shown 再加回来，才有过渡。已经开着就别重放，否则会闪。
    previewEl.classList.remove('is-shown');
    requestAnimationFrame(() => previewEl.classList.add('is-shown'));
  } else {
    previewEl.classList.add('is-shown');
  }
  /*
   * 进预览时相机退远，整口井进画面，方便一边读字一边盯方块下落。
   * 但只在「固定」的时候退。
   * 悬停是一眼就走的临时预览，相机一退手牌会被推出屏幕
   * （实测 y 从 794 掉到 1045，而视口只有 900），
   * 结果鼠标底下那张牌消失了，你反而没法直接点它出牌。
   */
  if (pin) scene.setFraming('preview');
  renderPreview();
}

function closePreview() {
  if (!pvOpen) return;
  pvOpen = false;
  pvPinned = false;
  previewEl.classList.remove('is-shown');
  previewEl.hidden = true;
  scene.setFraming('play');
}

function stepPreview(delta: number) {
  if (!pvOpen) return;
  const n = engine.state.hand.length;
  if (n < 2) return;
  /*
   * 内容从侧面滑进来，像相册翻页。
   * 用百分比（相对自身宽度）而不是固定像素，宽窄屏的观感才一致；
   * 正数 = 下一张，从右边进来；负数 = 上一张，从左边进来。
   * openPreview 里对下标取了模，所以第一张往前翻会绕到最后一张。
   */
  pvBody.style.setProperty('--pv-dx', delta > 0 ? '52%' : '-52%');
  openPreview(pvIndex + delta, true);
  pvBody.classList.remove('is-swap');
  void pvBody.offsetWidth;
  pvBody.classList.add('is-swap');
}

function renderPreview() {
  const hand = engine.state.hand;
  const card = hand[pvIndex];
  if (!card) {
    closePreview();
    return;
  }
  const grade = gradeOf(card.grade);
  const cost = costOf(card);

  pvGroup.textContent = card.group;
  pvGroup.style.color = GROUPS[card.group].css;
  pvGroup.style.borderColor = GROUPS[card.group].css;
  pvId.textContent = `${card.chapter} 章 · ${card.num} 条`;
  pvPos.textContent = `${pvIndex + 1}/${hand.length}`;
  pvTitle.textContent = card.title;
  pvPlain.textContent = card.plain || card.costText || '';
  pvMeta.textContent =
    `成本 钱${cost.money} 时间${cost.time} 毅力${cost.will}` +
    `　收益 ${card.tags.gain}（${card.tags.lens}）　证据 ${grade}`;

  const src = card.sources[0];
  pvSrc.textContent = src ? `来源：${src.text}` : '';

  // 页码点。张数变了才重建，否则每次翻页都重建一遍 DOM 会闪一下。
  if (pvDots.childElementCount !== hand.length) {
    pvDots.replaceChildren(
      ...hand.map(() => {
        const dot = document.createElement('i');
        dot.className = 'pv-dot';
        return dot;
      })
    );
  }
  Array.from(pvDots.children).forEach((dot, i) => {
    dot.classList.toggle('is-on', i === pvIndex);
  });

  /*
   * 一键出牌。三张牌的按钮必须长得一模一样。
   * 之前这里会按「对不上，要『X』」/「资源不够」给出不同文案，
   * 等于替玩家把答案挑出来了：翻一眼就知道该出哪张，游戏就没得玩。
   * 现在只区分「还有风险要处理」和「这一手已经过了」，
   * 判断交给玩家；选错了由引擎给提示（toast），那是反馈，不是提前泄题。
   */
  const risk = engine.state.risk;
  pvPlay.disabled = !risk;
  pvPlay.textContent = risk ? '出这张牌' : '这一手已经过了';
}

/**
 * 悬停：电脑上鼠标停在卡片上就出预览。
 * 关闭要延迟一下：从卡片移到预览面板上的按钮，中途必然经过画布，
 * 那一刻鼠标底下没有卡片，如果立刻关，按钮就永远点不到了。
 */
function handleCardHover(index: number | null) {
  if (index === null) {
    if (pvPinned || pvHovering) return;
    window.clearTimeout(pvCloseTimer);
    pvCloseTimer = window.setTimeout(() => {
      if (!pvHovering && !pvPinned) closePreview();
    }, 260);
    return;
  }
  window.clearTimeout(pvCloseTimer);
  if (!pvPinned) openPreview(index, false);
}
/* ============================================================
   交互绑定
   ============================================================ */
function bindEvents() {
  passBtn.addEventListener('click', () => engine.passRisk());

  /* ---------- 画布上：点按出牌，长按看详情 ---------- */
  const LONG_PRESS_MS = 420;
  let pressTimer = 0;
  let downX = 0;
  let downY = 0;
  let downTime = 0;
  let downMoved = false;
  let longPressed = false;

  const buzz = () =>
    (navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(12);

  canvas.addEventListener('pointerdown', (e) => {
    /*
     * 每次按下都先清掉上一次长按留下的抑制标记，而且必须清在
     * `idx === null` 的提前 return 之前。
     * 原来这行写在 return 后面，于是「长按看过详情 → 点空白处」这第一下
     * 会被当成上一次长按的尾音吞掉，表现就是预览关不掉。
     */
    longPressed = false;
    window.clearTimeout(pressTimer);
    pressTimer = 0;

    const idx = scene.pickCardAt(e.clientX, e.clientY);
    if (idx === null) return;
    downX = e.clientX;
    downY = e.clientY;
    downTime = performance.now();
    downMoved = false;
    // 手机上只有长按能看到详情，因为触摸设备根本没有 hover：
    // 点一下就直接进 pointerdown 出牌了，中间没有「停一下看看」的机会。
    pressTimer = window.setTimeout(() => {
      longPressed = true;
      openPreview(idx, true);
      buzz();
    }, LONG_PRESS_MS);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pressTimer) return;
    // 手指滑动超过 10px 就不算长按了
    if (Math.abs(e.clientX - downX) > 10 || Math.abs(e.clientY - downY) > 10) {
      downMoved = true;
      window.clearTimeout(pressTimer);
      pressTimer = 0;
    }
  });

  const endPress = (e: PointerEvent) => {
    const held = performance.now() - downTime;
    window.clearTimeout(pressTimer);
    pressTimer = 0;
    /*
     * 定时器不能作为唯一判据。
     * 低端机（以及无头环境下的软件渲染）主线程很忙时，420ms 的定时器
     * 会被拖到松手之后才轮到执行，而松手这里又把定时器清掉了，
     * 结果长按整个失效、直接变成出牌。
     * 所以松手时按「实际按住了多久」再兜一次。
     */
    if (!downMoved && !longPressed && held >= LONG_PRESS_MS) {
      const idx = scene.pickCardAt(e.clientX, e.clientY);
      if (idx !== null) {
        longPressed = true;
        openPreview(idx, true);
        buzz();
      }
    }
  };
  canvas.addEventListener('pointerup', endPress);
  canvas.addEventListener('pointercancel', endPress);

  canvas.addEventListener('click', (e) => {
    // 长按那一次不能当成点击，否则一松手就把牌打出去了
    if (longPressed) {
      longPressed = false;
      return;
    }
    const idx = scene.pickCardAt(e.clientX, e.clientY);
    if (idx !== null) {
      handleCardPick(idx, 'canvas-click');
      return;
    }
    // 点空白处收掉预览
    if (pvOpen) closePreview();
  });

  /* ---------- 预览：按钮、左右滑动、键盘 ---------- */
  $('pv-prev').addEventListener('click', () => stepPreview(-1));
  $('pv-next').addEventListener('click', () => stepPreview(1));
  $('pv-close').addEventListener('click', closePreview);
  pvPlay.addEventListener('click', () => {
    if (!pvOpen) return;
    handleCardPick(pvIndex, 'preview-play');
  });

  let swX = 0;
  let swY = 0;
  let swiping = false;
  let swId = -1;
  previewEl.addEventListener('pointerenter', () => {
    pvHovering = true;
    window.clearTimeout(pvCloseTimer);
  });
  previewEl.addEventListener('pointerleave', () => {
    pvHovering = false;
    if (pvPinned) return;
    // 同样延迟：从面板移回卡片时，先关再开会闪一下
    window.clearTimeout(pvCloseTimer);
    pvCloseTimer = window.setTimeout(() => {
      if (!pvHovering && !pvPinned) closePreview();
    }, 260);
  });
  previewEl.addEventListener('pointerdown', (e) => {
    swiping = true;
    swId = e.pointerId;
    swX = e.clientX;
    swY = e.clientY;
  });
  /*
   * 滑动的收尾挂在 window 上，不挂在面板上。
   * 横滑时手指很容易滑出面板边界，挂在面板上的话那一刻之后就收不到
   * pointerup 了，整段滑动等于白滑。这是手机上「滑不动」的第二个来源。
   */
  window.addEventListener('pointerup', (e) => {
    if (!swiping || e.pointerId !== swId) return;
    swiping = false;
    swId = -1;
    const dx = e.clientX - swX;
    const dy = e.clientY - swY;
    // 横向位移要明显大于纵向，否则会跟面板内的纵向滚动打架
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      stepPreview(dx < 0 ? 1 : -1);
      return;
    }
    /*
     * 没怎么动 = 点了一下。面板是半透明的，用户眼里它盖住的那块也是「空白」，
     * 所以点在非控件的地方要退出预览，否则点空白没反应。
     * 落在按钮上的交给按钮自己处理（✕ 关闭、‹ › 翻页、出这张牌）。
     */
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      if (!(e.target as HTMLElement).closest('button')) closePreview();
    }
  });
  window.addEventListener('pointercancel', (e) => {
    if (e.pointerId === swId) {
      swiping = false;
      swId = -1;
    }
  });

  /*
   * 点空白退出预览：统一在 document 上收口。
   * 面板是半透明的，用户眼里「它盖住的地方」和「它没盖住的背景」都是空白，
   * 但顶栏、资源栏、风险提示条这些都压在画布上面，会把点击吃掉、
   * 传不到 canvas 的 click 上，于是预览关不掉（用户报的「有的时候不会消失」）。
   * 只要不是点在预览面板里、也不是点在按钮之类的控件上，就退出。
   * 面板内部不在这里关，因为它要区分「点一下」和「左右滑动翻页」。
   */
  document.addEventListener('pointerdown', (e) => {
    if (!pvOpen) return;
    const t = e.target as HTMLElement;
    if (t.closest('#preview')) return;
    if (t.closest('button, a, [role="button"]')) return;
    closePreview();
  });

  $('help-btn').addEventListener('click', () => {
    helpEl.hidden = false;
  });
  $('help-close').addEventListener('click', () => {
    helpEl.hidden = true;
    if (engine.state.over) return;
    if (engine.state.turn === 1 && !engine.state.risk) engine.start();
  });

  $('again-btn').addEventListener('click', () => {
    settleEl.hidden = true;
    closePreview();
    scene.reset();
    engine.start();
  });

  $('share-btn').addEventListener('click', () => {
    if (!lastSummary) return;
    const cv = buildShareCanvas(lastSummary);
    const a = document.createElement('a');
    a.download = `井-净值${lastSummary.age}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    toast('已存下这张图');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (pvOpen) closePreview();
      else helpEl.hidden = true;
      return;
    }
    if (!helpEl.hidden || !settleEl.hidden) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepPreview(-1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepPreview(1);
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      engine.passRisk();
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 3) handleCardPick(n - 1, 'key');
  });
}

function renderResources(res: Resources) {
  const set = (bar: HTMLElement, value: HTMLElement, v: number, cap: number) => {
    bar.style.inlineSize = `${Math.round((v / cap) * 100)}%`;
    value.textContent = String(v);
  };
  set(resMoney, resMoneyV, res.money, RES_CAP.money);
  set(resTime, resTimeV, res.time, RES_CAP.time);
  set(resWill, resWillV, res.will, RES_CAP.will);
}

function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add('is-on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('is-on'), 2600);
}

/* ============================================================
   加分：HUD 上浮一个 +N，顺便把这一手的构成摊开
   ------------------------------------------------------------
   玩家不用自己算，但要看得见数字是怎么来的，
   否则「+42」和「+8」在他眼里没区别，连击和从容就白设计了。
   ============================================================ */
function showScore(s: ScoreBreakdown) {
  const pop = document.getElementById('score-pop');
  if (!pop) return;

  const parts = [`活过 +${s.alive}`];
  if (s.clear) parts.push(`打掉 +${s.clear}`);
  if (s.grade) parts.push(`证据 +${s.grade}`);
  if (s.calm) parts.push(`从容 +${s.calm}`);
  if (s.combo) parts.push(`连击×${s.comboCount} +${s.combo}`);

  const big = document.createElement('b');
  big.textContent = `+${s.total}`;
  const small = document.createElement('span');
  small.textContent = parts.join(' · ');
  pop.replaceChildren(big, small);

  // 重放动画：先摘掉再加回来，否则连续两次同分不会重新播
  pop.classList.remove('is-on');
  void pop.offsetWidth;
  pop.classList.add('is-on');
  window.clearTimeout(scorePopTimer);
  scorePopTimer = window.setTimeout(() => pop.classList.remove('is-on'), 1700);
}

/* ============================================================
   结算
   ============================================================ */
function buildShareCanvas(summary: Summary): HTMLCanvasElement {
  return makeShareCard({
    age: summary.age,
    cause: summary.cause,
    scene: summary.scene,
    survived: summary.landed.length,
    layers: summary.landed.map((r) => ({
      group: r.group,
      title: r.title,
      color: GROUPS[r.group].css,
    })),
    saves: summary.saves,
    cleared: summary.cleared,
  });
}

function showSettlement(summary: Summary) {
  $('settle-kicker').textContent = summary.won ? '通关' : '结算';
  $('settle-age').textContent = String(summary.age);
  const cause = $('settle-cause');
  cause.textContent = summary.cause;
  cause.style.color = summary.won ? '#6e8a6a' : '#c2413f';
  $('settle-scene').textContent = summary.scene;
  $('settle-stat').textContent =
    `躲过 ${summary.cleared} 次 · 漏掉 ${summary.landed.length} 次 · ` +
    `走了 ${summary.turns}/${TOTAL_TURNS} 手 · 最长连击 ${summary.bestCombo}`;
  // 满分参照：让 1008 有个具体的样子，不然 812 只是个数字
  $('settle-perfect').textContent = `满分净值 ${PERFECT_AGE}`;

  const ul = $('settle-saves');
  ul.innerHTML = '';
  if (!summary.saves.length) {
    const li = document.createElement('li');
    li.className = 'is-empty';
    li.textContent = '一条都没漏。';
    ul.appendChild(li);
  }
  for (const save of summary.saves) {
    const li = document.createElement('li');
    const id = document.createElement('span');
    id.className = 'sid';
    id.textContent = save.id;
    const title = document.createElement('span');
    title.textContent = save.title;
    const grade = document.createElement('span');
    grade.className = 'sgrade';
    grade.textContent = save.grade;
    grade.style.color = GRADE_META[save.grade]?.css ?? '#999';
    li.append(id, title, grade);
    ul.appendChild(li);
  }

  settleEl.hidden = false;
}

main().catch((err) => {
  console.error('[启动失败]', err);
  failBoot(err);
});
