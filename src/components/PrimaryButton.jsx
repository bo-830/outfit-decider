import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, layout, radius, shadow, space } from '../ui/theme';
import { SANS } from '../ui/platform';

/** 底部主 CTA。底色 primary + 白字（实测 5.18:1，过 AA 小字）。 */
export default function PrimaryButton({ label, sub, onPress, testID, disabled = false, loading = false }) {
  const off = disabled || loading;
  return (
    <View>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{ disabled: !!off }}
        disabled={off}
        onPress={onPress}
        style={({ pressed }) => [styles.cta, pressed && styles.pressed, off && styles.off]}
      >
        {loading ? <ActivityIndicator color={colors.surface} size="small" /> : null}
        <Text style={styles.label}>{label}</Text>
      </Pressable>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cta: {
    minHeight: layout.ctaHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    ...shadow.lift,
  },
  pressed: { opacity: 0.88 },
  off: { opacity: 0.45 },
  label: { fontFamily: SANS, fontSize: font.h2 - 1, fontWeight: '600', color: '#FFFFFF' },
  sub: {
    marginTop: space.sm + 1,
    textAlign: 'center',
    fontFamily: SANS,
    fontSize: font.tiny + 0.5,
    color: colors.textDim,
  },
});
