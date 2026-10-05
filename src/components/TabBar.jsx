import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, layout, space } from '../ui/theme';
import { SANS } from '../ui/platform';

export const TABS = [
  { id: 'capture', label: '上传' },
  { id: 'result', label: '结果' },
  { id: 'history', label: '历史' },
  { id: 'settings', label: '设置' },
];

/** 顶部 4 个 Tab（横向可滚动），SPEC §2.1 的 tab-* 锚点在这里。 */
export default function TabBar({ tab, onChange }) {
  return (
    <View style={styles.bar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content}>
        {TABS.map((item) => {
          const active = tab === item.id;
          return (
            <Pressable
              key={item.id}
              testID={`tab-${item.id}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(item.id)}
              style={styles.tab}
            >
              <Text style={[styles.label, active && styles.labelOn]}>{item.label}</Text>
              <View style={[styles.underline, active && styles.underlineOn]} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderBottomWidth: 1, borderBottomColor: colors.border },
  content: { paddingHorizontal: layout.padX, gap: space.xl },
  tab: { minHeight: 44, justifyContent: 'flex-end', paddingTop: space.sm },
  label: { fontFamily: SANS, fontSize: font.body, color: colors.textDim, paddingBottom: space.sm },
  labelOn: { color: colors.text, fontWeight: '600' },
  underline: { height: 2, borderRadius: 1, backgroundColor: 'transparent' },
  underlineOn: { backgroundColor: colors.text },
});
