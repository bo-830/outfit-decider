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
import SystemModeSelector from '../components/SystemModeSelector.jsx';

/**
 * CTA 文案随「本次跑哪个」变化——点了会发生什么必须写在按钮上。
 * `quick` 的 label/sub 是发布版原文，**逐字不动**（验收脚本与文案回归都依赖它）。
 */
const SYSTEM_CTA = {
  quick: {
    label: '开始快速评分',
    runningLabel: '正在评分…',
    sub: '只出分数，不出解释 · 约 10 秒（网络不好会自动重试一次）',
  },
  deep: {
    label: '开始深度分析',
    runningLabel: '正在做深度分析…',
    sub: '多模态逐套看图写报告 · 通常 20 秒以上',
  },
  both: {
    label: '先评分，再深度分析',
    runningLabel: '正在评分…',
    sub: '先出 6 维分数，再自动跑深度报告 · 比单跑更久',
  },
};

/**
 * 选 `deep` 但一张图都没有时的专用提示：深度分析是"看图写报告"，没有照片根本无从开始。
 * 这里**替换**掉通用的「先选 1-4 张穿搭照片吧」，而不是并列两条（无图时那条本来也只说选图）。
 */
const DEEP_NEEDS_PHOTO = '深度分析需要先选照片，报告要对着画面写';

/** Tab 1 · 上传：选图 → 本次跑哪个 → 三组 chips → 补一句 → 问题 → 底部主 CTA（SPEC §2）。 */
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
  systemMode = 'quick',
  onSelectSystem,
}) {
  const insets = useSafeAreaInsets();
  const artifacts = flow.artifacts || [];
  const count = artifacts.length;
  const mode = SYSTEM_CTA[systemMode] ? systemMode : 'quick';
  const cta = SYSTEM_CTA[mode];
  const deepNeedsPhoto = mode === 'deep' && count === 0;

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

        {/* 两个引擎是并列的：跑哪个由用户在这里定，而不是被 CTA 写死成"先快速评分" */}
        <View style={styles.block}>
          <View style={styles.padX}>
            <SectionLabel title="本次跑哪个" meta="三选一" />
          </View>
          <View style={styles.padX}>
            <SystemModeSelector value={mode} onChange={onSelectSystem} />
          </View>
        </View>

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

        {deepNeedsPhoto ? (
          <View testID="deep-needs-photo" style={styles.hints}>
            <View style={styles.hintRow}>
              <View style={styles.hintDot} />
              <Text style={styles.hintText}>{DEEP_NEEDS_PHOTO}</Text>
            </View>
          </View>
        ) : hints.length ? (
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
          label={running ? cta.runningLabel : cta.label}
          sub={cta.sub}
          onPress={() => onSubmit?.(mode)}
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
