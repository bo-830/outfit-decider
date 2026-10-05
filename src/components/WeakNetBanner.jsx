import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { WEAK_NETWORK } from '../data/copy.js';
import { colors, font, HIT, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';

/** 弱网横幅（§5.2）：文案逐字来自 copy.js，并提供一键切 System One。 */
export default function WeakNetBanner({ onSwitchToQuick }) {
  return (
    <View testID="banner-weaknet" style={styles.banner}>
      <View style={styles.dot} />
      <Text style={styles.text}>{WEAK_NETWORK}</Text>
      {onSwitchToQuick ? (
        <Pressable accessibilityRole="button" onPress={onSwitchToQuick} style={styles.action} hitSlop={6}>
          <Text style={styles.actionText}>切到快速评分</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: layout.padX,
    marginBottom: space.md,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.warn,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.warn },
  text: { flex: 1, fontFamily: SANS, fontSize: font.tiny + 1, lineHeight: 18, color: colors.warn },
  action: { minHeight: HIT, justifyContent: 'center', paddingLeft: space.sm },
  actionText: { fontFamily: SANS, fontSize: font.tiny + 1, fontWeight: '600', color: colors.accent },
});
