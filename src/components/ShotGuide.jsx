import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, HIT, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';
import { SHOT_TIP_HEADLINE, SHOT_TIPS } from '../data/shotTips.js';
import SectionLabel from './SectionLabel.jsx';

/**
 * 拍摄引导（可折叠，默认收起）。
 *
 * 目的：结果页分数偏低时，用户第一反应是"模型不准"，但多数情况是照片拍法的问题
 * （逆光 / 半身 / 脏镜子）。这里给的是可执行动作，不是"注意光线"式提醒。
 *
 * 契约：
 *   - 容器 testID = "shot-guide"，切换按钮 testID = "shot-guide-toggle"；
 *   - 默认收起（`defaultOpen` 只作为逃生口，默认 false）；
 *   - 收起时教程条目**不挂在树上**，展开才渲染（testID "shot-guide-body"）。
 * 样式沿用既有卡片语言（surface + border + radius，同 ProgressCard/ErrorBanner），
 * 横向留白由组件自己给（marginHorizontal: layout.padX），直接放进 ScrollView 即可。
 */

/** 文案集中在文件顶部 */
const TITLE = '拍摄引导';
const META = '拍之前看一眼';
const OPEN_LABEL = '展开';
const CLOSE_LABEL = '收起';
const LIST_NOTE =
  '分数比预期低时，先照着上面重拍一张再看——多数「模型不准」其实是照片的问题，不是衣服的问题。';

export default function ShotGuide({
  tips = SHOT_TIPS,
  headline = SHOT_TIP_HEADLINE,
  defaultOpen = false,
  style,
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const list = Array.isArray(tips) ? tips : [];

  return (
    <View testID="shot-guide" style={[styles.wrap, style]}>
      <SectionLabel title={TITLE} meta={META} />
      <View style={styles.card}>
        <Pressable
          testID="shot-guide-toggle"
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
        >
          <View style={styles.toggleText}>
            <Text style={styles.headline}>{headline}</Text>
            <Text style={styles.toggleSub}>{`点开看这 ${list.length} 条，照着重拍一张再打分`}</Text>
          </View>
          <Text style={styles.toggleAction}>{open ? CLOSE_LABEL : OPEN_LABEL}</Text>
        </Pressable>

        {open ? (
          <View testID="shot-guide-body" style={styles.list}>
            {list.map((tip, index) => (
              <View key={`shot-tip-${index}`} style={styles.item}>
                <Text style={styles.num}>{index + 1}</Text>
                <Text style={styles.tip}>{tip}</Text>
              </View>
            ))}
            <Text style={styles.note}>{LIST_NOTE}</Text>
          </View>
        ) : null}
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
  /** 整行可点：44px 触达，右侧是展开/收起动作 */
  toggle: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  toggleText: { flex: 1, minWidth: 0 },
  headline: { fontFamily: SANS, fontSize: font.body, fontWeight: '600', color: colors.text },
  toggleSub: {
    fontFamily: SANS,
    fontSize: font.tiny + 0.5,
    lineHeight: 17,
    color: colors.textDim,
    marginTop: 3,
  },
  toggleAction: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.accent },
  pressed: { opacity: 0.75 },
  list: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm + 2, marginBottom: space.md },
  num: {
    width: 18,
    fontFamily: SANS,
    fontSize: font.small,
    lineHeight: 20,
    fontWeight: '700',
    color: colors.accent,
    textAlign: 'center',
  },
  tip: { flex: 1, minWidth: 0, fontFamily: SANS, fontSize: font.small, lineHeight: 20, color: colors.text },
  note: {
    fontFamily: SANS,
    fontSize: font.tiny + 0.5,
    lineHeight: 17,
    color: colors.textDim,
    marginTop: space.xs,
  },
});
