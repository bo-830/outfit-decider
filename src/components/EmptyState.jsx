import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';
import PrimaryButton from './PrimaryButton.jsx';

/** 空态：说清楚现在缺什么、下一步做什么。 */
export default function EmptyState({ testID, title, hint, actionLabel, onAction, children }) {
  return (
    <View testID={testID} style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
      {actionLabel && onAction ? (
        <View style={styles.action}>
          <PrimaryButton label={actionLabel} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: layout.padX,
    padding: space.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  title: { fontFamily: SANS, fontSize: font.h2 - 2, fontWeight: '600', color: colors.text, textAlign: 'center' },
  hint: {
    fontFamily: SANS,
    fontSize: font.small,
    lineHeight: 20,
    color: colors.textDim,
    textAlign: 'center',
    marginTop: space.sm,
  },
  action: { alignSelf: 'stretch', marginTop: space.lg },
});
