import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';

import {
  flowReducer,
  initialFlowState,
  normalizeSystemMode,
  selectDeepFor,
  selectRankedLooks,
} from './src/core/flow.js';
import { MAX_LOOKS, SCORE_QUESTION_IDS, appendArtifacts } from './src/core/protocol.js';
import { buildScoreQuestions } from './src/core/prompts.js';
import { rankLooks } from './src/core/scoring.js';
import { stateSummary, validateInput } from './src/core/state.js';
import { LOOK_IDS } from './src/data/options.js';
import { errorFor, invalidInputError } from './src/data/copy.js';
import { classifyError, DEFAULT_CONFIG, makeApi, normalizeBaseUrl } from './src/engine/api.js';
import { makeOrchestrator } from './src/engine/orchestrator.js';
import { appendHistory, clearHistory, loadHistory, makeHistoryRecord, removeHistory } from './src/store/history.js';
import { isSecureStorageAvailable, loadApiKey, loadVisionKey, saveApiKey, saveVisionKey } from './src/store/secureKey.js';
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
const PERSISTED_CONFIG_KEYS = [
  'mode', 'baseUrl', 'askPath', 'healthPath', 'model', 'timeoutMs', 'quickTimeoutMs',
  // v1.5 SPEC §3.9c：三档引擎模式与多模态端点也必须持久化，否则每次重启都退回默认档
  'engineMode', 'visionBaseUrl', 'visionModel', 'visionTimeoutMs',
  // v1.6：直连本机 Laya 适配器时，视觉模型已配在服务端，用户无需在手机上重复填写。
  // 这个开关只影响设置页的"可否配置决策模型"闸门，不改变运行时行为。
  'visionServerSide',
  // 用户显式绕过"视觉先行"闸门（视觉端点出问题时的自救路径）
  'decisionUnlocked',
];

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
  // v1.5：多模态端点的独立连通性状态
  const [visionConn, setVisionConn] = useState(null);
  const [testingVision, setTestingVision] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // DIAGNOSTIC (temporary): 上传页可见的选择流程 trace，只存计数与原因，定位后删除
  const [diagTrace, setDiagTrace] = useState('');
  /**
   * SPEC §3.13 v1.7 · 本次要跑哪个系统：'quick' | 'deep' | 'both'。
   *
   * 默认 'deep'（用户 2026-10-06 决定）：他要的是"看结论"，深度分析自带排序与理由，
   * 打开就能用；快速评分仍是一档之遥。这**取代**了最早"默认优先 System One"的口径——
   * 改的是默认值，不是契约：两档依然都可独立跑，quick 的语义与文案未动。
   * 存成 ref 是为了让回调不依赖闭包里的旧值（与 flowRef 同一套做法）。
   */
  const [systemMode, setSystemMode] = useState('deep');
  const systemModeRef = useRef('deep');
  /** 上一次跑分用的条件快照：条件改了旧分数仍显示，但提示可以重跑 */
  const [ranSignature, setRanSignature] = useState(null);

  const flowRef = useRef(flow);
  flowRef.current = flow;
  systemModeRef.current = systemMode;
  const configRef = useRef(config);
  configRef.current = config;
  /** 图片的唯一内存副本（SPEC §4.1.1）：绝不写盘、绝不进 AsyncStorage */
  const imagesRef = useRef({});
  const abortRef = useRef(null);
  /**
   * startDeep 的转发 ref（SPEC §3.13）：startQuick 定义在 startDeep 之前，
   * 但"两个都要"需要在 System One 跑完后调用 System Two。
   * 直接互相引用会踩闭包/声明顺序问题，所以用 ref 在每轮渲染后转发。
   */
  const startDeepRef = useRef(null);
  const lastRecordIdRef = useRef(null);

  const api = useMemo(() => makeApi({ config }), [config]);
  const orchestrator = useMemo(
    () =>
      makeOrchestrator({
        api,
        model: config.model,
        // SPEC §3.9c：三档模式在每次运行时都要生效，所以这里必须跟着 config 重建
        engineMode: config.engineMode,
        onWeakNet: () => dispatch({ type: 'SET_WEAK', flag: true }),
      }),
    [api, config.model, config.engineMode],
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
      // v1.5：多模态端点的 Key 与决策模型的 Key **分开存**（两者是不同供方，
      // 换掉其中一个不该影响另一个）。同样不进 CONFIG_KEY 那个 JSON 里。
      try {
        const vision = await loadVisionKey();
        if (vision.key && alive) setConfig((prev) => ({ ...prev, visionApiKey: vision.key }));
      } catch {
        /* 读不到就当没配 */
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

  /**
   * SPEC §5.5 · 打分前先确认决策端点真的能干活。
   *
   * 为什么值得多一次很轻的 GET：本机适配器在上游（Laya）挂掉时**照样返回 HTTP 200**，
   * 只是 body 里 upstream.ok=false。不先探一下的话，用户要等一整轮失败、再看一堆
   * network/server 文案，才知道真正的动作是"把 Laya 起起来"（实测就这么踩过）。
   *
   * 返回 null = 可以继续；返回错误对象 = 应当中止并提示。
   * 探测本身抛错也不阻断流程：那是"探测失败"，不是"打分一定失败"。
   */
  const guardDecisionEndpoint = useCallback(async () => {
    if (typeof api.diagnoseDecisionEndpoint !== 'function') return null;
    try {
      const d = await api.diagnoseDecisionEndpoint();
      if (d && d.ok === false) {
        const kind = d.kind === 'upstream' ? 'upstream_unreachable' : 'decision_endpoint_unreachable';
        return errorFor(kind);
      }
    } catch {
      /* 探测失败不阻断 */
    }
    return null;
  }, [api]);

  /** @param opts.thenDeep 跑完 System One 后接着跑 System Two（"两个都要"）。 */
  const startQuick = useCallback(async (opts = {}) => {
    const current = flowRef.current;
    const check = validateInput({
      artifacts: current.artifacts,
      state: current.userState,
      question: current.question,
    });
    if (!check.canRunQuick) return;

    const blocked = await guardDecisionEndpoint();
    if (blocked) {
      setErrors((prev) => [...prev.slice(-4), blocked.message]);
      dispatch({ type: 'SET_ERROR', error: blocked });
      return;
    }

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

      dispatch({
        type: 'QUICK_DONE',
        ranked: result.ranked,
        usage: result.usage,
        model: result.model,
        // SPEC §3.9c：把"结论来自哪一档"随结果一起存进 flow，供结果页如实标注
        engineMode: result.engineMode || null,
        reviewModel: result.reviewModel || null,
        reviewedAt: result.reviewedAt || null,
        reviewFailed: result.reviewFailed === true,
        reviewErrorKind: result.reviewErrorKind || null,
        reviewChanged: result.reviewChanged || null,
      });
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

      // "两个都要"：System One 成功后再接着跑 System Two。
      // 用 ref 调 startDeep，因为它定义在本回调之后（直接引用会踩 TDZ / 闭包顺序问题）。
      if (opts.thenDeep === true && typeof startDeepRef.current === 'function') {
        await startDeepRef.current(null);
      }
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
  }, [guardDecisionEndpoint, orchestrator, pushHistory]);

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

      // SPEC §5.5：深度分析同样先确认决策端点真能干活（它整轮都依赖多模态通道）
      const blocked = await guardDecisionEndpoint();
      if (blocked) {
        setErrors((prev) => [...prev.slice(-4), blocked.message]);
        dispatch({ type: 'SET_ERROR', error: blocked });
        return;
      }

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
    [guardDecisionEndpoint, orchestrator, saveDeepSummary],
  );
  // 每轮渲染后把最新的 startDeep 转发给 ref，供 startQuick 的"两个都要"调用
  startDeepRef.current = startDeep;

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
          // SPEC §3.9c：单套重试只换了这一套的分数，其余套的来源信息必须原样保留，
          // 否则重试一次就把结果页的"结论来源"标注抹掉了。
          engineMode: current.quick?.engineMode || result.engineMode || null,
          reviewModel: current.quick?.reviewModel || null,
          reviewedAt: current.quick?.reviewedAt || null,
          reviewFailed: current.quick?.reviewFailed === true,
          reviewErrorKind: current.quick?.reviewErrorKind || null,
          reviewChanged: current.quick?.reviewChanged || null,
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

  /**
   * SPEC §3.13 v1.7 · 让用户自己选跑哪个系统。
   *
   * 之前 CTA 写死只跑 System One，用户必须先拿快速分再点卡片才能做深度分析——
   * 但两者是**并列的两个引擎**，深度分析自带完整报告与排序，完全可以独立使用。
   * 所以这里按用户选择分派：quick / deep / both。
   *
   * 默认仍是 quick：需求原文要求"默认优先执行 System One 快速决策流程"，
   * 而且它最便宜（本地模型、约 1-2 秒路径）。想直接深度分析的用户自己切一档即可。
   */
  const runSelectedSystem = useCallback(
    async (mode) => {
      // 调用方可显式传档位；不带参时读当前选择（ref 保证不看闭包里的旧值）
      const choice = normalizeSystemMode(typeof mode === 'string' ? mode : systemModeRef.current);
      if (choice === 'deep') {
        setTab('result');
        // null = 对所有已选图片跑一次，报告分发到每套（不是"展开某一张卡片"）
        await startDeep(null);
        return;
      }
      await startQuick(choice === 'both' ? { thenDeep: true } : undefined);
    },
    [startDeep, startQuick],
  );

  /* ── 选图 / 删除 ──────────────────────────────────────── */
  const pickImages = useCallback(async () => {
    setPickBusy(true);
    // DIAGNOSTIC (temporary): 用户实测"加第二套会顶掉第一套"，而 state 恒为 1。
    // 只看 state 无法判断是哪一步 return 的，所以把每一步结果写进内存 trace
    // （**只记计数与原因，绝不记图片/Key**），直接显示在上传页。
    // 定位后连同 CaptureScreen 的 diag 行一起删除。
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: MAX_LOOKS,
        quality: 0.7,
        base64: true,
        exif: false,
      });
      if (result.canceled || !result.assets?.length) {
        setDiagTrace((t) => `${t} | cancel/empty(assets=${result.assets ? result.assets.length : 'n/a'})`);
        return;
      }

      // 关键：**追加**而不是替换。之前直接 dispatch SET_ARTIFACTS（替换全部），
      // 用户分两次各选 1 张时，第二次会把前一张冲掉 —— 看起来就像"只能上传一张"。
      // 追加规则抽成 appendArtifacts 纯函数（src/core/protocol.js），有直接单测。
      const existing = flowRef.current?.artifacts || [];
      setDiagTrace((t) => `${t} | pick:assets=${result.assets.length} existing=${existing.length}`);
      if (existing.length >= MAX_LOOKS) return; // 已满，界面会显示"已选满"

      const seeds = [];
      for (const asset of result.assets.slice(0, MAX_LOOKS - existing.length)) {
        const artifact = await toArtifact(asset, 'seed');
        if (artifact) seeds.push(artifact);
      }
      if (!seeds.length) {
        // 选图/读取失败：动作是「换图」，与 invalid_input 一致。
        // 文案必须来自 copy.js（AGENTS.md 代码约定），不得手写。
        setDiagTrace((t) => `${t} | seeds=0->ERR`);
        dispatch({ type: 'SET_ERROR', error: invalidInputError() });
        return;
      }
      const appended = appendArtifacts(existing, seeds, LOOK_IDS, MAX_LOOKS);
      if (!appended) {
        setDiagTrace((t) => `${t} | append=null`);
        return;
      }

      const next = appended.artifacts;
      setDiagTrace((t) => `${t} | seeds=${seeds.length} next=${next.length}(${next.map((a) => a.lookId).join(',')})`);
      imagesRef.current = Object.fromEntries(next.map((item) => [item.lookId, item]));
      setExpandedLookId(null);
      dispatch({ type: 'SET_ARTIFACTS', artifacts: next });
    } catch {
      setDiagTrace((t) => `${t} | throw`);
      dispatch({ type: 'SET_ERROR', error: invalidInputError() });
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

  // v1.5：多模态端点的 Key 独立保存（不同供方，换一个不该影响另一个）
  const saveVision = useCallback(async (key) => {
    const saved = await saveVisionKey(key);
    setConfig((prev) => ({ ...prev, visionApiKey: saved.key }));
  }, []);

  /** 多模态端点的连通性测试：走 visionBaseUrl 的最小真实请求。 */
  const testVision = useCallback(async () => {
    setTestingVision(true);
    try {
      const started = Date.now();
      await api.vision({
        system: '只回复 ok 两个字符。',
        content: 'ping',
        answerId: 'ping',
        temperature: 0,
      });
      setVisionConn({ ok: true, ms: Date.now() - started, detail: '已连通' });
    } catch (err) {
      const info = classifyError(err);
      setVisionConn({ ok: false, ms: 0, detail: info.message });
    } finally {
      setTestingVision(false);
    }
  }, [api]);

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
      quick: {
        ranked,
        // SPEC §3.9c：探针要能证明"本次结论来自哪一档、纠正是否生效"，
        // 否则门禁只能靠 DOM 文案推断。只放元信息，绝不放图片或 Key。
        engineMode: flow.quick?.engineMode || null,
        reviewModel: flow.quick?.reviewModel || null,
        reviewFailed: flow.quick?.reviewFailed === true,
        reviewErrorKind: flow.quick?.reviewErrorKind || null,
        reviewChanged: flow.quick?.reviewChanged || null,
      },
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
        // SPEC §3.13：由用户选择跑哪个系统，不再写死只跑 System One
        onSubmit={runSelectedSystem}
        systemMode={systemMode}
        onSelectSystem={setSystemMode}
        diagTrace={diagTrace}
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
        onSaveVisionKey={saveVision}
        onTestVision={testVision}
        visionConn={visionConn}
        testingVision={testingVision}
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
