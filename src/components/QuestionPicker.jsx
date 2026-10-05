import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { BUILTIN_QUESTIONS } from '../data/options.js';
import { alpha, colors, font, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';
import Chip from './Chip.jsx';
import ChipRow from './ChipRow.jsx';
import SectionLabel from './SectionLabel.jsx';

const MAX_QUESTION_LENGTH = 200;

/** 内置问题（单选）+ 自定义问题输入框。 */
export default function QuestionPicker({ question, onSelectBuiltin, onChangeText }) {
  const [custom, setCustom] = useState(question?.builtinId ? '' : question?.text || '');

  // 外部清空自定义问题时同步输入框（例如清空全部 / 重置）
  useEffect(() => {
    if (question?.builtinId) setCustom('');
  }, [question?.builtinId]);

  useEffect(() => {
    if (!question || (question.builtinId === null && question.text === '')) setCustom('');
  }, [question?.text, question?.builtinId]);

  const isCustom = !!custom.trim() && !question?.builtinId;

  return (
    <View>
      <View style={styles.padX}>
        <SectionLabel title="你想问什么" meta="单选 · 也可以自己写" />
      </View>
      <ChipRow testID="chips-question">
        {BUILTIN_QUESTIONS.map((item) => (
          <Chip
            key={item.id}
            testID={`chip-question-${item.id}`}
            label={item.label}
            small
            selected={question?.builtinId === item.id}
            onPress={() => onSelectBuiltin(item.id, item.text)}
          />
        ))}
      </ChipRow>

      <View style={styles.padX}>
        <TextInput
          testID="question-input"
          style={[styles.input, isCustom && styles.inputActive]}
          value={custom}
          onChangeText={(text) => {
            setCustom(text.slice(0, MAX_QUESTION_LENGTH));
            onChangeText(text.slice(0, MAX_QUESTION_LENGTH));
          }}
          placeholder="也可以自己写一个问题…"
          placeholderTextColor={colors.textDim}
          maxLength={MAX_QUESTION_LENGTH}
          returnKeyType="done"
          accessibilityLabel="自定义问题"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  padX: { paddingHorizontal: layout.padX },
  input: {
    marginTop: space.md,
    minHeight: 52,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.textDim + alpha.outline,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: SANS,
    fontSize: font.body,
  },
  inputActive: { borderColor: colors.accent, borderWidth: 1 },
});
