import React from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { colors, font, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';

/** 一行开关（同屏对比等）。44px 触达由整行可点保证。 */
export default function ToggleRow({ testID, title, sub, value, onValueChange, disabled = false }) {
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      </View>
      <Switch
        testID={testID}
        accessibilityLabel={title}
        disabled={disabled}
        value={!!value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.surfaceAlt, true: colors.text }}
        thumbColor={colors.surface}
        ios_backgroundColor={colors.surfaceAlt}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    marginHorizontal: layout.padX,
    marginVertical: space.md,
    padding: space.md,
    minHeight: 56,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: SANS, fontSize: font.body - 1, fontWeight: '600', color: colors.text },
  sub: { fontFamily: SANS, fontSize: font.tiny + 0.5, color: colors.textDim, marginTop: 3 },
});
