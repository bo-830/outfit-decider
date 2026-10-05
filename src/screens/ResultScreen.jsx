import React from 'react';
import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { selectRankedLooks } from '../core/flow.js';
import { colors, font, HIT, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';
import EmptyState from '../components/EmptyState.jsx';
import EngineBadge from '../components/EngineBadge.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import NameplateRow from '../components/NameplateRow.jsx';
import ProgressCard from '../components/ProgressCard.jsx';
import ResultCard from '../components/ResultCard.jsx';
import ToggleRow from '../components/ToggleRow.jsx';
import WeakNetBanner from '../components/WeakNetBanner.jsx';
import CompareView from './CompareView.jsx';

/** Tab 2 · 结果：按综合分降序的读数卡 + 深度分析入口 + 双系统同屏对比。 */
export default function ResultScreen({
  flow,
  dispatch,
  artifacts = [],
  deepBusyLook = null,
  expandedLookId = null,
  onDeep,
  onRetryLook,
  onGoCapture,
  onGoSettings,
  onSwitchToQuick,
  onRetry,
  staleHint = false,
  onRerun,
  engineMode = null,
}) {
  const insets = useSafeAreaInsets();
  const ranked = selectRankedLooks(flow);
  const running = flow.phase === 'describing' || flow.phase === 'scoring' || flow.phase === 'deep_running';
  const focusLookId = expandedLookId || (ranked[0] ? ranked[0].lookId : null);
  const deepReports = flow.deep || {};
  const scoredCount = ranked.filter((look) => look.overall !== null && look.overall !== undefined).length;

  /**
   * SPEC §3.9c · 结论来源标注。
   * 权威来源是**这次运行**的 flow.quick.engineMode（跑完再改设置也不会把历史结论说错）；
   * engineMode prop 只作为引擎尚未回报时的兜底，两者都没有就如实写「未标注」。
   */
  const quick = flow.quick || null;
  const usedEngineMode = (quick && quick.engineMode) || engineMode || null;
  const reviewChange = quick ? quick.reviewChange || quick.reviewChanged || null : null;
  const reviewApplied =
    !!quick &&
    quick.reviewFailed !== true &&
    (Array.isArray(reviewChange) ? reviewChange.length > 0 : !!reviewChange);

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, space.lg) + space.xl }]}
    >
      <View style={styles.head}>
        <Text style={styles.h1}>{ranked.length ? `${ranked.length} 套排名` : '结果'}</Text>
        <Text style={styles.sub}>{ranked.length ? '按综合分从高到低' : '跑完快速评分后，这里会给出排名'}</Text>
      </View>

      {flow.weakNetwork ? <WeakNetBanner onSwitchToQuick={onSwitchToQuick} /> : null}
      {flow.error ? (
        <ErrorBanner
          error={flow.error}
          onRetry={onRetry}
          onDismiss={() => dispatch({ type: 'CLEAR_ERROR' })}
          onGoSettings={onGoSettings}
        />
      ) : null}
      {running ? <ProgressCard stage={flow.phase === 'deep_running' ? 'deep' : 'scoring'} done={0} total={artifacts.length} /> : null}

      {quick ? (
        <EngineBadge
          mode={usedEngineMode}
          reviewFailed={quick.reviewFailed === true}
          reviewErrorKind={quick.reviewErrorKind || null}
          reviewApplied={reviewApplied}
          onGoSettings={onGoSettings}
        />
      ) : null}

      {staleHint ? (
        <View testID="stale-hint" style={styles.stale}>
          <Text style={styles.staleText}>条件改过了，重新评分会更准。</Text>
          <Pressable accessibilityRole="button" onPress={onRerun} style={styles.staleBtn} hitSlop={6}>
            <Text style={styles.staleAction}>重新评分</Text>
          </Pressable>
        </View>
      ) : null}

      {!ranked.length ? (
        <EmptyState
          testID="result-empty"
          title="还没有分数"
          hint="去「上传」里选好照片和场合，点底部的「开始快速评分」。"
          actionLabel="去上传照片"
          onAction={onGoCapture}
        />
      ) : (
        <View>
          <NameplateRow left="名次 · 穿搭 · 综合分" right={`${scoredCount}/${ranked.length} 套有效`} />

          {ranked.map((look) => (
            <ResultCard
              key={look.lookId}
              look={look}
              relevance={look.relevance}
              artifact={artifacts.find((item) => item.lookId === look.lookId) || null}
              deepReport={deepReports[look.lookId] || null}
              expanded={expandedLookId === look.lookId}
              deepBusy={deepBusyLook === look.lookId}
              onDeep={onDeep}
              onRetry={onRetryLook}
            />
          ))}

          <ToggleRow
            testID="compare-toggle"
            title="双系统同屏对比"
            sub="左边看分数，右边看报告"
            value={flow.compareOpen}
            onValueChange={() => dispatch({ type: 'TOGGLE_COMPARE' })}
          />

          {flow.compareOpen ? (
            <CompareView
              ranked={ranked}
              artifacts={artifacts}
              deepReports={deepReports}
              focusLookId={focusLookId}
              deepBusy={deepBusyLook !== null}
              onDeep={onDeep}
            />
          ) : null}
        </View>
      )}

      <Text style={styles.footnote}>分数只反映照片里看得见的东西，看不清的地方不会瞎猜。</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingTop: space.sm },
  head: { paddingHorizontal: layout.padX, paddingTop: space.lg, paddingBottom: space.md },
  h1: { fontFamily: SANS, fontSize: font.h1, fontWeight: '600', color: colors.text, letterSpacing: -0.4 },
  sub: { fontFamily: SANS, fontSize: font.small, color: colors.textDim, marginTop: space.sm - 2 },
  footnote: {
    paddingHorizontal: layout.padX,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontFamily: SANS,
    fontSize: font.tiny + 0.5,
    lineHeight: 17,
    color: colors.textDim,
  },
  stale: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    marginHorizontal: layout.padX,
    marginBottom: space.md,
    paddingHorizontal: space.md,
    minHeight: HIT,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.warn,
  },
  staleText: { flex: 1, fontFamily: SANS, fontSize: font.small, color: colors.warn },
  staleBtn: { minHeight: HIT, justifyContent: 'center', paddingLeft: space.sm },
  staleAction: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.accent },
});
