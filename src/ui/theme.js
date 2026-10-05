// SPEC §3.14 · 视觉令牌唯一出口。docs/DESIGN.md 与本文件逐字对应。
//
// 本文件**零 import**：Metro 能打包，node 脚本也能直接读取做令牌对齐校验。
// 平台相关的字族放在 src/ui/platform.js，避免把 react-native 带进纯令牌层。
//
// 对比度（WCAG 2.1，实测值见 docs/DESIGN.md）：
//   primary #A15C0A + #FFFFFF 字 = 5.18:1  → 底部主 CTA 过 AA（小字 4.5:1）
//   accent  #96530A 在 surface = 5.80:1，在 bg = 5.28:1，在 primarySoft = 4.87:1
//   text    #231E17 在 bg      = 14.70:1
//   textDim #6B6154 在 bg      = 5.39:1，在 surface = 5.93:1
//   border  #D8CBB4 是分隔线（纯装饰，不承载信息），不适用文本对比度

export const colors = {
  bg: '#F6F1E8',
  surface: '#FFFCF7',
  surfaceAlt: '#EFE7DA',
  border: '#D8CBB4',
  primary: '#A15C0A',
  primarySoft: '#F6E7CF',
  accent: '#96530A',
  text: '#231E17',
  textDim: '#6B6154',
  success: '#4F6B3C',
  warn: '#8A5A12',
  danger: '#A63D22',
  starOn: '#A15C0A',
  starOff: '#C9BCA4',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };

export const font = { h1: 26, h2: 18, body: 15, small: 13, tiny: 11, score: 34 };

export const motion = { fast: 150, base: 250, slow: 400 };

/* ── 以下是 SPEC 之外、供实现复用的令牌（不改变上面五个对象的形状） ── */

/** 最小触达尺寸（SPEC 硬要求：44px） */
export const HIT = 44;

export const layout = {
  padX: space.lg,
  ctaHeight: 56,
  tabHeight: 48,
  thumbW: 54,
  thumbH: 68,
  /** CTA 坞 + SafeArea 之外，滚动内容必须多留的底部空间（防止被 CTA 压住） */
  dockGap: space.lg,
};

/** 纸感阴影：暖色低透明度，最大两级（设计说明里的“阴影最多两级”） */
export const shadow = {
  paper: {
    shadowColor: '#4B3A23',
    shadowOpacity: 0.07,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  lift: {
    shadowColor: '#4B3A23',
    shadowOpacity: 0.13,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
};

/** 8 位 hex 透明度后缀：描边 55%、极淡 30% */
export const alpha = { outline: '8C', faint: '4D' };

/** 「看不清」的中性占位：不写 0 分，也不写假数据 */
export const NO_SCORE = '—';

/** 六维的中文名（与 SPEC §3.1 的 SCORE_QUESTION_IDS 一一对应） */
export const DIM_LABELS = {
  overall_score: '综合',
  aesthetic_score: '美观',
  scene_score: '场合',
  figure_score: '身材',
  style_score: '风格',
  practical_score: '实用',
};

export default { colors, space, radius, font, motion, HIT, layout, shadow, alpha, DIM_LABELS, NO_SCORE };
