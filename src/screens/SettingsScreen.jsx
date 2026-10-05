import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ENGINE_MODES } from '../engine/api.js';
import { colors, font, HIT, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';
import SectionLabel from '../components/SectionLabel.jsx';

/**
 * SPEC §3.9c 三档引擎模式：表单顺序与取值全部来自 engine/api.js 的 ENGINE_MODES，
 * 这里只补文案，不另写一份数组（避免两处取值漂移）。
 * 锚点 testID 按 SPEC §2.1 逐字：laya_only → engine-mode-laya-only（下划线转连字符）。
 */
const ENGINE_MODE_ROWS = {
  laya_only: {
    title: '只用 Laya 本地模型',
    sub: '不花钱、离线可用；判断力实测偏弱',
  },
  laya_review: {
    title: 'Laya + 多模态纠正',
    sub: '先用本地模型打分，再由能看图的模型纠正',
  },
  multimodal_only: {
    title: '只用多模态模型',
    sub: '跳过本地模型，直接由能看图的模型判断',
  },
};

const DEFAULT_ENGINE_MODE = 'laya_review';

/**
 * 锁定态必须是**真的不可操作**，而不是只把颜色调灰：
 *   - `accessibilityState={{ disabled: true }}` 是 SPEC 要求，RN 原生与 RN-web 都认；
 *   - `editable={false}` → web 渲染 `readonly`，原生同步 disabled；
 *   - web 的 `<input>` 还要真正的 `disabled` 属性：RN-web 的 TextInput 会把 `disabled`
 *     直接透传到 DOM（forwardPropsList 里有它），而 `aria-disabled` 只表达语义、不挡键盘。
 */
function lockProps(locked) {
  if (!locked) return null;
  return {
    editable: false,
    'aria-disabled': true,
    accessibilityState: { disabled: true },
    ...(Platform.OS === 'web' ? { disabled: true } : null),
  };
}

function Field({
  label,
  meta,
  value,
  onChangeText,
  testID,
  placeholder,
  keyboardType,
  secure,
  multiline,
  inputRef,
  locked = false,
}) {
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text style={[styles.fieldLabel, locked && styles.fieldLabelLocked]}>{label}</Text>
        {meta ? <Text style={styles.fieldMeta}>{meta}</Text> : null}
      </View>
      <TextInput
        testID={testID}
        ref={inputRef}
        style={[styles.input, multiline && styles.inputMulti, locked && styles.inputLocked]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
        secureTextEntry={!!secure}
        multiline={!!multiline}
        accessibilityLabel={label}
        {...lockProps(locked)}
      />
    </View>
  );
}

/**
 * Tab 4 · 设置。
 *
 * v1.5 起设置页有**两组互不相干的服务**，版面按这个事实分区，别让用户以为配一个就够：
 *   1. 引擎模式（§3.9c 三档）+「能看图的模型」——决定照片怎么变成判断；
 *   2. 决策模型来源 / 地址 / 模型名 / Key——决定 6 维分数由谁算。
 * 版面顺序把①放在②**之前**，并且①没配好时②整组不可操作（v1.6）：
 * 架构是「本地模型打分 → 能看图的模型纠正」，没有视觉模型就没有纠正环节，
 * 用户拿到的只是实测判断力不合格的本地分（得体 vs 荒谬的面试穿搭只差 0.4），
 * 所以先配视觉模型 = 先保证结论可用。
 *
 * 放行开关（`visionServerSide`）：直连本机 Laya 适配器时视觉模型**已配在服务端**，
 * 不该逼用户把服务端的 Key 在手机上再填一遍；勾选即视为视觉已就绪，并随配置持久化。
 */
export default function SettingsScreen({
  config,
  onChange,
  onChangeConfig,
  onTestConnection,
  conn,
  testing = false,
  keySecure = false,
  onSaveKey,
  onSaveVisionKey,
  onTestVision,
  visionConn = null,
  testingVision = false,
  onOpenHelp,
}) {
  const insets = useSafeAreaInsets();
  const [draftKey, setDraftKey] = useState(config.apiKey || '');
  const [keySaved, setKeySaved] = useState(false);
  const [draftVisionKey, setDraftVisionKey] = useState(config.visionApiKey || '');
  const [visionKeySaved, setVisionKeySaved] = useState(false);

  // SPEC §2.1 的锚点取自 onSaveVisionKey 等冻结接口；写入统一走这一个出口，
  // 兼容两个 prop 名（onChangeConfig 为 v1.5 约定名，onChange 为既有接线）。
  const applyConfig = typeof onChangeConfig === 'function' ? onChangeConfig : onChange;
  const patch = (next) => {
    if (typeof applyConfig === 'function') applyConfig(next);
  };

  const engineMode = config.engineMode || DEFAULT_ENGINE_MODE;
  const visionReady = !!(String(config.visionBaseUrl || '').trim() && String(config.visionModel || '').trim());
  const modeNeedsVision = engineMode === 'laya_review' || engineMode === 'multimodal_only';
  const visionIdle = engineMode === 'laya_only';

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, space.lg) + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.head}>
          <Text style={styles.h1}>设置</Text>
          <Text style={styles.sub}>默认用 Laya 本地模型打分，再由能看图的模型纠正。</Text>
        </View>

        {/* ── 一、引擎模式（SPEC §3.9c 三档） ────────────────────── */}
        <View style={styles.block}>
          <SectionLabel title="引擎模式" meta="三选一" />
          <View style={styles.modeList}>
            {ENGINE_MODES.map((id) => {
              const row = ENGINE_MODE_ROWS[id];
              if (!row) return null;
              const active = engineMode === id;
              return (
                <Pressable
                  key={id}
                  testID={`engine-mode-${String(id).replace(/_/g, '-')}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => patch({ engineMode: id })}
                  style={({ pressed }) => [styles.modeCard, active && styles.modeCardOn, pressed && styles.pressed]}
                >
                  <View style={styles.modeCardHead}>
                    <Text style={[styles.modeCardTitle, active && styles.modeCardTitleOn]}>{row.title}</Text>
                    {id === DEFAULT_ENGINE_MODE ? (
                      <Text style={[styles.modeTag, active && styles.modeTagOn]}>默认</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.modeCardSub, active && styles.modeCardSubOn]}>{row.sub}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ── 二、能看图的模型（与决策模型分开的两条通道） ─────────── */}
        <View style={styles.block}>
          <SectionLabel title="能看图的模型" meta="与决策模型分开" dim={visionIdle} />
          <Text style={styles.groupSub}>
            本地模型看不了照片。这一组负责把照片变成描述、并在需要时纠正分数。
          </Text>

          {visionIdle ? (
            <Text testID="vision-idle-hint" style={styles.groupIdleTag}>
              当前档位用不到这一组
            </Text>
          ) : null}

          {modeNeedsVision && !visionReady ? (
            <View testID="vision-missing-hint" style={styles.warnBox}>
              <Text style={styles.warnText}>
                这一档需要能看图的模型，还没配置时分数会退回本地模型的判断
              </Text>
            </View>
          ) : null}

          <Field
            label="baseUrl"
            meta="OpenAI 兼容端点"
            testID="engine-vision-baseurl"
            value={config.visionBaseUrl}
            onChangeText={(visionBaseUrl) => patch({ visionBaseUrl })}
            placeholder="https://api.deepseek.com/v1"
            keyboardType="url"
          />
          <Field
            label="模型名"
            meta="填服务端认的名字"
            testID="engine-vision-model"
            value={config.visionModel}
            onChangeText={(visionModel) => patch({ visionModel })}
            placeholder="deepseek-flash"
          />
          <Field
            label="API Key"
            meta="与决策模型的 Key 分开"
            testID="engine-vision-key"
            value={draftVisionKey}
            onChangeText={(text) => {
              setDraftVisionKey(text);
              setVisionKeySaved(false);
            }}
            placeholder="sk-…"
            secure
          />
          <Pressable
            testID="btn-save-vision-key"
            accessibilityRole="button"
            onPress={async () => {
              if (typeof onSaveVisionKey === 'function') await onSaveVisionKey(draftVisionKey);
              setVisionKeySaved(true);
            }}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>{visionKeySaved ? '已保存' : '保存 Key'}</Text>
          </Pressable>
          <Text style={styles.note}>
            {keySecure
              ? '已存进系统钥匙串（SecureStore），和决策模型的 Key 互不影响。'
              : '当前设备只能用明文存储（AsyncStorage），请只在可信设备上填写。'}
          </Text>

          <Pressable
            testID="btn-test-vision"
            accessibilityRole="button"
            onPress={onTestVision}
            disabled={testingVision}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed, testingVision && styles.disabled]}
          >
            <Text style={styles.secondaryText}>{testingVision ? '测试中…' : '测试这一组'}</Text>
          </Pressable>
          <View testID="test-vision-result" style={styles.connBox}>
            {visionConn ? (
              <Text style={[styles.connText, visionConn.ok ? styles.connOk : styles.connBad]}>
                {visionConn.ok
                  ? `${visionConn.detail} · 用时 ${visionConn.ms}ms`
                  : `连不上：${visionConn.detail}`}
              </Text>
            ) : (
              <Text style={styles.connIdle}>还没测过。点上面的按钮试一次。</Text>
            )}
          </View>
        </View>

        {/* ── 三、决策模型（谁算这 6 维分） ──────────────────────── */}
        <View style={styles.block}>
          <SectionLabel title="决策模型来源" meta="二选一" />
          <View style={styles.modeRow}>
            {[
              { id: 'jev', label: 'JEv 云端', hint: '带 API Key' },
              { id: 'laya', label: 'Laya 本地', hint: '局域网部署' },
            ].map((item) => {
              const active = config.mode === item.id;
              return (
                <Pressable
                  key={item.id}
                  testID={`engine-mode-${item.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => patch({ mode: item.id })}
                  style={({ pressed }) => [styles.mode, active && styles.modeOn, pressed && styles.pressed]}
                >
                  <Text style={[styles.modeLabel, active && styles.modeLabelOn]}>{item.label}</Text>
                  <Text style={[styles.modeHint, active && styles.modeHintOn]}>{item.hint}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.block}>
          <SectionLabel title="决策模型地址" meta="本机 / 局域网都行" />
          <Field
            label="baseUrl"
            testID="engine-baseurl"
            value={config.baseUrl}
            onChangeText={(baseUrl) => patch({ baseUrl })}
            placeholder="http://127.0.0.1:8787"
            keyboardType="url"
          />
          <Field
            label="askPath"
            meta="打分请求路径"
            testID="engine-askpath"
            value={config.askPath}
            onChangeText={(askPath) => patch({ askPath })}
            placeholder="/ask"
          />
          <Field
            label="healthPath"
            meta="连接测试路径"
            testID="engine-healthpath"
            value={config.healthPath}
            onChangeText={(healthPath) => patch({ healthPath })}
            placeholder="/health"
          />
        </View>

        <View style={styles.block}>
          <SectionLabel title="决策模型名" meta="填服务端认的名字" />
          <Field
            label="model"
            testID="engine-model"
            value={config.model}
            onChangeText={(model) => patch({ model })}
            placeholder="outfit-judge-v1"
          />
        </View>

        <View style={styles.block}>
          <SectionLabel title="决策模型的 Key" meta={config.mode === 'laya' ? '本地模式不需要' : '只存这台设备'} />
          <Field
            label="API Key"
            testID="engine-apikey"
            value={draftKey}
            onChangeText={(text) => {
              setDraftKey(text);
              setKeySaved(false);
            }}
            placeholder="sk-…"
            secure
          />
          <Pressable
            testID="btn-save-key"
            accessibilityRole="button"
            onPress={async () => {
              await onSaveKey(draftKey);
              setKeySaved(true);
            }}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>{keySaved ? '已保存' : '保存 Key'}</Text>
          </Pressable>
          <Text style={styles.note}>
            {keySecure
              ? '已存进系统钥匙串（SecureStore），不会进代码、日志或历史。'
              : '当前设备只能用明文存储（AsyncStorage），请只在可信设备上填写。'}
          </Text>
        </View>

        <View style={styles.block}>
          <SectionLabel title="决策模型连接测试" meta="发一次 GET 请求" />
          <Pressable
            testID="btn-test-conn"
            accessibilityRole="button"
            onPress={onTestConnection}
            disabled={testing}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed, testing && styles.disabled]}
          >
            <Text style={styles.secondaryText}>{testing ? '测试中…' : '测试连接'}</Text>
          </Pressable>
          <View testID="test-conn-result" style={styles.connBox}>
            {conn ? (
              <Text style={[styles.connText, conn.ok ? styles.connOk : styles.connBad]}>
                {conn.ok
                  ? `连接成功 · ${conn.detail} · 用时 ${conn.ms}ms`
                  : `连不上：${conn.detail}`}
              </Text>
            ) : (
              <Text style={styles.connIdle}>还没测过。点上面的按钮试一次。</Text>
            )}
          </View>
        </View>

        <View style={styles.block}>
          <SectionLabel title="隐私" />
          <Text style={styles.privacy}>
            照片只在本次分析中使用，不进历史、不落盘，关闭页面即释放。历史记录只保留文字描述与分数。
          </Text>
          <Text style={styles.privacy}>
            API Key 只存在这台设备上，不写进代码、日志或验证报告。
          </Text>
        </View>

        <View style={styles.block}>
          <Pressable
            testID="open-help"
            accessibilityRole="button"
            onPress={onOpenHelp}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>Laya 本地部署指引</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingTop: 0 },
  head: { paddingHorizontal: layout.padX, paddingTop: space.lg, paddingBottom: space.md },
  h1: { fontFamily: SANS, fontSize: font.h1, fontWeight: '600', color: colors.text, letterSpacing: -0.4 },
  sub: { fontFamily: SANS, fontSize: font.small, lineHeight: 20, color: colors.textDim, marginTop: space.sm - 2 },
  block: { marginTop: space.xl - 4, paddingHorizontal: layout.padX },
  groupSub: { fontFamily: SANS, fontSize: font.small, lineHeight: 20, color: colors.textDim, marginBottom: space.md },
  // 弱化不用 opacity：整组降到 55% 会把标签文字压到 ~2.25:1（低于 AA）。
  // 改用「未启用」标记 + 标题降为次级墨色，输入仍然可读、可预配置。
  groupIdleTag: {
    alignSelf: 'flex-start',
    marginBottom: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    color: colors.textDim,
    fontFamily: SANS,
    fontSize: font.tiny + 0.5,
    fontWeight: '600',
    overflow: 'hidden',
  },
  warnBox: {
    marginBottom: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warn,
    backgroundColor: colors.primarySoft,
  },
  warnText: { fontFamily: SANS, fontSize: font.small, lineHeight: 20, color: colors.warn },
  // 三档模式：整行可点、两行文案不缩字号；选中＝墨色实心（沿用 chip 的选中语言）
  modeList: { gap: space.sm },
  modeCard: {
    minHeight: HIT,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  modeCardOn: { borderColor: colors.text, backgroundColor: colors.text },
  modeCardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  modeCardTitle: { flex: 1, fontFamily: SANS, fontSize: font.body, fontWeight: '600', color: colors.text },
  modeCardTitleOn: { color: colors.surface },
  modeTag: {
    fontFamily: SANS,
    fontSize: font.tiny,
    fontWeight: '600',
    color: colors.accent,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  modeTagOn: { color: colors.text, backgroundColor: colors.surface },
  modeCardSub: { fontFamily: SANS, fontSize: font.small, lineHeight: 19, color: colors.textDim, marginTop: 3 },
  modeCardSubOn: { color: colors.surfaceAlt },
  modeRow: { flexDirection: 'row', gap: space.md },
  mode: {
    flex: 1,
    minHeight: 64,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  modeOn: { borderColor: colors.text, backgroundColor: colors.text },
  modeLabel: { fontFamily: SANS, fontSize: font.body, fontWeight: '600', color: colors.textDim },
  modeLabelOn: { color: colors.surface },
  modeHint: { fontFamily: SANS, fontSize: font.tiny, color: colors.textDim, marginTop: 3 },
  modeHintOn: { color: colors.surfaceAlt },
  field: { marginBottom: space.md },
  fieldHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: space.xs + 2 },
  fieldLabel: { fontFamily: SANS, fontSize: font.tiny + 1, color: colors.textDim },
  fieldMeta: { fontFamily: SANS, fontSize: font.tiny, color: colors.textDim },
  input: {
    minHeight: 48,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: SANS,
    fontSize: font.body - 1,
  },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
  secondary: {
    minHeight: HIT,
    marginTop: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.textDim,
    backgroundColor: colors.surface,
  },
  secondaryText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.text },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
  note: { fontFamily: SANS, fontSize: font.tiny + 0.5, lineHeight: 17, color: colors.textDim, marginTop: space.sm },
  connBox: { marginTop: space.sm, minHeight: 44, justifyContent: 'center' },
  connText: { fontFamily: SANS, fontSize: font.small, lineHeight: 20 },
  connOk: { color: colors.success },
  connBad: { color: colors.danger },
  connIdle: { fontFamily: SANS, fontSize: font.small, color: colors.textDim },
  privacy: { fontFamily: SANS, fontSize: font.small, lineHeight: 21, color: colors.textDim, marginBottom: space.sm },
});
