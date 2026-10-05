import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MAX_LOOKS } from '../core/protocol.js';
import { alpha, colors, font, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';
import ErrorBanner from '../components/ErrorBanner.jsx';
import LookGrid from '../components/LookGrid.jsx';
import PrimaryButton from '../components/PrimaryButton.jsx';
import QuestionPicker from '../components/QuestionPicker.jsx';
import SectionLabel from '../components/SectionLabel.jsx';
import StateChips from '../components/StateChips.jsx';

/** Tab 1 · 上传：选图 → 三组 chips → 补一句 → 问题 → 底部主 CTA（SPEC §2）。 */
export default function CaptureScreen({
  flow,
  dispatch,
  onPickImages,
  onRemoveLook,
  onSubmit,
  pickBusy = false,
  hints = [],
  canRun = false,
  running = false,
}) {
  const insets = useSafeAreaInsets();
  const artifacts = flow.artifacts || [];
  const count = artifacts.length;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.head}>
          <Text style={styles.h1}>今天穿哪套？</Text>
          <Text style={styles.sub}>
            {count ? `已选 ${count} 套 · 看看哪套最合适` : '选 1-4 张今天的穿搭照，再告诉我场合'}
          </Text>
        </View>

        <LookGrid artifacts={artifacts} onPick={onPickImages} onRemove={onRemoveLook} busy={pickBusy} />

        <StateChips
          userState={flow.userState}
          onToggle={(group, id) => dispatch({ type: 'TOGGLE_STATE', group, id })}
        />

        <View style={styles.block}>
          <View style={styles.padX}>
            <SectionLabel title="再补一句" meta="可不填 · 会直接影响打分" />
          </View>
          <View style={styles.padX}>
            <TextInput
              testID="state-note"
              style={styles.note}
              value={flow.userState?.note || ''}
              onChangeText={(note) => dispatch({ type: 'SET_NOTE', note })}
              placeholder="比如：下午要见客户，晚上和朋友吃饭"
              placeholderTextColor={colors.textDim}
              maxLength={200}
              multiline
              textAlignVertical="top"
              accessibilityLabel="补充说明"
            />
          </View>
        </View>

        <View style={styles.block}>
          <QuestionPicker
            question={flow.question}
            onSelectBuiltin={(builtinId, text) => {
              if (flow.question?.builtinId === builtinId) dispatch({ type: 'CLEAR_QUESTION' });
              else dispatch({ type: 'SET_QUESTION', builtinId, text });
            }}
            onChangeText={(text) => dispatch({ type: 'SET_QUESTION', builtinId: null, text })}
          />
        </View>

        {hints.length ? (
          <View testID="input-hints" style={styles.hints}>
            {hints.map((hint) => (
              <View key={hint} style={styles.hintRow}>
                <View style={styles.hintDot} />
                <Text style={styles.hintText}>{hint}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {flow.error ? (
          <View style={styles.errorWrap}>
            <ErrorBanner error={flow.error} onDismiss={() => dispatch({ type: 'CLEAR_ERROR' })} />
          </View>
        ) : null}
      </ScrollView>

      {/* CTA 与 ScrollView 是并列兄弟节点：内容永远滚得到，不会被 CTA 压住 */}
      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, space.lg) + space.xs }]}>
        <PrimaryButton
          testID="submit-quick"
          label={running ? '正在评分…' : '开始快速评分'}
          sub="只出分数，不出解释 · 约 10 秒（网络不好会自动重试一次）"
          onPress={onSubmit}
          disabled={!canRun}
          loading={running}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingBottom: space.xl },
  head: { paddingHorizontal: layout.padX, paddingTop: space.lg, paddingBottom: space.md + 2 },
  h1: { fontFamily: SANS, fontSize: font.h1, fontWeight: '600', color: colors.text, letterSpacing: -0.4 },
  sub: { fontFamily: SANS, fontSize: font.small, color: colors.textDim, marginTop: space.sm - 2 },
  block: { marginTop: space.xl - 4 },
  padX: { paddingHorizontal: layout.padX },
  note: {
    minHeight: 56,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.textDim + alpha.outline,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: SANS,
    fontSize: font.body,
    lineHeight: 21,
  },
  hints: { marginTop: space.lg, paddingHorizontal: layout.padX, gap: space.sm },
  hintRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  hintDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.warn, marginTop: 7 },
  hintText: { flex: 1, fontFamily: SANS, fontSize: font.tiny + 1, lineHeight: 18, color: colors.textDim },
  errorWrap: { marginTop: space.lg },
  dock: {
    paddingHorizontal: layout.padX,
    paddingTop: space.md,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
