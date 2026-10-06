import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, HIT, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';

/**
 * 「本次跑哪个」三档：System One / System Two / 两个都要。
 *
 * 为什么必须能在上传页直接选：System One 与 System Two 是**并列的两个引擎**，
 * System Two 自带完整三段式报告与自己的排序，不依赖快速分；把 CTA 写死成"先 System One"
 * 等于把深度分析降级成"快速分的附属功能"。所以选择要在**发起之前**发生。
 *
 * 视觉与设置页「引擎模式」三档**同一套语言**（同一组令牌，逐字对应 SettingsScreen 的
 * `modeCard` / `modeCardOn` / `modeCardTitle` / `modeCardSub`）：未选中 `surface` 底 + `border`
 * 描边 + `text`/`textDim` 文字；选中 `text` 墨色实心 + `surface` 标题（16.2:1）+ `surfaceAlt`
 * 副文案（13.5:1）。这里只换文案，不新造选中样式——一屏两处选择器不能有两套观感。
 */
export const SYSTEM_MODES = [
  { id: 'quick', testID: 'system-mode-quick', title: '快速评分', sub: '本地模型秒出 6 维分数' },
  { id: 'deep', testID: 'system-mode-deep', title: '深度分析', sub: '多模态三段式报告，更慢更细' },
  { id: 'both', testID: 'system-mode-both', title: '两个都要', sub: '先出分数，再自动跑报告' },
];

export default function SystemModeSelector({ value, onChange }) {
  return (
    <View testID="system-mode" accessibilityRole="radiogroup" aria-label="本次跑哪个" style={styles.list}>
      {SYSTEM_MODES.map((mode) => {
        const active = value === mode.id;
        return (
          <Pressable
            key={mode.id}
            testID={mode.testID}
            accessibilityRole="radio"
            // 原生读 selected；web 侧 role=radio 的规范属性是 aria-checked，
            // aria-selected 一并输出，兼容既有冒烟断言与 SPEC 的措辞。
            accessibilityState={{ selected: active, checked: active }}
            aria-checked={active}
            aria-selected={active}
            onPress={() => {
              if (typeof onChange === 'function') onChange(mode.id);
            }}
            style={({ pressed }) => [styles.card, active && styles.cardOn, pressed && styles.pressed]}
          >
            <Text style={[styles.title, active && styles.titleOn]}>{mode.title}</Text>
            <Text style={[styles.sub, active && styles.subOn]}>{mode.sub}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // 与设置页「引擎模式」三档逐项对应（同样的间距 / 圆角 / 描边 / 双行文案）
  list: { gap: space.sm },
  card: {
    minHeight: HIT,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  cardOn: { borderColor: colors.text, backgroundColor: colors.text },
  title: { fontFamily: SANS, fontSize: font.body, fontWeight: '600', color: colors.text },
  titleOn: { color: colors.surface },
  sub: { fontFamily: SANS, fontSize: font.small, lineHeight: 19, color: colors.textDim, marginTop: 3 },
  subOn: { color: colors.surfaceAlt },
  pressed: { opacity: 0.75 },
});
