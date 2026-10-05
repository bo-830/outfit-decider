import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { alpha, colors, font, HIT, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';

/**
 * SPEC §3.9c · 结果页的结论来源标注。
 *
 * 为什么必须有：同一套图在三档下会给出不同分数（本地模型判断力实测偏弱），
 * 用户有权知道眼前这个排名是谁给的。所以这里只陈述**事实**，不暴露分数差值，
 * 也不把「纠正失败」说成成功——纠正失败时显示的就是 Laya 的原分（§3.9c 回退约定）。
 */

/** 档位 → 徽标文案（与 SPEC §3.9c 冻结文案逐字一致） */
export const ENGINE_BADGE_LABELS = {
  laya_only: '本地模型判断',
  laya_review: '本地模型 + 多模态纠正',
  multimodal_only: '多模态模型判断',
};

/** 引擎没有回报档位时的中性文案：不猜、不用当前设置顶替 */
export const ENGINE_BADGE_UNKNOWN = '结论来源未标注';

export const REVIEW_FAILED_NOTE = '纠正未生效，显示的是本地模型判断';
export const VISION_UNCONFIGURED_NOTE = '还没配置能看图的模型，显示的是本地模型判断';
export const REVIEW_APPLIED_NOTE = '已按画面重新判断';

export function badgeLabelFor(mode) {
  return ENGINE_BADGE_LABELS[mode] || ENGINE_BADGE_UNKNOWN;
}

/** 纠正失败的旁注；没失败返回 null（成功路径不加这一行） */
export function reviewNoteFor({ reviewFailed, reviewErrorKind } = {}) {
  if (reviewFailed !== true) return null;
  return reviewErrorKind === 'vision_unconfigured' ? VISION_UNCONFIGURED_NOTE : REVIEW_FAILED_NOTE;
}

export default function EngineBadge({
  mode = null,
  reviewFailed = false,
  reviewErrorKind = null,
  reviewApplied = false,
  onGoSettings,
}) {
  const note = reviewNoteFor({ reviewFailed, reviewErrorKind });
  const needVisionConfig = note !== null && reviewErrorKind === 'vision_unconfigured';

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View testID="engine-badge" style={[styles.badge, note ? styles.badgeWarn : null]}>
          <Text style={styles.badgeText}>{badgeLabelFor(mode)}</Text>
        </View>
        {!note && reviewApplied ? (
          <Text testID="engine-badge-applied" style={styles.applied}>
            {REVIEW_APPLIED_NOTE}
          </Text>
        ) : null}
      </View>

      {note ? (
        <View style={styles.noteRow}>
          <Text testID="engine-badge-note" style={styles.noteText}>
            {note}
          </Text>
          {needVisionConfig && onGoSettings ? (
            <Pressable
              testID="engine-badge-settings"
              accessibilityRole="button"
              onPress={onGoSettings}
              style={styles.settingsBtn}
            >
              <Text style={styles.settingsText}>去设置页</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: layout.padX, marginBottom: space.md },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  badge: {
    alignSelf: 'flex-start',
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.textDim + alpha.outline,
    backgroundColor: colors.surface,
  },
  badgeWarn: { borderColor: colors.warn },
  badgeText: { fontFamily: SANS, fontSize: font.tiny + 1, fontWeight: '600', color: colors.text },
  applied: { fontFamily: SANS, fontSize: font.tiny + 0.5, color: colors.textDim },
  noteRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  noteText: { flex: 1, minWidth: 0, fontFamily: SANS, fontSize: font.tiny + 1, lineHeight: 17, color: colors.warn },
  settingsBtn: { minHeight: HIT, justifyContent: 'center', paddingLeft: space.sm },
  settingsText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.accent },
});
