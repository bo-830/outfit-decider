import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, HIT, layout, radius, space } from '../ui/theme';
import { SANS } from '../ui/platform';

/** 错误横幅（§5.1）：文案一律来自 copy.js，界面不自己拼错误文本。 */
export default function ErrorBanner({ error, onRetry, onDismiss, onGoSettings }) {
  if (!error) return null;
  const kind = error.kind || 'server';
  const message = error.message || '';
  if (!message) return null;

  // 按钮文案与 action 提示重复时只留按钮，别把同一句话印两遍
  const buttons = [];
  if (kind === 'auth' && onGoSettings) {
    buttons.push({ label: '去设置页', onPress: onGoSettings, testID: 'error-go-settings' });
  }
  if (error.retryable && onRetry) {
    buttons.push({ label: '重试', onPress: onRetry, testID: 'error-retry' });
  }
  const showAction = !!error.action && !buttons.some((button) => button.label === error.action);

  return (
    <View testID="banner-error" style={styles.banner}>
      <View style={styles.head}>
        <Text style={styles.title}>{message}</Text>
        <Pressable testID="error-dismiss" accessibilityRole="button" onPress={onDismiss} hitSlop={10}>
          <Text style={styles.dismiss}>×</Text>
        </Pressable>
      </View>
      {showAction ? <Text style={styles.action}>{error.action}</Text> : null}

      {buttons.length ? (
        <View style={styles.buttons}>
          {buttons.map((button) => (
            <Pressable
              key={button.label}
              testID={button.testID}
              accessibilityRole="button"
              onPress={button.onPress}
              style={styles.btn}
            >
              <Text style={styles.btnText}>{button.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: layout.padX,
    marginBottom: space.md,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  title: { flex: 1, fontFamily: SANS, fontSize: font.small + 1, lineHeight: 20, color: colors.danger, fontWeight: '600' },
  dismiss: { fontFamily: SANS, fontSize: 20, lineHeight: 22, color: colors.textDim },
  action: { fontFamily: SANS, fontSize: font.tiny + 1, color: colors.textDim, marginTop: space.xs + 2 },
  buttons: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  btn: {
    minHeight: HIT,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  btnText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.danger },
});
