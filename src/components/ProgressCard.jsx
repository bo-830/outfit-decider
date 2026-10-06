import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, font, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';

const STAGE_TEXT = {
  describing: '正在把照片转成文字',
  scoring: '正在逐套打分',
  // 深度分析比快速评分慢一个量级（实测 18-25s）：文案要明确是"深度分析"，
  // 不要复用评分语气的字眼，否则用户会以为卡在评分上。
  deep: '正在做深度分析',
};

/** 运行中的进度：说明现在在做什么，别让用户对着空白等。 */
export default function ProgressCard({ stage, done = 0, total = 0 }) {
  const text = STAGE_TEXT[stage] || '正在处理';
  const dots = Math.max(1, Math.min(4, total || 1));
  const filled = Math.max(0, Math.min(dots, done || 0));

  return (
    <View testID="progress-card" style={styles.card}>
      <ActivityIndicator color={colors.accent} size="small" />
      <View style={styles.body}>
        <Text style={styles.text}>
          {text}
          {total ? ` ${Math.min(done, total)}/${total}` : ''}
        </Text>
        <View style={styles.dots}>
          {Array.from({ length: dots }).map((_, index) => (
            <View key={index} style={[styles.dot, index < filled && styles.dotOn]} />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: layout.padX,
    marginBottom: space.md,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  body: { flex: 1 },
  text: { fontFamily: SANS, fontSize: font.small + 1, color: colors.text },
  dots: { flexDirection: 'row', gap: space.xs + 1, marginTop: space.sm },
  dot: { width: 22, height: 4, borderRadius: 2, backgroundColor: colors.surfaceAlt },
  dotOn: { backgroundColor: colors.accent },
});
