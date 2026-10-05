import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { OCCASIONS, STYLES, WEATHERS } from '../data/options.js';
import { colors, font, layout, space } from '../ui/theme';
import { SANS } from '../ui/platform';
import Chip from './Chip.jsx';
import ChipRow from './ChipRow.jsx';
import SectionLabel from './SectionLabel.jsx';

const GROUPS = [
  { key: 'occasion', title: '场合', options: OCCASIONS },
  { key: 'weather', title: '天气', options: WEATHERS },
  { key: 'style', title: '风格偏好', options: STYLES },
];

/** 三组状态 chips：场合 / 天气 / 风格偏好，均可多选。 */
export default function StateChips({ userState, onToggle }) {
  return (
    <View>
      {GROUPS.map((group) => {
        const selected = Array.isArray(userState?.[group.key]) ? userState[group.key] : [];
        return (
          <View key={group.key} style={styles.block}>
            <View style={styles.padX}>
              <SectionLabel title={group.title} meta={selected.length ? `可多选 · 已选 ${selected.length}` : '可多选'} />
            </View>
            <ChipRow testID={`chips-${group.key}`}>
              {group.options.map((option) => (
                <Chip
                  key={option.id}
                  testID={`chip-${group.key}-${option.id}`}
                  label={option.label}
                  selected={selected.includes(option.id)}
                  onPress={() => onToggle(group.key, option.id)}
                />
              ))}
            </ChipRow>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginTop: space.xl - 4 },
  padX: { paddingHorizontal: layout.padX },
});
