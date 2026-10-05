import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font } from '../ui/theme';
import { SANS } from '../ui/platform';

const GLYPH = '★★★★★';

/** 五星（支持 .5）：底层空星 + 上层裁切到 value/5 的实星，读数精确不取整。 */
export default function StarRating({ value, size = font.small, testID }) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const pct = (Math.max(0, Math.min(5, numeric)) / 5) * 100;

  return (
    <View testID={testID} style={styles.wrap} accessibilityLabel={`${numeric} 星`}>
      <Text style={[styles.stars, { fontSize: size, lineHeight: size + 4, color: colors.starOff }]}>{GLYPH}</Text>
      <View style={[styles.overlay, { width: `${pct}%` }]} pointerEvents="none">
        <Text
          numberOfLines={1}
          style={[styles.stars, { fontSize: size, lineHeight: size + 4, color: colors.starOn }]}
        >
          {GLYPH}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', alignSelf: 'flex-start' },
  stars: { fontFamily: SANS, letterSpacing: 1 },
  overlay: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
});
