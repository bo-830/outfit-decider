import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { layout, space } from '../ui/theme';

/**
 * 横向可滚动的一行 chips（SPEC 硬要求：横向 chips 可滚动）。
 * 用负边距让内容在页面左右 padding 之外仍可滚到边缘。
 */
export default function ChipRow({ children, testID }) {
  return (
    <ScrollView
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.scroll}
      contentContainerStyle={styles.content}
    >
      <View style={styles.inner}>{children}</View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { marginHorizontal: -layout.padX },
  content: { paddingHorizontal: layout.padX },
  inner: { flexDirection: 'row', gap: space.sm, paddingVertical: 2 },
});
