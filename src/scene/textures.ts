import * as THREE from 'three';
import type { CardRecord } from '../types.js';
import { GROUPS, GRADE_META, COST_LABEL, gradeOf } from '../data/groups.js';
import type { Risk } from '../data/risks.js';

/**
 * 所有贴图都是 Canvas 真绘制的，没有一张图片资源。
 * 好处：卡面内容随时能跟着数据变，672 条不需要 672 张图。
 */

export const SANS =
  '"PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';
export const MONO =
  '"IBM Plex Mono",ui-monospace,"JetBrains Mono","Cascadia Mono",Consolas,monospace';

const PAPER = '#e9e4d7';
const INK = '#1a1a18';
const INK_SOFT = 'rgba(26,26,24,0.62)';
const INK_FAINT = 'rgba(26,26,24,0.22)';

function make2d(w: number, h: number) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('拿不到 2d context');
  return { cv, ctx };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 中文按字断行，拉丁按词断行 */
function wrapCJK(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const lines: string[] = [];
  let line = '';
  let word = '';

  const pushLine = () => {
    lines.push(line);
    line = '';
  };

  for (const ch of text) {
    const isWordChar = /[A-Za-z0-9._%·-]/.test(ch);
    if (isWordChar) {
      word += ch;
      continue;
    }
    if (word) {
      if (ctx.measureText(line + word).width > maxWidth && line) pushLine();
      line += word;
      word = '';
    }
    if (ctx.measureText(line + ch).width > maxWidth && line) pushLine();
    line += ch;
    if (lines.length >= maxLines) break;
  }
  if (word) {
    if (ctx.measureText(line + word).width > maxWidth && line) pushLine();
    line += word;
  }
  if (line && lines.length < maxLines) lines.push(line);

  if (lines.length >= maxLines) {
    const last = lines[maxLines - 1];
    let t = last;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    lines[maxLines - 1] = t + '…';
    return lines.slice(0, maxLines);
  }
  return lines;
}

/** 三格成本条，实心格数 = 成本档位（0/1/2） */
function drawCostBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  filled: number,
  width: number
) {
  const seg = (width - 8) / 3;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i < filled ? INK : INK_FAINT;
    roundRect(ctx, x + i * (seg + 4), y, seg, 6, 3);
    ctx.fill();
  }
}

const COST_TIER: Record<'money' | 'time' | 'will', Record<string, number>> = {
  money: { 0: 0, 少: 1, 多: 2 },
  time: { 少: 0, 中: 1, 多: 2 },
  will: { 否: 0, 些: 1, 是: 2 },
};

export function makeCardFace(card: CardRecord): THREE.CanvasTexture {
  const W = 520;
  const H = 760;
  const { cv, ctx } = make2d(W, H);
  const meta = GROUPS[card.group];
  const grade = gradeOf(card.grade);
  const gm = GRADE_META[grade];

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  // 纸纹：极淡的斜线，密度很低，只为破掉纯色的平板感
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  for (let i = -H; i < W; i += 7) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + H, H);
    ctx.stroke();
  }
  ctx.restore();

  // 顶部分组色带
  ctx.fillStyle = meta.css;
  ctx.fillRect(0, 0, W, 76);
  ctx.fillStyle = '#fff';
  ctx.font = `600 30px ${SANS}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(card.group, 30, 40);
  ctx.font = `400 17px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillText(`${card.chapter} 章 · ${card.num} 条`, W - 30, 41);
  ctx.textAlign = 'left';

  // 标题
  ctx.fillStyle = INK;
  ctx.font = `600 38px ${SANS}`;
  const titleLines = wrapCJK(ctx, card.title, W - 60, 3);
  let ty = 138;
  for (const line of titleLines) {
    ctx.fillText(line, 30, ty);
    ty += 52;
  }

  // 分隔线
  ty += 12;
  ctx.strokeStyle = INK_FAINT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(30, ty);
  ctx.lineTo(W - 30, ty);
  ctx.stroke();
  ty += 44;

  // 三项成本
  const rows: Array<[string, 'money' | 'time' | 'will', string]> = [
    ['钱', 'money', card.tags.money],
    ['时间', 'time', card.tags.time],
    ['毅力', 'will', card.tags.will],
  ];
  ctx.textBaseline = 'middle';
  for (const [label, key, value] of rows) {
    ctx.fillStyle = INK_SOFT;
    ctx.font = `400 21px ${SANS}`;
    ctx.fillText(label, 30, ty);
    drawCostBar(ctx, 106, ty - 3, COST_TIER[key][value] ?? 0, 96);
    ctx.fillStyle = INK;
    ctx.font = `400 21px ${SANS}`;
    ctx.fillText(COST_LABEL[key][value] ?? '—', 224, ty);
    ty += 44;
  }

  ty += 8;
  ctx.strokeStyle = INK_FAINT;
  ctx.beginPath();
  ctx.moveTo(30, ty);
  ctx.lineTo(W - 30, ty);
  ctx.stroke();
  ty += 46;

  // 收益
  ctx.fillStyle = INK_SOFT;
  ctx.font = `400 21px ${SANS}`;
  ctx.fillText('收益', 30, ty);
  ctx.fillStyle = INK;
  ctx.font = `600 26px ${SANS}`;
  ctx.fillText(card.tags.gain || '—', 106, ty);
  ctx.font = `400 20px ${SANS}`;
  ctx.fillStyle = INK_SOFT;
  ctx.fillText(`口径 ${card.tags.lens || '—'}`, 176, ty);

  // 证据等级徽章：金属色圆环，等级不靠颜色靠材质
  const bx = W - 76;
  const by = H - 76;
  ctx.beginPath();
  ctx.arc(bx, by, 34, 0, Math.PI * 2);
  ctx.fillStyle = gm.css;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(bx, by, 27, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `600 34px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText(grade, bx, by + 1);
  ctx.textAlign = 'left';

  ctx.fillStyle = INK_SOFT;
  ctx.font = `400 17px ${SANS}`;
  ctx.fillText(gm.label, 30, H - 74);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function makeCardBack(): THREE.CanvasTexture {
  const W = 520;
  const H = 760;
  const { cv, ctx } = make2d(W, H);

  ctx.fillStyle = '#1c1e22';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(201,162,39,0.42)';
  ctx.lineWidth = 2;
  roundRect(ctx, 18, 18, W - 36, H - 36, 14);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1;
  for (let i = -H; i < W; i += 14) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + H, H);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(233,228,215,0.5)';
  ctx.font = `400 22px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText('HOW TO LIVE BETTER', W / 2, H / 2 - 10);
  ctx.fillStyle = 'rgba(233,228,215,0.28)';
  ctx.font = `400 18px ${MONO}`;
  ctx.fillText('672 RULES', W / 2, H / 2 + 24);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 风险块顶面的贴图 */
export function makeRiskFace(risk: Risk): THREE.CanvasTexture {
  const S = 512;
  const { cv, ctx } = make2d(S, S);
  const meta = GROUPS[risk.group];

  ctx.fillStyle = '#191b1f';
  ctx.fillRect(0, 0, S, S);

  // 斜向危险条纹，压得很低，只在边缘显形
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = meta.css;
  ctx.lineWidth = 22;
  for (let i = -S; i < S * 2; i += 74) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + S, S);
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = 'rgba(12,13,15,0.72)';
  ctx.fillRect(48, 48, S - 96, S - 96);

  ctx.strokeStyle = meta.css;
  ctx.lineWidth = 3;
  ctx.strokeRect(48, 48, S - 96, S - 96);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = meta.css;
  ctx.font = `600 34px ${SANS}`;
  ctx.fillText(risk.group, S / 2, 128);

  ctx.fillStyle = '#f2efe6';
  ctx.font = `600 88px ${SANS}`;
  ctx.fillText(risk.title, S / 2, S / 2 + 12);

  ctx.fillStyle = 'rgba(242,239,230,0.4)';
  ctx.font = `400 24px ${MONO}`;
  ctx.fillText('RISK', S / 2, S - 122);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * 已经堆在井里的那一层，侧面贴图。
 * 长宽比跟着方块走（约 5.3 : 1），文字要够大，透过玻璃也要读得出来。
 */
export function makeLayerTexture(risk: Risk): THREE.CanvasTexture {
  const W = 512;
  const H = 96;
  const { cv, ctx } = make2d(W, H);
  const meta = GROUPS[risk.group];

  ctx.fillStyle = meta.css;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, H - 12, W, 12);

  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = `600 46px ${SANS}`;
  ctx.fillText(risk.title, 26, H / 2 - 2);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText(risk.group, W - 26, H / 2 - 2);
  ctx.textAlign = 'left';

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 一粒柔和的尘埃，用于背景浮尘 */
export function makeMoteTexture(): THREE.CanvasTexture {
  const S = 64;
  const { cv, ctx } = make2d(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 台面：同心圆刻度 + 外圈刻度线，像一件精密仪器 */
export function makeBenchTexture(): THREE.CanvasTexture {
  const S = 1024;
  const { cv, ctx } = make2d(S, S);
  const c = S / 2;

  ctx.fillStyle = '#15171a';
  ctx.fillRect(0, 0, S, S);

  const g = ctx.createRadialGradient(c, c, S * 0.05, c, c, S * 0.5);
  g.addColorStop(0, '#1d2025');
  g.addColorStop(0.62, '#15171a');
  g.addColorStop(1, '#0e1013');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1.5;
  for (let r = 40; r < S * 0.5; r += 34) {
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  for (let i = 0; i < 360; i += 5) {
    const a = (i * Math.PI) / 180;
    const long = i % 30 === 0;
    const r0 = S * 0.5 - (long ? 30 : 16);
    const r1 = S * 0.5 - 6;
    ctx.strokeStyle = long ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.11)';
    ctx.lineWidth = long ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * 结算分享图。这是传播物，所以信息密度要高、字号要大、要能一眼看懂。
 * 不套卡片阴影、不用装饰性小字，数字用等宽。
 */
export function makeShareCard(data: {
  age: number;
  cause: string;
  scene: string;
  survived: number;
  layers: Array<{ group: string; title: string; color: string }>;
  saves: Array<{ id: string; title: string; grade: string }>;
  cleared: number;
}): HTMLCanvasElement {
  const W = 900;
  const H = 1240;
  const { cv, ctx } = make2d(W, H);

  ctx.fillStyle = '#0b0c0e';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#e9e4d7';
  ctx.font = `600 34px ${MONO}`;
  ctx.fillText('我的井', 64, 92);

  ctx.fillStyle = 'rgba(233,228,215,0.45)';
  ctx.font = `400 20px ${SANS}`;
  ctx.fillText('高性价比人生指南 · 672 条', 64, 128);

  // 最终净值，最大的一行
  ctx.fillStyle = '#e9e4d7';
  ctx.font = `600 132px ${MONO}`;
  ctx.fillText(String(data.age), 64, 268);
  const ageW = ctx.measureText(String(data.age)).width;
  ctx.font = `400 30px ${SANS}`;
  ctx.fillStyle = 'rgba(233,228,215,0.55)';
  ctx.fillText('净值', 64 + ageW + 18, 268);

  ctx.fillStyle = '#c2413f';
  ctx.font = `600 62px ${SANS}`;
  ctx.fillText(data.cause, 64, 352);

  ctx.fillStyle = 'rgba(233,228,215,0.68)';
  ctx.font = `400 24px ${SANS}`;
  for (const [i, line] of wrapCJK(ctx, data.scene, W - 128, 3).entries()) {
    ctx.fillText(line, 64, 402 + i * 38);
  }

  // 井的剖面：堆了几层，一目了然
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 2;
  ctx.strokeRect(64, 500, W - 128, 300);

  const layerH = Math.min(26, 288 / Math.max(data.layers.length, 1));
  let ly = 500 + 300 - 6;
  for (const layer of data.layers.slice(-9)) {
    ly -= layerH + 2;
    ctx.fillStyle = layer.color;
    ctx.fillRect(70, ly, W - 140, layerH);
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.font = `400 ${Math.min(15, layerH - 6)}px ${SANS}`;
    ctx.fillText(layer.title, 84, ly + layerH / 2 + 5);
  }
  if (!data.layers.length) {
    ctx.fillStyle = 'rgba(233,228,215,0.4)';
    ctx.font = `400 22px ${SANS}`;
    ctx.fillText('一层都没堆起来', 84, 660);
  }

  ctx.fillStyle = 'rgba(233,228,215,0.5)';
  ctx.font = `400 20px ${SANS}`;
  ctx.fillText(`躲掉 ${data.cleared} 次 · 漏掉 ${data.layers.length} 次 · 净值 ${data.age}`, 64, 846);

  // 能救你的那几条
  ctx.fillStyle = '#e9e4d7';
  ctx.font = `600 26px ${SANS}`;
  ctx.fillText('本来能救你的几条', 64, 912);

  let sy = 962;
  for (const save of data.saves.slice(0, 3)) {
    ctx.fillStyle = 'rgba(233,228,215,0.5)';
    ctx.font = `400 19px ${MONO}`;
    ctx.fillText(save.id, 64, sy);
    ctx.fillStyle = '#e9e4d7';
    ctx.font = `400 23px ${SANS}`;
    const title = wrapCJK(ctx, save.title, W - 300, 1)[0];
    ctx.fillText(title, 140, sy);
    ctx.fillStyle = GRADE_META[save.grade]?.css ?? '#999';
    ctx.font = `600 19px ${MONO}`;
    ctx.fillText(save.grade, W - 92, sy);
    sy += 44;
  }

  ctx.fillStyle = 'rgba(233,228,215,0.3)';
  ctx.font = `400 18px ${SANS}`;
  ctx.fillText('内容来自 github.com/eternity4719/HowToLiveBetter · CC BY 4.0', 64, H - 60);

  return cv;
}
