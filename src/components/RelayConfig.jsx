import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, font, HIT, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';
import SectionLabel from './SectionLabel.jsx';

/**
 * 中转设置面板：用户只填「地址 + 一个口令」，不再分别配决策模型和多模态模型两把 Key。
 *
 * 上游两把 Key 保存在中转服务端，App 看不到，也不用在手机上填。
 *
 * 契约：
 *   props { config, onChange, onTest, testing, conn, locked, onSaveToken?, style? }
 *     - onChange(patchObject)：与既有 screen 的 patch 同口径（浅合并补丁对象）；
 *     - onTest({ token, baseUrl })：测试中转连通性。会把**尚未保存**的口令草稿一起传出去
 *       （否则用户刚输入口令就点"测试"，会拿一个空口令去测）；testing / conn 与设置页现有
 *       语义一致（conn = { ok, detail, ms }）；
 *     - locked：true 时整块不可操作（输入不可编辑、两个按钮禁用），
 *       与 SettingsScreen 的锁定语义一致（editable=false + accessibilityState.disabled，
 *       web 上还要真正的 disabled，否则键盘仍能改）；
 *     - onSaveToken 可选：给了就调它（口令应进 SecureStore，同设置页"保存 Key"的做法），
 *       没给则退回 onChange({ relayToken: draft })。配置键默认 relayToken。
 *   testID：relay-baseurl / relay-token / btn-save-relay-token / btn-test-relay / relay-test-result
 * 口令字段**不回显已存值**：value 只来自本地 draft（初始为空），避免把密钥印回屏幕上。
 */

/** 文案集中在文件顶部 */
const TITLE = '中转服务';
const META = '只填两项';
const INTRO = '填「地址 + 一个口令」就能用：地址填中转服务的根地址，口令用来证明是你本人。';
const TOKEN_NOTE = '口令只保存在这台设备上，不会写进代码、日志或验证报告。';
const UPSTREAM_NOTE =
  '上游的两把 Key 保存在中转服务端，App 看不到、也不经手；分析请求只带着上面的口令发到这个地址。';

/** 锁定态必须是"真的不可操作"（照搬 SettingsScreen 的做法，不 import screen） */
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
        style={[styles.input, locked && styles.inputLocked]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
        secureTextEntry={!!secure}
        accessibilityLabel={label}
        {...lockProps(locked)}
      />
    </View>
  );
}

export default function RelayConfig({
  config = {},
  onChange,
  onTest,
  testing = false,
  conn = null,
  locked = false,
  onSaveToken,
  style,
}) {
  /** 口令草稿：**不从 config 读初值**，所以已存口令不会被回显 */
  const [draftToken, setDraftToken] = useState('');
  const [saved, setSaved] = useState(false);

  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : '';
  const patch = (next) => {
    if (typeof onChange === 'function') onChange(next);
  };

  const saveToken = async () => {
    if (locked) return;
    if (typeof onSaveToken === 'function') await onSaveToken(draftToken);
    else if (typeof onChange === 'function') onChange({ relayToken: draftToken });
    else return;
    setSaved(true);
  };

  const testRelay = () => {
    if (locked || testing) return;
    if (typeof onTest === 'function') onTest({ token: draftToken, baseUrl });
  };

  const ms = conn && Number.isFinite(conn.ms) ? ` · 用时 ${conn.ms}ms` : '';
  const connText = conn
    ? conn.ok
      ? `连接成功${conn.detail ? ` · ${conn.detail}` : ''}${ms}`
      : `连不上：${conn.detail || '没有返回原因'}`
    : null;

  return (
    <View testID="relay-config" style={[styles.wrap, style]}>
      <SectionLabel title={TITLE} meta={locked ? '已锁定' : META} dim={locked} />
      <View style={styles.card}>
        <Text style={styles.intro}>{INTRO}</Text>

        <Field
          label="服务地址"
          meta="中转服务的根地址"
          testID="relay-baseurl"
          value={baseUrl}
          onChangeText={(next) => patch({ baseUrl: next })}
          placeholder="https://你的中转.example.com"
          keyboardType="url"
          locked={locked}
        />

        <Field
          label="API 口令"
          meta="不会回显已存口令"
          testID="relay-token"
          value={draftToken}
          onChangeText={(next) => {
            setDraftToken(next);
            setSaved(false);
          }}
          placeholder="中转服务给你的口令"
          secure
          locked={locked}
        />

        <Pressable
          testID="btn-save-relay-token"
          accessibilityRole="button"
          accessibilityState={{ disabled: locked }}
          disabled={locked}
          onPress={saveToken}
          style={({ pressed }) => [
            styles.secondary,
            locked && styles.secondaryLocked,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.secondaryText, locked && styles.secondaryTextLocked]}>
            {saved ? '已保存' : '保存口令'}
          </Text>
        </Pressable>
        <Text style={styles.note}>{TOKEN_NOTE}</Text>

        <Pressable
          testID="btn-test-relay"
          accessibilityRole="button"
          accessibilityState={{ disabled: locked || testing }}
          disabled={locked || testing}
          onPress={testRelay}
          style={({ pressed }) => [
            styles.secondary,
            locked && styles.secondaryLocked,
            testing && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.secondaryText, locked && styles.secondaryTextLocked]}>
            {testing ? '测试中…' : '测试中转'}
          </Text>
        </Pressable>
        <View testID="relay-test-result" style={styles.connBox}>
          {connText ? (
            <Text style={[styles.connText, conn.ok ? styles.connOk : styles.connBad]}>{connText}</Text>
          ) : (
            <Text style={styles.connIdle}>还没测过。点上面的按钮试一次。</Text>
          )}
        </View>

        <Text style={[styles.note, styles.noteLast]}>{UPSTREAM_NOTE}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: layout.padX, marginBottom: space.md },
  card: {
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  intro: {
    fontFamily: SANS,
    fontSize: font.small,
    lineHeight: 20,
    color: colors.textDim,
    marginBottom: space.md,
  },
  field: { marginBottom: space.md },
  fieldHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: space.xs + 2,
  },
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
  /** 锁定态：凹陷浅底 + 次级墨色字（surfaceAlt 上仍过 AA），一眼看出"现在不能改" */
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
  secondaryLocked: { borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  secondaryText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.text },
  secondaryTextLocked: { color: colors.textDim },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
  note: {
    fontFamily: SANS,
    fontSize: font.tiny + 0.5,
    lineHeight: 17,
    color: colors.textDim,
    marginTop: space.sm,
  },
  noteLast: { marginTop: space.md },
  connBox: { marginTop: space.sm, minHeight: 44, justifyContent: 'center' },
  connText: { fontFamily: SANS, fontSize: font.small, lineHeight: 20 },
  connOk: { color: colors.success },
  connBad: { color: colors.danger },
  connIdle: { fontFamily: SANS, fontSize: font.small, color: colors.textDim },
});
