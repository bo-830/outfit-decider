import React from 'react';
import { StyleSheet, View } from 'react-native';
import { alpha, colors } from '../ui/theme';

const MAX = 5;

/**
 * 软尺刻度：0–5 的刻度尺 + 落点指针。
 * 这是本 App 的读数语言——分数是量出来的，不是进度条填出来的。
 */
export default function ScoreScale({ value, hot = false }) {
  const numeric = typeof value === 'number' && Number.isFinite(value);
  const pct = numeric ? (Math.max(0, Math.min(MAX, value)) / MAX) * 100 : null;

  return (
    <View style={styles.scale}>
      <View style={styles.ticks}>
        {[0, 1, 2, 3, 4, 5].map((tick) => (
          <View key={tick} style={[styles.tick, tick % 5 === 0 && styles.tickEdge]} />
        ))}
      </View>
      {pct !== null ? (
        <View style={[styles.needle, hot && styles.needleHot, { left: `${pct}%` }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scale: {
    height: 14,
    marginTop: 5,
    justifyContent: 'flex-end',
    borderBottomWidth: 1,
    borderBottomColor: colors.textDim + alpha.faint,
  },
  ticks: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', height: 7 },
  tick: { width: 1, height: 4, backgroundColor: colors.textDim + alpha.faint },
  tickEdge: { height: 7 },
  needle: {
    position: 'absolute',
    bottom: 0,
    marginLeft: -1,
    width: 2,
    height: 11,
    backgroundColor: colors.textDim,
  },
  needleHot: { backgroundColor: colors.accent, height: 14 },
});
