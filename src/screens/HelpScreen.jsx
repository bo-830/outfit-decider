import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, HIT, layout, radius, space } from '../ui/theme';
import { MONO, SANS } from '../ui/platform';

const STEPS = [
  {
    title: '1 · 拿到模型服务地址',
    body: 'Laya 模式跑在你自己局域网里的机器上。记下那台机器的内网地址和端口，形如 192.168.1.5:8787。',
  },
  {
    title: '2 · 填进设置页',
    body: '回到「设置」→ 决策模型地址，baseUrl 填 http://192.168.1.5:8787，askPath 一般是 /ask，healthPath 一般是 /health。',
  },
  {
    title: '3 · 选 Laya 本地模式',
    body: '决策模型来源切到「Laya 本地」，这样请求不会带 API Key，也不会走公网。',
  },
  {
    title: '4 · 点一次连接测试',
    body: '设置页的「决策模型连接测试」会请求 healthPath。显示连接成功就说明这台手机和服务在同一张网里。',
  },
  {
    title: '5 · 连不上时按顺序排查',
    body: '手机和服务要在同一个 Wi-Fi；服务要监听 0.0.0.0 而不是 127.0.0.1；电脑防火墙要放行这个端口；换 http 而不是 https。',
  },
];

/** 引导页（设置页入口，非独立 Tab）：Laya 部署 + 连接测试 + 弱网说明。 */
export default function HelpScreen({ onBack }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.flex}>
      <View style={styles.bar}>
        <Pressable testID="help-back" accessibilityRole="button" onPress={onBack} style={styles.back} hitSlop={8}>
          <Text style={styles.backText}>‹ 设置</Text>
        </Pressable>
        <Text style={styles.barTitle}>引导</Text>
        <View style={styles.back} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, space.lg) + space.xl }]}>
        <Text style={styles.h1}>在自己机器上跑 Laya</Text>
        <Text style={styles.intro}>
          两种模式用的是同一套 JSON 契约：JEv 是别人给你托管的云端，Laya 是你自己在局域网里跑的那份。
          网络不好、或者不想把照片发出去时，用 Laya。
        </Text>

        {STEPS.map((step, index) => (
          <View key={step.title} style={styles.step}>
            <Text style={styles.stepNo}>{String(index + 1).padStart(2, '0')}</Text>
            <View style={styles.stepBody}>
              <Text style={styles.stepTitle}>{step.title.replace(/^\d+ · /, '')}</Text>
              <Text style={styles.stepText}>{step.body}</Text>
            </View>
          </View>
        ))}

        <View style={styles.block}>
          <Text style={styles.h2}>弱网下会怎样</Text>
          <Text style={styles.paragraph}>
            第一套照片转文字超过 6 秒，或者连续两次超时，结果页会出现一条黄色提示，建议你先看快速评分。
            深度分析要多看几张原图，本来就更慢，慢不代表坏了。
          </Text>
        </View>

        <View style={styles.block}>
          <Text style={styles.h2}>照片会去哪里</Text>
          <Text style={styles.paragraph}>
            照片只在这次分析里用：内存里读成 data URI 发给你的模型服务，跑完就释放。
            不写文件、不进历史、不上传第三方。历史里只有文字描述和分数。
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.padX,
    minHeight: HIT + 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  back: { minWidth: 64, minHeight: HIT, justifyContent: 'center' },
  backText: { fontFamily: SANS, fontSize: font.body, color: colors.accent, fontWeight: '600' },
  barTitle: { fontFamily: SANS, fontSize: font.body, fontWeight: '600', color: colors.text },
  content: { paddingHorizontal: layout.padX, paddingTop: space.lg },
  h1: { fontFamily: SANS, fontSize: font.h1 - 4, fontWeight: '600', color: colors.text, letterSpacing: -0.3 },
  intro: { fontFamily: SANS, fontSize: font.small, lineHeight: 21, color: colors.textDim, marginTop: space.sm },
  step: {
    flexDirection: 'row',
    gap: space.md,
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepNo: { fontFamily: MONO, fontSize: font.small, color: colors.accent, paddingTop: 1 },
  stepBody: { flex: 1, minWidth: 0 },
  stepTitle: { fontFamily: SANS, fontSize: font.body - 1, fontWeight: '600', color: colors.text },
  stepText: { fontFamily: SANS, fontSize: font.small, lineHeight: 20, color: colors.textDim, marginTop: space.xs + 2 },
  block: { marginTop: space.xl },
  h2: { fontFamily: SANS, fontSize: font.body, fontWeight: '600', color: colors.text },
  paragraph: { fontFamily: SANS, fontSize: font.small, lineHeight: 21, color: colors.textDim, marginTop: space.sm - 2 },
});
