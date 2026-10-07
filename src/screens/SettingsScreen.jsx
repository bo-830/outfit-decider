import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ENGINE_MODES } from '../engine/api.js';
import { providerMismatch, providerOptions, providerPreset } from '../core/provider.js';
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
    title: '本地模型直接打分',
    sub: '快、不花钱；实测判断力偏弱',
  },
  laya_review: {
    title: '本地打分 + 多模态纠正',
    sub: '先由决策模型打分，再让能看图的模型纠正',
  },
  multimodal_only: {
    title: '只用多模态模型',
    sub: '不经决策模型，直接让能看图的模型判断',
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
        <Text style={styles.fieldLabel}>{label}</Text>
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
 * 版面顺序把①放在②**之前**；并且**需要用视觉模型的档位**（默认档与 multimodal_only）
 * 在①没配好时把②整组锁住（v1.6）：架构是「本地模型打分 → 能看图的模型纠正」，
 * 没有视觉模型就没有纠正环节，用户拿到的只是实测判断力不合格的本地分
 * （得体 vs 荒谬的面试穿搭只差 0.4），所以先配视觉模型 = 先保证结论可用。
 * `laya_only` 例外：那一档不用视觉模型，锁住决策组会让纯本地模式不可用。
 *
 * **但禁用必须是"默认可绕开"的**：视觉端点本身坏掉（Key 错 / 服务不通 / 模型下线）时，
 * 用户还得能配一个可用的决策模型，否则 App 变砖头——那正是最需要配 fallback 的时候。
 * 所以提示块里给了显式临时解锁（`decisionUnlocked` + `decision-gate-unlock`）：解锁后
 * 决策组可编辑、可保存 Key，提示块换成弱说明并留「恢复按顺序配置」；视觉就绪后该标记自动失效。
 *
 * 放行开关（`visionServerSide`）：直连本机 Laya 适配器时视觉模型**已配在服务端**，
 * 不该逼用户把服务端的 Key 在手机上再填一遍；勾选即视为视觉已就绪，并随配置持久化。
 * 勾错的兜底写在复选框副文案里（结果页会出现「纠正未生效」），不额外加验证。
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
  /** 视觉区在滚动内容里的 y 偏移与 baseUrl 输入框引用：给「去配置」跳转用 */
  const scrollRef = useRef(null);
  const visionYRef = useRef(0);
  const visionBaseUrlRef = useRef(null);

  // SPEC §2.1 的锚点取自 onSaveVisionKey 等冻结接口；写入统一走这一个出口，
  // 兼容两个 prop 名（onChangeConfig 为 v1.5 约定名，onChange 为既有接线）。
  const applyConfig = typeof onChangeConfig === 'function' ? onChangeConfig : onChange;
  const patch = (next) => {
    if (typeof applyConfig === 'function') applyConfig(next);
  };

  const engineMode = config.engineMode || DEFAULT_ENGINE_MODE;
  /** 「视觉已就绪」= 自己填了 baseUrl + 模型名，或声明服务端已经配好（二选一即可） */
  const visionFilled = !!(String(config.visionBaseUrl || '').trim() && String(config.visionModel || '').trim());
  const visionServerSide = config.visionServerSide === true;
  const visionReady = visionFilled || visionServerSide;
  /**
   * 闸门只在**真的要用视觉模型**的档位生效：`laya_only` 既不纠正、describe 也走本地通道，
   * 那时锁住决策组等于让纯本地模式不可用——顺序要求不该以一整档不可用为代价。
   * 判据与 `src/engine/orchestrator.js` 的运行时分档一致：只有 `laya_only` 例外；
   * 未知档位在运行时按默认档（`laya_review`）处理，这里同样算"需要视觉"。
   */
  const needsVision = engineMode !== 'laya_only';
  const visionIdle = !needsVision;
  /**
   * 闸门本身该不该出现：需要视觉模型、但视觉还没就绪。
   * 默认按顺序配置（决策组不可编辑），但**显式临时解锁**（`decisionUnlocked`）可以放行——
   * 视觉端点出问题（Key 错 / 服务不通 / 模型下线）时用户必须还能配一个可用的决策模型，
   * 否则 App 就是砖头，而那恰恰是最需要配 fallback 的时候。
   * 视觉一旦就绪 `gateActive` 变 false，`decisionUnlocked` 自然失效（不写回、不残留 UI）。
   */
  const gateActive = needsVision && !visionReady;
  const decisionUnlocked = config.decisionUnlocked === true;
  const decisionLocked = gateActive && !decisionUnlocked;
  const showUnlockedNote = gateActive && decisionUnlocked;
  const readinessText = visionServerSide ? '服务端已配置' : visionFilled ? '已就绪' : '未配置';

  /** 「去配置」：滚到视觉区 + 聚焦 baseUrl（点一下就能开始填，不用自己找） */
  const jumpToVision = () => {
    const scroller = scrollRef.current;
    if (scroller && typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ y: Math.max(0, (visionYRef.current || 0) - space.sm), animated: true });
    }
    const input = visionBaseUrlRef.current;
    if (input && typeof input.focus === 'function') input.focus();
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        ref={scrollRef}
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

        {/* ── 二、能看图的模型（与决策模型分开的两条通道；必须在决策模型之前） ── */}
        <View
          style={styles.block}
          onLayout={(event) => {
            visionYRef.current = event?.nativeEvent?.layout?.y || 0;
          }}
        >
          <SectionLabel
            title="能看图的模型"
            dim={visionIdle}
            right={
              <View style={styles.headRight}>
                <Text style={styles.fieldMeta}>与决策模型分开</Text>
                <Text
                  testID="vision-readiness"
                  style={[styles.readiness, visionReady ? styles.readinessOk : styles.readinessIdle]}
                >
                  {readinessText}
                </Text>
              </View>
            }
          />
          <Text style={styles.groupSub}>
            本地模型看不了照片。这一组负责把照片变成描述、并在需要时纠正分数。
          </Text>

          <Pressable
            testID="vision-server-side"
            accessibilityRole="checkbox"
            accessibilityState={{ checked: visionServerSide }}
            aria-checked={visionServerSide}
            onPress={() => patch({ visionServerSide: !visionServerSide })}
            style={({ pressed }) => [styles.checkRow, pressed && styles.pressed]}
          >
            <View style={[styles.checkBox, visionServerSide && styles.checkBoxOn]}>
              {visionServerSide ? <Text style={styles.checkMark}>✓</Text> : null}
            </View>
            <View style={styles.checkText}>
              <Text style={styles.checkLabel}>
                能看图的模型已配在服务端（如本机 Laya 适配器），无需在此重复填写
              </Text>
              {/* 勾错不会有别的反馈：把"退化时你会看到什么信号"直接写给用户，
                  而不是再加一道验证（结果页的 reviewFailed 旁注就是那个信号）。 */}
              <Text style={styles.checkSub}>
                勾选后若服务端其实没配置，结果页会提示「纠正未生效」——那说明这个开关该取消。
              </Text>
            </View>
          </Pressable>

          {visionIdle ? (
            <Text testID="vision-idle-hint" style={styles.groupIdleTag}>
              当前档位用不到这一组
            </Text>
          ) : null}

          {needsVision && !visionReady ? (
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
            inputRef={visionBaseUrlRef}
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

        {/* ── 三、决策模型（谁算这 6 维分）── 需要视觉的档位未配好时先按顺序来 ── */}
        {decisionLocked ? (
          <View style={styles.block}>
            <View testID="decision-gate-hint" style={styles.warnBox}>
              <Text style={styles.warnText}>
                先配好能看图的模型，再配决策模型。没有它，纠正环节不会生效，你看到的只是本地模型的判断。
              </Text>
              <View style={styles.gateActions}>
                <Pressable
                  testID="decision-gate-jump"
                  accessibilityRole="button"
                  onPress={jumpToVision}
                  style={({ pressed }) => [styles.jumpBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.jumpText}>去配置</Text>
                </Pressable>
                {/* 逃生口：视觉端点坏掉时也不能把用户锁死在这里 */}
                <Pressable
                  testID="decision-gate-unlock"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: false }}
                  onPress={() => patch({ decisionUnlocked: true })}
                  style={({ pressed }) => [styles.unlockBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.unlockText}>仍然配置决策模型</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}

        {showUnlockedNote ? (
          <View style={styles.block}>
            <View testID="decision-gate-unlocked-note" style={styles.quietNote}>
              <Text style={styles.quietNoteText}>
                已解锁决策模型。没有能看图的模型时，你看到的只是本地模型的判断。
              </Text>
              <Pressable
                testID="decision-gate-relock"
                accessibilityRole="button"
                onPress={() => patch({ decisionUnlocked: false })}
                style={({ pressed }) => [styles.relockBtn, pressed && styles.pressed]}
              >
                <Text style={styles.relockText}>恢复按顺序配置</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={styles.block}>
          <SectionLabel
            title="决策模型来源"
            dim={decisionLocked}
            right={
              <View style={styles.headRight}>
                <Text style={styles.fieldMeta}>二选一</Text>
                {decisionLocked ? (
                  <Text testID="decision-lock-tag" style={styles.lockTag}>
                    未解锁
                  </Text>
                ) : null}
              </View>
            }
          />
          <Text style={styles.groupSub}>负责打分。它在纠正之前运行，所以视觉模型要先配好。</Text>
          <View style={styles.modeRow}>
            {providerOptions(config).map((item) => (
              <Pressable
                key={item.id}
                testID={`engine-mode-${item.id}`}
                accessibilityRole="button"
                accessibilityState={{ selected: item.active, disabled: decisionLocked }}
                onPress={() => patch(providerPreset(item.id))}
                disabled={decisionLocked}
                style={({ pressed }) => [
                  styles.mode,
                  item.active && styles.modeOn,
                  decisionLocked && styles.modeLocked,
                  decisionLocked && item.active && styles.modeLockedOn,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[
                    styles.modeLabel,
                    !decisionLocked && item.active && styles.modeLabelOn,
                    decisionLocked && item.active && styles.modeLabelLockedOn,
                  ]}
                >
                  {item.label}
                </Text>
                <Text
                  testID={`engine-mode-${item.id}-hint`}
                  style={[
                    styles.modeHint,
                    item.active && styles.modeHintOn,
                    decisionLocked && styles.modeHintLocked,
                  ]}
                >
                  {item.hint}
                </Text>
              </Pressable>
            ))}
          </View>
          {/* 两个控件曾经可以互相矛盾（选"本地"却把地址改成云端）。一旦不一致就明说。 */}
          {providerMismatch(config) ? (
            <Text testID="provider-mismatch" style={styles.warn}>
              {providerMismatch(config)}
            </Text>
          ) : null}
        </View>

        <View style={styles.block}>
          <SectionLabel title="决策模型地址" meta="本机 / 局域网都行" dim={decisionLocked} />
          <Field
            label="baseUrl"
            testID="engine-baseurl"
            locked={decisionLocked}
            value={config.baseUrl}
            onChangeText={(baseUrl) => patch({ baseUrl })}
            placeholder="http://127.0.0.1:8787"
            keyboardType="url"
          />
          <Field
            label="askPath"
            meta="打分请求路径"
            testID="engine-askpath"
            locked={decisionLocked}
            value={config.askPath}
            onChangeText={(askPath) => patch({ askPath })}
            placeholder="/ask"
          />
          <Field
            label="healthPath"
            meta="连接测试路径"
            testID="engine-healthpath"
            locked={decisionLocked}
            value={config.healthPath}
            onChangeText={(healthPath) => patch({ healthPath })}
            placeholder="/health"
          />
        </View>

        <View style={styles.block}>
          <SectionLabel title="决策模型名" meta="填服务端认的名字" dim={decisionLocked} />
          <Field
            label="model"
            testID="engine-model"
            locked={decisionLocked}
            value={config.model}
            onChangeText={(model) => patch({ model })}
            placeholder="outfit-judge-v1"
          />
        </View>

        <View style={styles.block}>
          <SectionLabel
            title="决策模型的 Key"
            meta={config.mode === 'laya' ? '本地模式不需要' : '只存这台设备'}
            dim={decisionLocked}
          />
          <Field
            label="API Key"
            testID="engine-apikey"
            locked={decisionLocked}
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
            accessibilityState={{ disabled: decisionLocked }}
            onPress={async () => {
              await onSaveKey(draftKey);
              setKeySaved(true);
            }}
            disabled={decisionLocked}
            style={({ pressed }) => [
              styles.secondary,
              decisionLocked && styles.secondaryLocked,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.secondaryText, decisionLocked && styles.secondaryTextLocked]}>
              {keySaved ? '已保存' : '保存 Key'}
            </Text>
          </Pressable>
          <Text style={styles.note}>
            {keySecure
              ? '已存进系统钥匙串（SecureStore），不会进代码、日志或历史。'
              : '当前设备只能用明文存储（AsyncStorage），请只在可信设备上填写。'}
          </Text>
        </View>

        <View style={styles.block}>
          <SectionLabel title="决策模型连接测试" meta="发一次 GET 请求" dim={decisionLocked} />
          <Pressable
            testID="btn-test-conn"
            accessibilityRole="button"
            accessibilityState={{ disabled: testing || decisionLocked }}
            onPress={onTestConnection}
            disabled={testing || decisionLocked}
            style={({ pressed }) => [
              styles.secondary,
              decisionLocked && styles.secondaryLocked,
              pressed && styles.pressed,
              testing && styles.disabled,
            ]}
          >
            <Text
              style={[styles.secondaryText, decisionLocked && styles.secondaryTextLocked]}
            >
              {testing ? '测试中…' : '测试连接'}
            </Text>
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
  /** 标题行右侧：说明 + 状态标记 / 锁标记，两者共用同一个基线 */
  headRight: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  /** 视觉区「已就绪 / 服务端已配置 / 未配置」状态标记（success 只用于「已就绪」与「服务端已配置」） */
  readiness: {
    fontFamily: SANS,
    fontSize: font.tiny + 0.5,
    fontWeight: '600',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  readinessOk: { color: colors.success, backgroundColor: colors.surfaceAlt },
  readinessIdle: { color: colors.textDim, backgroundColor: colors.surfaceAlt },
  lockTag: {
    fontFamily: SANS,
    fontSize: font.tiny + 0.5,
    fontWeight: '600',
    color: colors.warn,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  /** 服务端已配好视觉模型的放行开关：整行可点，44px 触达 */
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm + 2,
    minHeight: HIT,
    marginBottom: space.md,
    paddingVertical: space.sm,
  },
  checkBox: {
    width: 22,
    height: 22,
    marginTop: 1,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.textDim,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: { borderColor: colors.text, backgroundColor: colors.text },
  checkMark: { fontFamily: SANS, fontSize: font.small, fontWeight: '700', color: colors.surface, lineHeight: 16 },
  checkText: { flex: 1, minWidth: 0 },
  checkLabel: { fontFamily: SANS, fontSize: font.small, lineHeight: 20, color: colors.text },
  // 副文案说清"勾错了会看到什么信号"，而不是让用户去猜；textDim on bg = 5.39:1，过 AA
  checkSub: { fontFamily: SANS, fontSize: font.tiny + 0.5, lineHeight: 17, color: colors.textDim, marginTop: 3 },
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
  /** 提示块里的两个动作并排：主推「去配置」，逃生口「仍然配置决策模型」在同一行的右侧 */
  gateActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  /** 提示块里的一键跳转（「去配置」）：44px 触达，沿用 warn 色系描边 */
  jumpBtn: {
    alignSelf: 'flex-start',
    minHeight: HIT,
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warn,
    backgroundColor: colors.surface,
  },
  jumpText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.warn },
  /** 逃生口（「仍然配置决策模型」）：中性描边 + 墨色字，是可用动作但不是主推动作 */
  unlockBtn: {
    alignSelf: 'flex-start',
    minHeight: HIT,
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  unlockText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.text },
  /** 解锁后的弱说明：中性底 + textDim（4.94:1），明确不是警告语气 */
  quietNote: {
    marginBottom: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  quietNoteText: { fontFamily: SANS, fontSize: font.small, lineHeight: 20, color: colors.textDim },
  /** 重新上锁：比说明更弱的文字按钮，44px 触达 */
  relockBtn: {
    alignSelf: 'flex-start',
    minHeight: HIT,
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.textDim,
    backgroundColor: colors.surface,
  },
  relockText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.textDim },
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
  /** 锁定态：换成凹陷的 surfaceAlt 底（不是降透明度，文字仍 5.39:1 可读） */
  modeLocked: { backgroundColor: colors.surfaceAlt },
  modeLockedOn: { borderColor: colors.textDim, backgroundColor: colors.surfaceAlt },
  modeLabel: { fontFamily: SANS, fontSize: font.body, fontWeight: '600', color: colors.textDim },
  modeLabelOn: { color: colors.surface },
  modeLabelLockedOn: { color: colors.text },
  modeHint: { fontFamily: SANS, fontSize: font.tiny, color: colors.textDim, marginTop: 3 },
  modeHintOn: { color: colors.surfaceAlt },
  modeHintLocked: { color: colors.textDim },
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
  // 锁定态：凹陷的浅底 + 边框，一眼看出"现在不能改"；文字保持 textDim（surfaceAlt 上 ≈5.0:1，仍过 AA）
  inputLocked: { backgroundColor: colors.surfaceAlt, borderColor: colors.border, color: colors.textDim },
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
  secondaryLocked: { borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  secondaryTextLocked: { color: colors.textDim },
  pressed: { opacity: 0.75 },
  // 供应商与档位不一致时的提示（例如选了"本地"但地址指向云端）
  warn: {
    fontFamily: SANS,
    fontSize: font.small,
    lineHeight: 18,
    color: colors.warn,
    paddingHorizontal: layout.padX,
    marginTop: space.sm,
  },
  disabled: { opacity: 0.5 },
  note: { fontFamily: SANS, fontSize: font.tiny + 0.5, lineHeight: 17, color: colors.textDim, marginTop: space.sm },
  connBox: { marginTop: space.sm, minHeight: 44, justifyContent: 'center' },
  connText: { fontFamily: SANS, fontSize: font.small, lineHeight: 20 },
  connOk: { color: colors.success },
  connBad: { color: colors.danger },
  connIdle: { fontFamily: SANS, fontSize: font.small, color: colors.textDim },
  privacy: { fontFamily: SANS, fontSize: font.small, lineHeight: 21, color: colors.textDim, marginBottom: space.sm },
});
