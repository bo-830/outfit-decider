import React from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SCORE_QUESTION_IDS } from '../core/protocol.js';
import { PARTIAL_FAIL_RETRY } from '../data/copy.js';
import { lookIndex } from '../data/options.js';
import {
  alpha,
  colors,
  DIM_LABELS,
  font,
  HIT,
  layout,
  NO_SCORE,
  radius,
  shadow,
  space,
} from '../ui/theme';
import { MONO, SANS } from '../ui/platform';
import ScoreScale from './ScoreScale.jsx';
import DeepReportCard from './DeepReportCard.jsx';

/** 1 位小数；没有分数就用中性占位，绝不写 0 分 */
export function formatScore(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : NO_SCORE;
}

/** 名次读数：01 / 02 / 03 / 04 */
export function formatRank(rank) {
  const n = Number(rank);
  return Number.isFinite(n) && n > 0 ? String(n).padStart(2, '0') : '--';
}

/**
 * 结果页一张读数卡：名次（等宽）| 缩略图 | 综合分 | 六维软尺刻度 | 深度分析。
 * data-rank 只在 web 上挂（react-native-web 会渲染成 data-rank 属性）。
 */
export default function ResultCard({
  look,
  artifact,
  deepReport,
  expanded = false,
  deepBusy = false,
  onDeep,
  onRetry,
  relevance = [],
}) {
  const top = look.rank === 1;
  const failed = look.overall === null || look.overall === undefined;
  const scores = look.scores || {};
  const hot = Array.isArray(relevance) ? relevance : [];
  const webProps = Platform.OS === 'web' ? { dataSet: { rank: String(look.rank ?? '') } } : {};

  return (
    <View
      testID="result-card"
      {...webProps}
      style={[styles.card, top && styles.cardTop, failed && styles.cardFailed]}
    >
      <View style={styles.head}>
        <Text style={[styles.rank, top && styles.rankTop]}>{formatRank(look.rank)}</Text>

        <View style={styles.thumb}>
          {artifact ? (
            <Image
              source={{ uri: `data:${artifact.mime};base64,${artifact.base64}` }}
              style={styles.thumbImage}
              resizeMode="cover"
              accessibilityLabel={`第 ${lookIndex(look.lookId)} 套穿搭`}
            />
          ) : null}
        </View>

        <View style={styles.body}>
          <View style={styles.scoreLine}>
            {top ? <Text style={styles.tag}>今天穿这套</Text> : <View />}
            <View style={styles.scoreWrap}>
              <Text testID="score-value" style={[styles.score, top && styles.scoreTop]}>
                {formatScore(look.overall)}
              </Text>
              {failed ? null : <Text style={styles.scoreUnit}>/5</Text>}
            </View>
          </View>

          <View style={styles.dims}>
            {SCORE_QUESTION_IDS.map((id) => (
              <View key={id} testID="dim-row" style={styles.dim}>
                <View style={styles.dimHead}>
                  <Text style={[styles.dimLabel, hot.includes(id) && styles.dimHot]}>{DIM_LABELS[id]}</Text>
                  <Text style={[styles.dimValue, hot.includes(id) && styles.dimValueHot]}>
                    {formatScore(scores[id])}
                  </Text>
                </View>
                <ScoreScale value={scores[id]} hot={hot.includes(id)} />
              </View>
            ))}
          </View>
        </View>
      </View>

      {failed ? (
        <Pressable
          testID="retry-look"
          accessibilityRole="button"
          onPress={() => onRetry(look.lookId)}
          disabled={deepBusy}
          style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
        >
          <Text style={styles.retryText}>{deepBusy ? '正在重试这一套…' : PARTIAL_FAIL_RETRY}</Text>
        </Pressable>
      ) : (
        <Pressable
          testID="deep-run"
          accessibilityRole="button"
          onPress={() => onDeep(look.lookId)}
          disabled={deepBusy}
          style={({ pressed }) => [styles.deep, pressed && styles.pressed, deepBusy && styles.disabled]}
        >
          <Text style={styles.deepText}>
            {deepBusy ? '深度分析中…' : expanded ? '收起报告' : '深度分析'}
          </Text>
          <Text style={styles.deepArrow}>{expanded ? '⌃' : '⌄'}</Text>
        </Pressable>
      )}

      {expanded && deepReport ? <DeepReportCard report={deepReport} focusLookId={look.lookId} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: layout.padX,
    marginBottom: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadow.paper,
  },
  cardTop: { borderColor: colors.accent, ...shadow.lift },
  cardFailed: { borderStyle: 'dashed', borderColor: colors.textDim + alpha.outline },
  head: { flexDirection: 'row', gap: space.md },
  rank: {
    width: 26,
    fontFamily: MONO,
    fontSize: 19,
    lineHeight: 24,
    color: colors.textDim,
  },
  rankTop: { color: colors.accent, fontWeight: '700' },
  thumb: {
    width: layout.thumbW,
    height: layout.thumbH,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  thumbImage: { width: '100%', height: '100%' },
  body: { flex: 1, minWidth: 0 },
  scoreLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  scoreWrap: { flexDirection: 'row', alignItems: 'baseline' },
  tag: {
    fontFamily: SANS,
    fontSize: font.tiny,
    fontWeight: '600',
    color: colors.accent,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  score: {
    fontFamily: MONO,
    fontSize: font.score,
    lineHeight: font.score + 4,
    color: colors.text,
  },
  scoreTop: { color: colors.accent },
  scoreUnit: { fontFamily: MONO, fontSize: font.tiny, color: colors.textDim, marginLeft: 3 },
  dims: { flexDirection: 'row', flexWrap: 'wrap', marginTop: space.sm + 2, rowGap: space.sm },
  dim: { width: '33.33%', paddingRight: space.sm },
  dimHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  dimLabel: { fontFamily: SANS, fontSize: font.tiny, color: colors.textDim },
  dimHot: { color: colors.text, fontWeight: '600' },
  dimValue: { fontFamily: MONO, fontSize: font.small, color: colors.textDim },
  dimValueHot: { color: colors.accent, fontWeight: '700' },
  deep: {
    marginTop: space.md,
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.textDim + alpha.outline,
  },
  deepText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.text },
  deepArrow: { fontFamily: SANS, fontSize: font.small, color: colors.textDim },
  retry: {
    marginTop: space.md,
    minHeight: HIT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.accent,
  },
  retryText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.accent },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.5 },
});
