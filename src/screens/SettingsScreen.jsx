import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, HIT, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';
import SectionLabel from '../components/SectionLabel.jsx';

function Field({ label, meta, value, onChangeText, testID, placeholder, keyboardType, secure, multiline }) {
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {meta ? <Text style={styles.fieldMeta}>{meta}</Text> : null}
      </View>
      <TextInput
        testID={testID}
        style={[styles.input, multiline && styles.inputMulti]}
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
      />
    </View>
  );
}

/** Tab 4 · 设置：引擎模式、地址、模型、API Key、连接测试、隐私说明。 */
export default function SettingsScreen({
  config,
  onChange,
  onTestConnection,
  conn,
  testing = false,
  keySecure = false,
  onSaveKey,
  onOpenHelp,
}) {
  const insets = useSafeAreaInsets();
  const [draftKey, setDraftKey] = useState(config.apiKey || '');
  const [keySaved, setKeySaved] = useState(false);

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, space.lg) + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.head}>
          <Text style={styles.h1}>设置</Text>
          <Text style={styles.sub}>默认连本机的 Laya 决策模型；也可以换成 JEv 云端。</Text>
        </View>

        <View style={styles.block}>
          <SectionLabel title="引擎模式" meta="二选一" />
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
                  onPress={() => onChange({ mode: item.id })}
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
          <SectionLabel title="服务地址" meta="本机 / 局域网都行" />
          <Field
            label="baseUrl"
            testID="engine-baseurl"
            value={config.baseUrl}
            onChangeText={(baseUrl) => onChange({ baseUrl })}
            placeholder="http://127.0.0.1:8787"
            keyboardType="url"
          />
          <Field
            label="askPath"
            meta="打分请求路径"
            testID="engine-askpath"
            value={config.askPath}
            onChangeText={(askPath) => onChange({ askPath })}
            placeholder="/ask"
          />
          <Field
            label="healthPath"
            meta="连接测试路径"
            testID="engine-healthpath"
            value={config.healthPath}
            onChangeText={(healthPath) => onChange({ healthPath })}
            placeholder="/health"
          />
        </View>

        <View style={styles.block}>
          <SectionLabel title="模型" meta="填服务端认的名字" />
          <Field
            label="model"
            testID="engine-model"
            value={config.model}
            onChangeText={(model) => onChange({ model })}
            placeholder="outfit-judge-v1"
          />
        </View>

        <View style={styles.block}>
          <SectionLabel title="API Key" meta={config.mode === 'laya' ? '本地模式不需要' : '只存这台设备'} />
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
          <SectionLabel title="连接测试" meta="发一次 GET 请求" />
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
  modeOn: { borderColor: colors.text, backgroundColor: colors.surface },
  modeLabel: { fontFamily: SANS, fontSize: font.body, fontWeight: '600', color: colors.textDim },
  modeLabelOn: { color: colors.text },
  modeHint: { fontFamily: SANS, fontSize: font.tiny, color: colors.textDim, marginTop: 3 },
  modeHintOn: { color: colors.accent },
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
