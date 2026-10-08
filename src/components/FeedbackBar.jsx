import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { alpha, colors, font, HIT, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';
import SectionLabel from './SectionLabel.jsx';

/**
 * 反馈条：结果页问"你最后穿了哪套"。
 *
 * 目的：积累真实选择，用来判断哪个打分档位更可靠（分数高的是不是真的被穿走了）。
 * 隐私约束：**只收集选择，不收集图片**，且只记在本机、不上传。
 *
 * 契约：
 *   props  { lookIds, onFeedback, current, style }
 *     - lookIds：要问的穿搭 id 数组（也容忍 [{lookId}] 形态）；
 *     - onFeedback({ lookId, verdict })：点击即回调，verdict ∈ 'wore' | 'not_wore' | 'skipped'；
 *     - current：回显已选项，用于高亮。形状未冻结，这里容忍三种：Map 形态 {lookId: verdict}、
 *               单条记录 {lookId, verdict}、数组 [{lookId, verdict}]。
 *   testID：feedback-{lookId}-wore / -not_wore / -skipped（逐字，下划线保留）。
 * 没有 lookIds 时整块不渲染（避免空卡）。
 */

/** 文案集中在文件顶部 */
const TITLE = '最后穿了哪套';
const META = '本地记录';
const PRIVACY =
  '只记你点的这一项，用来判断哪个分数档位更可靠。不保存照片、不上传，记录只留在这台设备。';

/** 三个回答；id 逐字用作 testID 后缀 */
const VERDICTS = [
  { id: 'wore', label: '穿了' },
  { id: 'not_wore', label: '没穿' },
  { id: 'skipped', label: '没参考' },
];

/** lookIds 允许是 id 字符串，也允许是 {lookId} 对象 */
function lookKeyOf(item, index) {
  if (item === null || item === undefined) return `look-${index}`;
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (item.lookId !== undefined && item.lookId !== null) return String(item.lookId);
  return `look-${index}`;
}

/** 从 current 里读出某个 lookId 已选的 verdict；形状不确定，所以三种形态都认 */
function selectedVerdict(current, lookId) {
  if (!current) return null;
  const key = String(lookId);
  if (Array.isArray(current)) {
    // 列表形态（src/core/feedback.js 的存储形状）：同一 lookId 可能被改答过多次，
    // 取**最后一条**（最新一次回答），而不是第一条。
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const item = current[i];
      if (item && String(item.lookId) === key && item.verdict) return String(item.verdict);
    }
    return null;
  }
  if (typeof current === 'object') {
    // 单条记录 {lookId, verdict}
    if (current.lookId !== undefined && current.verdict !== undefined) {
      return String(current.lookId) === key ? String(current.verdict) : null;
    }
    // Map 形态 {lookId: verdict} 或 {lookId: {verdict}}
    const value = current[lookId];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && value.verdict !== undefined) return String(value.verdict);
  }
  return null;
}

export default function FeedbackBar({ lookIds, onFeedback, current = null, style }) {
  const list = Array.isArray(lookIds) ? lookIds : [];
  if (!list.length) return null;

  return (
    <View testID="feedback-bar" style={[styles.wrap, style]}>
      <SectionLabel title={TITLE} meta={META} />
      <View style={styles.card}>
        <Text style={styles.privacy}>{PRIVACY}</Text>

        {list.map((item, index) => {
          const lookId = lookKeyOf(item, index);
          const picked = selectedVerdict(current, lookId);
          return (
            <View key={lookId} style={styles.row}>
              <Text style={styles.rowLabel}>{`第 ${index + 1} 套`}</Text>
              <View style={styles.btnRow}>
                {VERDICTS.map((verdict) => {
                  const selected = picked === verdict.id;
                  // RNW 在 role=button 上不映射 accessibilityState.selected（连 aria-selected 都不生成），
                  // 所以回显的选中态再显式给一个 aria-pressed：网页端与自动化验收才看得到"已选"。
                  return (
                    <Pressable
                      key={verdict.id}
                      testID={`feedback-${lookId}-${verdict.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={`第 ${index + 1} 套：${verdict.label}`}
                      accessibilityState={{ selected }}
                      aria-pressed={selected}
                      onPress={() => {
                        if (typeof onFeedback === 'function') onFeedback({ lookId, verdict: verdict.id });
                      }}
                      style={({ pressed }) => [
                        styles.btn,
                        selected && styles.btnOn,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={[styles.btnText, selected && styles.btnTextOn]} numberOfLines={1}>
                        {verdict.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: layout.padX, marginBottom: space.md },
  card: {
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  privacy: {
    fontFamily: SANS,
    fontSize: font.tiny + 0.5,
    lineHeight: 17,
    color: colors.textDim,
    marginBottom: space.md,
  },
  row: { marginBottom: space.md },
  rowLabel: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.text },
  btnRow: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  btn: {
    flex: 1,
    minHeight: HIT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.textDim + alpha.outline,
    backgroundColor: colors.surface,
  },
  /** 选中 = 墨色实心，和既有 Chip 的选中语言一致 */
  btnOn: { backgroundColor: colors.text, borderColor: colors.text },
  pressed: { opacity: 0.72 },
  btnText: { fontFamily: SANS, fontSize: font.small, color: colors.textDim },
  btnTextOn: { color: colors.surface, fontWeight: '600' },
});
