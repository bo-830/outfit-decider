import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lookIndex } from '../data/options.js';
import { colors, font, HIT, layout, radius, space } from '../ui/theme';
import { MONO, SANS } from '../ui/platform';
import EmptyState from '../components/EmptyState.jsx';

const DIM_SHORT = { overall_score: '综合', aesthetic_score: '美观', scene_score: '场合', figure_score: '身材', style_score: '风格', practical_score: '实用' };

function formatTime(tsAt) {
  const date = new Date(tsAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Tab 3 · 历史：只有文字与分数的记录，可删单条 / 清空（图片绝不进历史）。 */
export default function HistoryScreen({ records = [], onDelete, onClear }) {
  const insets = useSafeAreaInsets();
  const [confirmClear, setConfirmClear] = useState(false);
  const list = records.slice().reverse(); // 存储是升序，界面最新在上

  return (
    <View style={styles.flex}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.h1}>历史</Text>
          <Text style={styles.sub}>
            {list.length ? `${list.length} 条记录 · 只存文字和分数` : '只存文字和分数，不含照片'}
          </Text>
        </View>
        {list.length ? (
          <Pressable
            testID="history-clear"
            accessibilityRole="button"
            onPress={() => {
              if (confirmClear) {
                onClear();
                setConfirmClear(false);
              } else {
                setConfirmClear(true);
              }
            }}
            style={styles.clearBtn}
          >
            <Text style={[styles.clearText, confirmClear && styles.clearTextOn]}>
              {confirmClear ? '确认清空？' : '清空'}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {!list.length ? (
        <EmptyState
          testID="history-empty"
          title="还没有记录"
          hint="每跑完一次快速评分，这里会留下场合、问题和六维分数。"
        />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: Math.max(insets.bottom, space.lg) + space.xl }]}
          renderItem={({ item }) => (
            <View testID="history-item" style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.time}>{formatTime(item.tsAt)}</Text>
                <Pressable
                  testID={`history-delete-${item.id}`}
                  accessibilityRole="button"
                  accessibilityLabel="删除这条记录"
                  onPress={() => onDelete(item.id)}
                  hitSlop={8}
                  style={styles.deleteBtn}
                >
                  <Text style={styles.deleteText}>删除</Text>
                </Pressable>
              </View>

              {item.stateSummary ? <Text style={styles.summary}>{item.stateSummary}</Text> : null}
              {item.question ? <Text style={styles.question}>{item.question}</Text> : null}

              {(item.looks || []).map((look) => (
                <View key={look.lookId} style={styles.lookRow}>
                  <Text style={styles.lookRank}>{look.rank ? String(look.rank).padStart(2, '0') : '--'}</Text>
                  <View style={styles.lookBody}>
                    <Text style={styles.lookTitle}>
                      第 {lookIndex(look.lookId)} 套 · 综合{' '}
                      {typeof look.scores?.overall_score === 'number' ? look.scores.overall_score.toFixed(1) : '—'}
                      {Object.entries(look.scores || {})
                        .filter(([key, value]) => key !== 'overall_score' && typeof value === 'number')
                        .slice(0, 3)
                        .map(([key, value]) => ` · ${DIM_SHORT[key] || key} ${value.toFixed(1)}`)
                        .join('')}
                    </Text>
                    {look.description ? (
                      <Text style={styles.lookDesc} numberOfLines={2}>
                        {look.description}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}

              {item.deepSummary?.pick ? (
                <Text style={styles.deep}>深度分析选了第 {lookIndex(item.deepSummary.pick)} 套</Text>
              ) : null}
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: layout.padX,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  headText: { flex: 1, minWidth: 0 },
  h1: { fontFamily: SANS, fontSize: font.h1, fontWeight: '600', color: colors.text, letterSpacing: -0.4 },
  sub: { fontFamily: SANS, fontSize: font.small, color: colors.textDim, marginTop: space.sm - 2 },
  clearBtn: { minHeight: HIT, justifyContent: 'center', paddingLeft: space.lg },
  clearText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.textDim },
  clearTextOn: { color: colors.danger },
  list: { paddingHorizontal: layout.padX, gap: space.md },
  card: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  time: { fontFamily: MONO, fontSize: font.tiny + 1, color: colors.textDim },
  deleteBtn: { minHeight: 32, justifyContent: 'center', paddingLeft: space.md },
  deleteText: { fontFamily: SANS, fontSize: font.tiny + 1, color: colors.danger },
  summary: { fontFamily: SANS, fontSize: font.small, color: colors.text, marginTop: space.sm - 2, fontWeight: '600' },
  question: { fontFamily: SANS, fontSize: font.tiny + 1, color: colors.textDim, marginTop: 3 },
  lookRow: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.sm + 2,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  lookRank: { fontFamily: MONO, fontSize: font.small, color: colors.textDim },
  lookBody: { flex: 1, minWidth: 0 },
  lookTitle: { fontFamily: SANS, fontSize: font.tiny + 1, color: colors.text },
  lookDesc: { fontFamily: SANS, fontSize: font.tiny, lineHeight: 16, color: colors.textDim, marginTop: 3 },
  deep: { fontFamily: SANS, fontSize: font.tiny, color: colors.accent, marginTop: space.sm },
});
