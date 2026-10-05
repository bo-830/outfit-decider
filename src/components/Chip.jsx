import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { alpha, colors, font, HIT, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';

/**
 * 纸感 pill chip：最小触达 44px（SPEC 硬要求）。
 * 选中＝墨色实心，琥珀只留给主 CTA 与读数，不在 chips 上用强调色。
 */
export default function Chip({ label, selected, onPress, testID, small = false, disabled = false }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        small && styles.small,
        selected && styles.on,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.text, small && styles.textSmall, selected && styles.textOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: HIT,
    paddingHorizontal: space.lg,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.textDim + alpha.outline,
    backgroundColor: colors.surface,
  },
  small: { minHeight: HIT, paddingHorizontal: space.md },
  on: { backgroundColor: colors.text, borderColor: colors.text },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
  text: { fontFamily: SANS, fontSize: font.body - 1, color: colors.textDim },
  textSmall: { fontSize: font.small },
  textOn: { color: colors.surface, fontWeight: '600' },
});
