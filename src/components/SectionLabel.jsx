import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, space } from '../ui/theme';
import { SANS } from '../ui/platform';

/**
 * 区块标题：左边是标题，右边一行说明（可多选 / 已选 N / 可不填…）。
 * `dim`：整组当前不参与流程时把标题降为次级墨色（仍过 AA，5.39:1）。
 */
export default function SectionLabel({ title, meta, right = null, style, dim = false }) {
  return (
    <View style={[styles.row, style]}>
      <Text style={[styles.title, dim && styles.titleDim]}>{title}</Text>
      {right || (meta ? <Text style={styles.meta}>{meta}</Text> : null)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.md,
    marginBottom: space.sm + 1,
    paddingHorizontal: 0,
  },
  title: { fontFamily: SANS, fontSize: font.body, fontWeight: '600', color: colors.text },
  titleDim: { color: colors.textDim },
  meta: { fontFamily: SANS, fontSize: font.tiny + 0.5, color: colors.textDim },
});
