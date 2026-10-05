import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { lookIndex } from '../data/options.js';
import { colors, font, radius, space } from '../ui/theme';
import { MONO, SANS } from '../ui/platform';
import StarRating from './StarRating.jsx';

/**
 * System Two 报告：三段式（排名 / 这套的五个维度 / 结论）。
 * 只呈现模型返回的内容，不补写任何评价。
 */
export default function DeepReportCard({ report, focusLookId }) {
  if (!report || typeof report !== 'object') return null;

  const ranking = Array.isArray(report.ranking) ? report.ranking : [];
  const details = Array.isArray(report.details) ? report.details : [];
  const detail = details.find((item) => item && item.lookId === focusLookId) || details[0] || null;
  const conclusion = report.conclusion || null;

  return (
    <View testID="deep-report" style={styles.card}>
      <Text style={styles.lead}>深度分析报告</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>排名</Text>
        {ranking.map((row) => (
          <View key={row.lookId} style={styles.rankRow}>
            <Text style={styles.rankLook}>第 {lookIndex(row.lookId)} 套</Text>
            <View style={styles.rankStars}>
              <StarRating value={row.stars} size={font.small} />
            </View>
            <Text style={styles.rankReason}>{row.oneLineReason}</Text>
          </View>
        ))}
      </View>

      {detail ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>第 {lookIndex(detail.lookId)} 套的五个维度</Text>
          {(detail.dimensions || []).map((dim) => (
            <View key={dim.name} style={styles.dimRow}>
              <Text style={styles.dimName}>{dim.name}</Text>
              <StarRating value={dim.stars} size={font.tiny + 1} />
            </View>
          ))}
        </View>
      ) : null}

      {detail ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>好在哪 / 差在哪</Text>
          {(detail.pros || []).map((pro) => (
            <Text key={`pro-${pro}`} style={styles.line}>
              <Text style={styles.plus}>＋ </Text>
              {pro}
            </Text>
          ))}
          {(detail.cons || []).map((con) => (
            <Text key={`con-${con}`} style={styles.line}>
              <Text style={styles.minus}>－ </Text>
              {con}
            </Text>
          ))}
          {(detail.suggestions || []).map((suggestion) => (
            <Text key={`sg-${suggestion}`} style={styles.line}>
              <Text style={styles.arrow}>→ </Text>
              {suggestion}
            </Text>
          ))}
        </View>
      ) : null}

      {conclusion ? (
        <View style={styles.conclusion}>
          <Text style={styles.conclusionPick}>选第 {lookIndex(conclusion.pick)} 套</Text>
          <Text style={styles.conclusionReason}>{conclusion.reason}</Text>
          {Array.isArray(conclusion.alternatives)
            ? conclusion.alternatives.map((alt) => (
                <Text key={alt} style={styles.line}>
                  {alt}
                </Text>
              ))
            : null}
          {conclusion.tip ? <Text style={styles.tip}>{conclusion.tip}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  lead: { fontFamily: SANS, fontSize: font.small, fontWeight: '700', color: colors.text, marginBottom: space.sm },
  section: { marginTop: space.sm + 2 },
  sectionTitle: {
    fontFamily: SANS,
    fontSize: font.tiny + 1,
    fontWeight: '600',
    color: colors.textDim,
    marginBottom: space.sm - 2,
  },
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm - 2 },
  rankLook: { fontFamily: MONO, fontSize: font.tiny + 1, color: colors.text, width: 62 },
  rankStars: { width: 62 },
  rankReason: { flex: 1, fontFamily: SANS, fontSize: font.tiny + 1, lineHeight: 17, color: colors.textDim },
  dimRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingVertical: 3,
  },
  dimName: { fontFamily: SANS, fontSize: font.tiny + 1, color: colors.text },
  line: { fontFamily: SANS, fontSize: font.tiny + 1, lineHeight: 19, color: colors.text, marginTop: 3 },
  plus: { color: colors.success, fontWeight: '700' },
  minus: { color: colors.danger, fontWeight: '700' },
  arrow: { color: colors.accent, fontWeight: '700' },
  conclusion: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySoft,
  },
  conclusionPick: { fontFamily: SANS, fontSize: font.small, fontWeight: '700', color: colors.accent },
  conclusionReason: { fontFamily: SANS, fontSize: font.tiny + 1, lineHeight: 19, color: colors.text, marginTop: 4 },
  tip: { fontFamily: SANS, fontSize: font.tiny + 1, lineHeight: 19, color: colors.accent, marginTop: 6 },
});
