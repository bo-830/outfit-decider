import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, layout, space } from '../ui/theme';
import { SANS } from '../ui/platform';

/** 结果页顶部的读数条：一眼看清「这张表在比什么」。 */
export default function NameplateRow({ left, right }) {
  return (
    <View style={styles.row}>
      <Text style={styles.left}>{left}</Text>
      <Text style={styles.right}>{right}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: layout.padX,
    marginBottom: space.sm + 2,
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  left: { fontFamily: SANS, fontSize: font.tiny + 0.5, color: colors.textDim, letterSpacing: 0.3 },
  right: { fontFamily: SANS, fontSize: font.tiny + 0.5, color: colors.text },
});
