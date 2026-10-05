import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SCORE_QUESTION_IDS } from '../core/protocol.js';
import { lookIndex } from '../data/options.js';
import { colors, DIM_LABELS, font, HIT, layout, NO_SCORE, radius, space } from '../ui/theme';
import { MONO, SANS } from '../ui/platform';
import StarRating from '../components/StarRating.jsx';

function score(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : NO_SCORE;
}

function thumbUri(artifact) {
  return artifact ? `data:${artifact.mime};base64,${artifact.base64}` : null;
}

/**
 * 双系统同屏对比（SPEC §4.2 / §7.6）：左栏「快速评分」分数，右栏「深度分析」报告。
 * 两栏都在 390 宽里完整可见，不靠横向滚动藏住任何一栏。
 */
export default function CompareView({
  ranked = [],
  artifacts = [],
  deepReports = {},
  focusLookId = null,
  deepBusy = false,
  onDeep,
}) {
  const focus = ranked.find((look) => look.lookId === focusLookId) || ranked[0] || null;
  const report = focusLookId ? deepReports[focusLookId] || null : null;
  const detail = report
    ? (report.details || []).find((item) => item && item.lookId === (focus ? focus.lookId : null)) ||
      (report.details || [])[0] ||
      null
    : null;
  const conclusion = report ? report.conclusion : null;

  return (
    <View testID="compare-view" style={styles.wrap}>
      <View style={styles.pane}>
        <Text style={styles.tag}>快速评分</Text>
        {focus ? (
          <View>
            <View style={styles.bigRow}>
              <Text testID="compare-score" style={styles.big}>
                {score(focus.overall)}
              </Text>
              <Text style={styles.bigSub}>综合分 · 第 {focus.rank} 名</Text>
            </View>
            {(focus.relevance && focus.relevance.length ? focus.relevance : SCORE_QUESTION_IDS)
              .slice(0, 6)
              .map((id) => (
                <View key={id} style={styles.row}>
                  <Text style={styles.rowLabel}>{DIM_LABELS[id]}</Text>
                  <Text style={styles.rowValue}>{score((focus.scores || {})[id])}</Text>
                </View>
              ))}
            <Text style={styles.caption}>排序只看综合分，高亮的两维对应你的问题。</Text>

            <View style={styles.miniList}>
              {ranked.slice(0, 3).map((look) => (
                <View key={look.lookId} style={styles.mini}>
                  <View style={styles.miniThumb}>
                    <Image
                      source={{ uri: thumbUri(artifacts.find((item) => item.lookId === look.lookId)) }}
                      style={styles.miniImage}
                      resizeMode="cover"
                    />
                  </View>
                  <View style={styles.miniBody}>
                    <Text style={styles.miniTitle}>
                      第 {lookIndex(look.lookId)} 套 · {score(look.overall)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : (
          <Text style={styles.empty}>还没有分数。</Text>
        )}
      </View>

      <View style={[styles.pane, styles.paneTwo]}>
        <Text style={[styles.tag, styles.tagTwo]}>深度分析</Text>

        {report ? (
          <View>
            {(report.ranking || []).slice(0, 3).map((row) => (
              <View key={row.lookId} style={styles.mini}>
                <View style={styles.miniThumb}>
                  <Image
                    source={{ uri: thumbUri(artifacts.find((item) => item.lookId === row.lookId)) }}
                    style={styles.miniImage}
                    resizeMode="cover"
                  />
                </View>
                <View style={styles.miniBody}>
                  <Text style={styles.miniTitle}>第 {lookIndex(row.lookId)} 套</Text>
                  <StarRating value={row.stars} size={font.tiny} />
                  <Text style={styles.miniReason}>{row.oneLineReason}</Text>
                </View>
              </View>
            ))}

            {conclusion ? (
              <View style={styles.note}>
                <Text style={styles.noteTitle}>选第 {lookIndex(conclusion.pick)} 套</Text>
                <Text style={styles.noteText}>{conclusion.reason}</Text>
              </View>
            ) : null}

            {detail && (detail.suggestions || []).length ? (
              <Text style={styles.caption}>→ {detail.suggestions[0]}</Text>
            ) : null}
          </View>
        ) : (
          <View>
            <Text style={styles.empty}>右栏还没跑深度分析。</Text>
            {focus && onDeep ? (
              <Pressable
                testID="compare-deep-run"
                accessibilityRole="button"
                onPress={() => onDeep(focus.lookId)}
                disabled={deepBusy}
                style={({ pressed }) => [styles.deepBtn, pressed && styles.pressed, deepBusy && styles.disabled]}
              >
                <Text style={styles.deepText}>{deepBusy ? '深度分析中…' : '跑这套的深度分析'}</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    marginHorizontal: layout.padX,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  pane: { flex: 1, minWidth: 0, padding: space.sm + 2 },
  paneTwo: { borderLeftWidth: 1, borderLeftColor: colors.border, backgroundColor: colors.surfaceAlt },
  tag: {
    alignSelf: 'flex-start',
    fontFamily: SANS,
    fontSize: font.tiny,
    fontWeight: '600',
    color: colors.surface,
    backgroundColor: colors.text,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  tagTwo: { backgroundColor: colors.primary },
  bigRow: { marginTop: space.sm + 2 },
  big: { fontFamily: MONO, fontSize: 30, lineHeight: 34, color: colors.text },
  bigSub: { fontFamily: SANS, fontSize: font.tiny, color: colors.textDim, marginTop: 3 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm - 2 },
  rowLabel: { fontFamily: SANS, fontSize: font.tiny + 0.5, color: colors.textDim },
  rowValue: { fontFamily: MONO, fontSize: font.small, color: colors.text },
  caption: {
    fontFamily: SANS,
    fontSize: font.tiny,
    lineHeight: 16,
    color: colors.textDim,
    marginTop: space.sm + 2,
  },
  miniList: { marginTop: space.sm + 2, gap: space.sm },
  mini: { flexDirection: 'row', gap: space.sm, alignItems: 'center', marginBottom: space.sm },
  miniThumb: {
    width: 30,
    height: 38,
    borderRadius: radius.sm - 2,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  miniImage: { width: '100%', height: '100%' },
  miniBody: { flex: 1, minWidth: 0 },
  miniTitle: { fontFamily: MONO, fontSize: font.tiny, color: colors.text },
  miniReason: { fontFamily: SANS, fontSize: font.tiny, lineHeight: 15, color: colors.textDim, marginTop: 3 },
  note: { marginTop: space.sm, padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.primarySoft },
  noteTitle: { fontFamily: SANS, fontSize: font.tiny + 1, fontWeight: '700', color: colors.accent },
  noteText: { fontFamily: SANS, fontSize: font.tiny, lineHeight: 16, color: colors.text, marginTop: 3 },
  empty: { fontFamily: SANS, fontSize: font.tiny + 1, lineHeight: 18, color: colors.textDim, marginTop: space.sm },
  deepBtn: {
    marginTop: space.sm + 2,
    minHeight: HIT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  deepText: { fontFamily: SANS, fontSize: font.tiny + 1, fontWeight: '600', color: colors.accent },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
});
