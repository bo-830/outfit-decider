import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';

import { flowReducer, initialFlowState, selectDeepFor, selectRankedLooks } from './src/core/flow.js';
import { MAX_LOOKS, SCORE_QUESTION_IDS } from './src/core/protocol.js';
import { buildScoreQuestions } from './src/core/prompts.js';
import { rankLooks } from './src/core/scoring.js';
import { stateSummary, validateInput } from './src/core/state.js';
import { LOOK_IDS } from './src/data/options.js';
import { classifyError, DEFAULT_CONFIG, makeApi, normalizeBaseUrl } from './src/engine/api.js';
import { makeOrchestrator } from './src/engine/orchestrator.js';
import { appendHistory, clearHistory, loadHistory, makeHistoryRecord, removeHistory } from './src/store/history.js';
import { isSecureStorageAvailable, loadApiKey, saveApiKey } from './src/store/secureKey.js';
import CaptureScreen from './src/screens/CaptureScreen.jsx';
import HistoryScreen from './src/screens/HistoryScreen.jsx';
import HelpScreen from './src/screens/HelpScreen.jsx';
import ResultScreen from './src/screens/ResultScreen.jsx';
import SettingsScreen from './src/screens/SettingsScreen.jsx';
import TabBar from './src/components/TabBar.jsx';
import { colors } from './src/ui/theme.js';

const IS_WEB = Platform.OS === 'web';
/** 非机密配置（服务地址 / 模型 / 模式）另存一份，API Key 只走 secureKey.js */
const CONFIG_KEY = 'od.config.v1';
const PERSISTED_CONFIG_KEYS = ['mode', 'baseUrl', 'askPath', 'healthPath', 'model', 'timeoutMs', 'quickTimeoutMs'];

/**
 * 探针里的 lastRequest 只放元信息：模型、路径、套号、问题 id、模式、真实耗时。
 * 绝不出现图片（data URI / base64）与 apiKey —— §7 断言 8 会 dump 整个 probe。
 */
function buildRequestMeta(kind, current, config) {
  let questionIds = ['deep_report'];
  if (kind !== 'deep') {
    try {
      questionIds = buildScoreQuestions({ userState: current.userState, question: current.question }).map((q) => q.id);
    } catch {
      questionIds = SCORE_QUESTION_IDS.slice();
    }
  }
  return {
    kind,
    mode: config.mode,
    model: config.model,
    url: `${normalizeBaseUrl(config.baseUrl)}${config.askPath}`,
    lookIds: (current.artifacts || []).map((item) => item.lookId),
    questionIds,
    tsAt: Date.now(),
    elapsedMs: null,
  };
}

/** expo-image-picker 的 asset → SPEC §1.1 ImageArtifact（只在内存里存在） */
async function toArtifact(asset, lookId) {
  if (!asset || !asset.uri) return null;
  const mime = asset.mimeType || guessMime(asset.uri);
  let base64 = typeof asset.base64 === 'string' && asset.base64 ? asset.base64 : '';
  if (!base64) base64 = await uriToBase64(asset.uri);
  if (!base64) return null;
  return { lookId, mime, base64, width: asset.width || 0, height: asset.height || 0 };
}

function guessMime(uri) {
  const ext = String(uri || '').split('.').pop().toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/** 多选时 asset 不带 base64：fetch(uri) → FileReader → data URI（web 兜底路径） */
async function uriToBase64(uri) {
  const response = await fetch(uri);
  const blob = await response.blob();
  const dataUri = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('image read failed'));
    reader.readAsDataURL(blob);
  });
  const comma = dataUri.indexOf(',');
  return comma >= 0 ? dataUri.slice(comma + 1) : '';
}

export default function App() {
  const [flow, dispatch] = useReducer(flowReducer, initialFlowState);
  const [tab, setTab] = useState('capture');
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [history, setHistory] = useState([]);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(null);
  const [pickBusy, setPickBusy] = useState(false);
  const [deepBusyLook, setDeepBusyLook] = useState(null);
  const [expandedLookId, setExpandedLookId] = useState(null);
  const [errors, setErrors] = useState([]);
  const [lastRequest, setLastRequest] = useState(null);
  const [conn, setConn] = useState(null);
  const [testing, setTesting] = useState(false);
  const [keySecure, setKeySecure] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  /** 上一次跑分用的条件快照：条件改了旧分数仍显示，但提示可以重跑 */
  const [ranSignature, setRanSignature] = useState(null);

  const flowRef = useRef(flow);
  flowRef.current = flow;
  const configRef = useRef(config);
  configRef.current = config;
  /** 图片的唯一内存副本（SPEC §4.1.1）：绝不写盘、绝不进 AsyncStorage */
  const imagesRef = useRef({});
  const abortRef = useRef(null);
  const lastRecordIdRef = useRef(null);

  const api = useMemo(() => makeApi({ config }), [config]);
  const orchestrator = useMemo(
    () =>
      makeOrchestrator({
        api,
        model: config.model,
        onWeakNet: () => dispatch({ type: 'SET_WEAK', flag: true }),
      }),
    [api, config.model],
  );

  /* ── 启动：读配置 / API Key / 历史 ───────────────────────── */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(CONFIG_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          const patch = {};
          for (const key of PERSISTED_CONFIG_KEYS) {
            if (saved && saved[key] !== undefined) patch[key] = saved[key];
          }
          if (alive) setConfig((prev) => ({ ...prev, ...patch }));
        }
      } catch {
        /* 配置损坏 → 用默认值 */
      }
      try {
        const { key } = await loadApiKey();
        if (key && alive) setConfig((prev) => ({ ...prev, apiKey: key }));
        const secure = await isSecureStorageAvailable();
        if (alive) setKeySecure(secure);
      } catch {
        /* 读不到 Key 就当没配 */
      }
      try {
        const list = await loadHistory(AsyncStorage);
        if (alive) setHistory(list);
      } catch {
        /* 历史损坏 → 空列表 */
      }
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* 配置落盘（不含 apiKey） */
  useEffect(() => {
    if (!ready) return;
    const payload = {};
    for (const key of PERSISTED_CONFIG_KEYS) payload[key] = config[key];
    AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(payload)).catch(() => {});
  }, [config, ready]);

  /* App 失焦 → 清空图片引用（SPEC §4.1.2） */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') return;
      imagesRef.current = {};
      abortRef.current?.abort?.();
      dispatch({ type: 'RESET_RUN' });
    });
    return () => sub.remove();
  }, []);

  /* ── 历史 ─────────────────────────────────────────────── */
  const pushHistory = useCallback(async (record) => {
    try {
      const next = await appendHistory(record, AsyncStorage);
      setHistory(next);
      const last = next[next.length - 1];
      lastRecordIdRef.current = last ? last.id : null;
    } catch {
      /* 历史写失败不影响主流程 */
    }
  }, []);

  const saveDeepSummary = useCallback(
    async (report) => {
      const id = lastRecordIdRef.current;
      if (!id || !report) return;
      try {
        const current = (await loadHistory(AsyncStorage)).find((item) => item.id === id);
        if (!current) return;
        const updated = {
          ...current,
          deepSummary: {
            pick: report.conclusion?.pick || '',
            oneLineReasons: (report.ranking || []).map((row) => row.oneLineReason).filter(Boolean),
          },
        };
        await removeHistory(id, AsyncStorage);
        const next = await appendHistory(updated, AsyncStorage);
        setHistory(next);
        lastRecordIdRef.current = next[next.length - 1]?.id || null;
      } catch {
        /* 深度摘要写失败不影响报告展示 */
      }
    },
    [],
  );

  /* ── System One ───────────────────────────────────────── */
  const startQuick = useCallback(async () => {
    const current = flowRef.current;
    const check = validateInput({
      artifacts: current.artifacts,
      state: current.userState,
      question: current.question,
    });
    if (!check.canRunQuick) return;

    setTab('result');
    setExpandedLookId(null);
    setProgress({ stage: 'describing', done: 0, total: current.artifacts.length });
    dispatch({ type: 'RUN_QUICK_START' });

    const controller = new AbortController();
    abortRef.current = controller;
    const descriptions = {};
    let stage = 'describing';
    const meta = buildRequestMeta('quick', current, configRef.current);
    const startedAt = Date.now();

    try {
      setLastRequest(meta);

      const result = await orchestrator.runQuick({
        artifacts: current.artifacts,
        userState: current.userState,
        question: current.question,
        signal: controller.signal,
        onProgress: (event) => {
          if (!event) return;
          if (event.stage === 'describing' && event.lookId && event.text) descriptions[event.lookId] = event.text;
          if (event.stage === 'scoring' && stage !== 'scoring') {
            stage = 'scoring';
            dispatch({ type: 'SET_DESCRIPTIONS', descriptions: { ...descriptions } });
          }
          if (event.weakNetwork) dispatch({ type: 'SET_WEAK', flag: true });
          setProgress({ stage: event.stage, done: event.done, total: event.total });
        },
      });

      dispatch({ type: 'QUICK_DONE', ranked: result.ranked, usage: result.usage, model: result.model });
      if (result.weakNetwork) dispatch({ type: 'SET_WEAK', flag: true });
      setRanSignature({
        state: stateSummary(current.userState),
        question: current.question?.text || '',
      });

      await pushHistory(
        makeHistoryRecord({
          stateSummary: stateSummary(current.userState),
          question: current.question?.text || '',
          looks: (result.ranked || []).map((look) => ({
            lookId: look.lookId,
            description: result.descriptions?.[look.lookId] || descriptions[look.lookId] || '',
            scores: look.scores,
            rank: look.rank,
          })),
        }),
      );
    } catch (err) {
      const info = classifyError(err);
      if (info.kind === 'cancelled') {
        dispatch({ type: 'CLEAR_ERROR' });
        return;
      }
      setErrors((prev) => [...prev.slice(-4), info.message]);
      dispatch({ type: 'QUICK_FAIL', error: info, lookId: null });
    } finally {
      setLastRequest((prev) => (prev ? { ...prev, elapsedMs: Date.now() - startedAt } : prev));
      abortRef.current = null;
      setProgress(null);
    }
  }, [orchestrator, pushHistory]);

  /* ── System Two ───────────────────────────────────────── */
  const startDeep = useCallback(
    async (lookId) => {
      const current = flowRef.current;
      const existing = selectDeepFor(current, lookId);
      if (existing) {
        setExpandedLookId((prev) => (prev === lookId ? null : lookId));
        return;
      }
      if (current.phase === 'deep_running') return;
      if (!current.artifacts.length) return;

      setExpandedLookId(lookId);
      setDeepBusyLook(lookId);
      setProgress({ stage: 'deep', done: 0, total: current.artifacts.length });
      dispatch({ type: 'RUN_DEEP_START' });

      const controller = new AbortController();
      abortRef.current = controller;
      const meta = buildRequestMeta('deep', current, configRef.current);
      const startedAt = Date.now();

      try {
        setLastRequest(meta);

        const report = await orchestrator.runDeep({
          artifacts: current.artifacts,
          userState: current.userState,
          question: current.question,
          signal: controller.signal,
          onProgress: (event) => {
            if (event?.weakNetwork) dispatch({ type: 'SET_WEAK', flag: true });
          },
        });

        const targets = (report.ranking || []).map((row) => row.lookId);
        const lookIds = targets.length ? targets : current.artifacts.map((item) => item.lookId);
        for (const id of lookIds) dispatch({ type: 'DEEP_DONE', report, lookId: id });
        await saveDeepSummary(report);
      } catch (err) {
        const info = classifyError(err);
        if (info.kind === 'cancelled') {
          dispatch({ type: 'CLEAR_ERROR' });
          setExpandedLookId(null);
          return;
        }
        setErrors((prev) => [...prev.slice(-4), info.message]);
        dispatch({ type: 'DEEP_FAIL', error: info, lookId });
      } finally {
        setLastRequest((prev) => (prev ? { ...prev, elapsedMs: Date.now() - startedAt } : prev));
        abortRef.current = null;
        setDeepBusyLook(null);
        setProgress(null);
      }
    },
    [orchestrator, saveDeepSummary],
  );

  /* ── 单套重试（SPEC §5.4） ─────────────────────────────── */
  const retryLook = useCallback(
    async (lookId) => {
      const current = flowRef.current;
      const artifact = current.artifacts.find((item) => item.lookId === lookId);
      if (!artifact) return;
      setDeepBusyLook(lookId);
      const controller = new AbortController();
      abortRef.current = controller;
      const descriptions = {};
      try {
        const result = await orchestrator.runQuick({
          artifacts: [artifact],
          userState: current.userState,
          question: current.question,
          signal: controller.signal,
          onProgress: (event) => {
            if (event?.lookId && event.text) descriptions[event.lookId] = event.text;
            if (event?.weakNetwork) dispatch({ type: 'SET_WEAK', flag: true });
          },
        });
        const fresh = (result.ranked || [])[0] || null;
        const merged = (current.quick?.ranked || []).map((look) =>
          look.lookId === lookId && fresh ? fresh : look,
        );
        dispatch({
          type: 'SET_DESCRIPTIONS',
          descriptions: { ...(current.descriptions || {}), ...descriptions },
        });
        dispatch({
          type: 'QUICK_DONE',
          ranked: rankLooks(merged),
          usage: current.quick?.usage || null,
          model: current.quick?.model || null,
        });
      } catch (err) {
        const info = classifyError(err);
        if (info.kind === 'cancelled') return;
        setErrors((prev) => [...prev.slice(-4), info.message]);
        dispatch({ type: 'QUICK_FAIL', error: info, lookId });
      } finally {
        abortRef.current = null;
        setDeepBusyLook(null);
      }
    },
    [orchestrator],
  );

  /* ── 取消（弱网一键切 System One） ─────────────────────── */
  const switchToQuick = useCallback(() => {
    if (flowRef.current.phase === 'deep_running') abortRef.current?.abort?.();
    setTab('result');
    dispatch({ type: 'CLEAR_ERROR' });
  }, []);

  const retryLast = useCallback(() => {
    const current = flowRef.current;
    dispatch({ type: 'CLEAR_ERROR' });
    if (!current.quick) startQuick();
    else if (expandedLookId) startDeep(expandedLookId);
    else startQuick();
  }, [expandedLookId, startDeep, startQuick]);

  /* ── 选图 / 删除 ──────────────────────────────────────── */
  const pickImages = useCallback(async () => {
    setPickBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: MAX_LOOKS,
        quality: 0.7,
        base64: true,
        exif: false,
      });
      if (result.canceled || !result.assets?.length) return;

      const artifacts = [];
      const assets = result.assets.slice(0, MAX_LOOKS);
      for (let index = 0; index < assets.length; index += 1) {
        const artifact = await toArtifact(assets[index], LOOK_IDS[index]);
        if (artifact) artifacts.push(artifact);
      }
      if (!artifacts.length) {
        dispatch({
          type: 'SET_ERROR',
          error: { kind: 'invalid_input', message: '照片读不出来，换几张再试试', action: '换图', retryable: false },
        });
        return;
      }

      imagesRef.current = Object.fromEntries(artifacts.map((item) => [item.lookId, item]));
      setExpandedLookId(null);
      dispatch({ type: 'SET_ARTIFACTS', artifacts });
    } catch {
      dispatch({
        type: 'SET_ERROR',
        error: { kind: 'invalid_input', message: '照片读不出来，换几张再试试', action: '换图', retryable: false },
      });
    } finally {
      setPickBusy(false);
    }
  }, []);

  const removeLook = useCallback(
    (index) => {
      const current = flowRef.current;
      const next = current.artifacts
        .filter((_, position) => position !== index)
        .map((artifact, position) => ({ ...artifact, lookId: LOOK_IDS[position] }));
      imagesRef.current = Object.fromEntries(next.map((item) => [item.lookId, item]));
      setExpandedLookId(null);
      dispatch({ type: 'SET_ARTIFACTS', artifacts: next });
    },
    [],
  );

  /* ── 设置 ─────────────────────────────────────────────── */
  const changeConfig = useCallback((patch) => setConfig((prev) => ({ ...prev, ...patch })), []);

  const saveKey = useCallback(async (key) => {
    const saved = await saveApiKey(key);
    setKeySecure(saved.secure);
    setConfig((prev) => ({ ...prev, apiKey: saved.key }));
  }, []);

  const testConnection = useCallback(async () => {
    setTesting(true);
    try {
      const result = await api.health({});
      setConn(result);
    } catch (err) {
      setConn({ ok: false, ms: 0, detail: classifyError(err).message });
    } finally {
      setTesting(false);
    }
  }, [api]);

  const deleteRecord = useCallback(async (id) => {
    try {
      setHistory(await removeHistory(id, AsyncStorage));
    } catch {
      /* 删除失败保持原样 */
    }
  }, []);

  const clearAllHistory = useCallback(async () => {
    try {
      await clearHistory(AsyncStorage);
      setHistory([]);
    } catch {
      /* 清空失败保持原样 */
    }
  }, []);

  /* ── 运行状态探针（SPEC §2.1，web 平台才挂） ───────────── */
  const probe = useMemo(() => {
    const ranked = selectRankedLooks(flow).map((look) => ({
      lookId: look.lookId,
      rank: look.rank,
      overall: look.overall,
      // SPEC §2.1：把 6 维分数一并暴露给冒烟脚本，使脚本仅凭 probe 即可复核
      // 「6 维且都是 1 位小数」，不必只依赖线上响应与 DOM（那里仍是权威证据，这里是交叉校验）。
      scores: look.scores || null,
    }));
    const deep = {};
    for (const [lookId, report] of Object.entries(flow.deep || {})) {
      deep[lookId] = report
        ? {
            pick: report.conclusion?.pick ?? null,
            ranking: (report.ranking || []).length,
            details: (report.details || []).length,
          }
        : null;
    }
    return {
      ready,
      tab,
      looks: (flow.artifacts || []).map((item) => item.lookId),
      quick: { ranked },
      deep,
      errors,
      lastRequest,
      // 图片只在 reducer 与 useRef 里，从来没有写进存储的代码路径
      privacy: { imageInStorage: false },
    };
  }, [flow, tab, ready, errors, lastRequest]);

  useEffect(() => {
    if (!IS_WEB || typeof window === 'undefined') return;
    window.__OD_PROBE__ = probe;
  }, [probe]);

  /* 测试缝：web 冒烟脚本可以塞入内存构造的 artifacts（仍然不落盘） */
  useEffect(() => {
    if (!IS_WEB || typeof window === 'undefined') return;
    window.__OD_SET_ARTIFACTS__ = (list) => {
      const artifacts = (Array.isArray(list) ? list : [])
        .filter((item) => item && item.base64)
        .slice(0, MAX_LOOKS)
        .map((item, index) => ({
          lookId: LOOK_IDS[index],
          mime: item.mime || 'image/jpeg',
          base64: item.base64,
          width: item.width || 0,
          height: item.height || 0,
        }));
      imagesRef.current = Object.fromEntries(artifacts.map((item) => [item.lookId, item]));
      dispatch({ type: 'SET_ARTIFACTS', artifacts });
      return artifacts.length;
    };
    return () => {
      delete window.__OD_SET_ARTIFACTS__;
    };
  }, []);

  const check = validateInput({
    artifacts: flow.artifacts,
    state: flow.userState,
    question: flow.question,
  });
  const running = flow.phase === 'describing' || flow.phase === 'scoring';
  const staleHint =
    !!ranSignature &&
    !!flow.quick &&
    `${ranSignature.state}|${ranSignature.question}` !==
      `${stateSummary(flow.userState)}|${flow.question?.text || ''}`;

  let screen = null;
  if (showHelp) {
    screen = <HelpScreen onBack={() => setShowHelp(false)} />;
  } else if (tab === 'capture') {
    screen = (
      <CaptureScreen
        flow={flow}
        dispatch={dispatch}
        onPickImages={pickImages}
        onRemoveLook={removeLook}
        onSubmit={startQuick}
        pickBusy={pickBusy}
        hints={check.hints}
        canRun={check.canRunQuick && !running}
        running={running}
      />
    );
  } else if (tab === 'result') {
    screen = (
      <ResultScreen
        flow={flow}
        dispatch={dispatch}
        artifacts={flow.artifacts}
        deepBusyLook={deepBusyLook}
        expandedLookId={expandedLookId}
        onDeep={startDeep}
        onRetryLook={retryLook}
        onGoCapture={() => setTab('capture')}
        onGoSettings={() => setTab('settings')}
        onSwitchToQuick={switchToQuick}
        onRetry={retryLast}
        progress={progress}
        staleHint={staleHint}
        onRerun={startQuick}
      />
    );
  } else if (tab === 'history') {
    screen = <HistoryScreen records={history} onDelete={deleteRecord} onClear={clearAllHistory} />;
  } else {
    screen = (
      <SettingsScreen
        config={config}
        onChange={changeConfig}
        onTestConnection={testConnection}
        conn={conn}
        testing={testing}
        keySecure={keySecure}
        onSaveKey={saveKey}
        onOpenHelp={() => setShowHelp(true)}
      />
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.root} edges={['top']}>
        <TabBar
          tab={tab}
          onChange={(next) => {
            setShowHelp(false);
            setTab(next);
          }}
        />
        <View style={styles.body}>{screen}</View>

        {IS_WEB ? (
          <Text testID="probe-json" style={styles.probe} pointerEvents="none">
            {JSON.stringify(probe)}
          </Text>
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  probe: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    opacity: 0,
    fontSize: 1,
    padding: 0,
    margin: 0,
    color: colors.bg,
  },
});
