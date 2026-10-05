import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { MAX_LOOKS, toDataUri } from '../core/protocol.js';
import { alpha, colors, font, HIT, layout, radius, shadow, space } from '../ui/theme';
import { SANS } from '../ui/platform';

/** 已选穿搭照片：每张一个 look-item，可单独删除；未满 4 套时给一个虚线加图位。 */
export default function LookGrid({ artifacts, onPick, onRemove, busy = false }) {
  const list = (Array.isArray(artifacts) ? artifacts : []).slice(0, MAX_LOOKS);

  if (!list.length) {
    return (
      <View style={styles.padX}>
        <Pressable
          testID="pick-images"
          accessibilityRole="button"
          onPress={onPick}
          disabled={busy}
          style={({ pressed }) => [styles.empty, pressed && styles.pressed]}
        >
          <Text style={styles.emptyPlus}>＋</Text>
          <Text style={styles.emptyTitle}>{busy ? '正在读取照片…' : '选择穿搭照片'}</Text>
          <Text style={styles.emptyHint}>一次最多 4 套，可以多选</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.padX}>
      <View style={styles.grid}>
        {list.map((artifact, index) => (
          <View key={artifact.lookId} testID="look-item" style={styles.tile}>
            <Image
              source={{ uri: toDataUri(artifact) }}
              style={styles.image}
              resizeMode="cover"
              accessibilityLabel={`第 ${index + 1} 套穿搭`}
            />
            <Text style={styles.badge}>{index + 1}</Text>
            <Pressable
              testID={`remove-look-${index + 1}`}
              accessibilityRole="button"
              accessibilityLabel={`删除第 ${index + 1} 套`}
              onPress={() => onRemove(index)}
              hitSlop={6}
              style={styles.remove}
            >
              <Text style={styles.removeText}>×</Text>
            </Pressable>
          </View>
        ))}

        {list.length < MAX_LOOKS ? (
          <Pressable
            accessibilityRole="button"
            onPress={onPick}
            disabled={busy}
            style={({ pressed }) => [styles.tile, styles.addTile, pressed && styles.pressed]}
          >
            <Text style={styles.addPlus}>＋</Text>
            <Text style={styles.addText}>再加一套</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.foot}>
        <Text style={styles.footText}>
          {list.length >= MAX_LOOKS
            ? `已选满 ${MAX_LOOKS} 套（上限 ${MAX_LOOKS} 套）`
            : `还能再加 ${MAX_LOOKS - list.length} 套`}
        </Text>
        <Pressable
          testID="pick-images"
          accessibilityRole="button"
          onPress={onPick}
          disabled={busy}
          hitSlop={8}
          style={styles.pickBtn}
        >
          <Text style={styles.pickText}>{busy ? '读取中…' : '重新选择'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  padX: { paddingHorizontal: layout.padX },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  tile: {
    width: '48.5%',
    aspectRatio: 4 / 5,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.paper,
  },
  image: { width: '100%', height: '100%' },
  badge: {
    position: 'absolute',
    left: space.sm,
    bottom: space.sm,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.text,
    color: colors.surface,
    fontFamily: SANS,
    fontSize: font.tiny,
    lineHeight: 22,
    textAlign: 'center',
    overflow: 'hidden',
  },
  remove: {
    position: 'absolute',
    right: space.sm,
    top: space.sm,
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: { fontFamily: SANS, fontSize: 18, lineHeight: 20, color: colors.textDim },
  addTile: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    backgroundColor: 'transparent',
    borderStyle: 'dashed',
    borderColor: colors.textDim + alpha.outline,
    shadowOpacity: 0,
    elevation: 0,
  },
  addPlus: { fontFamily: SANS, fontSize: 26, color: colors.textDim, lineHeight: 30 },
  addText: { fontFamily: SANS, fontSize: font.small, color: colors.textDim },
  empty: {
    minHeight: 210,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.textDim + alpha.outline,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  emptyPlus: { fontFamily: SANS, fontSize: 32, lineHeight: 36, color: colors.accent },
  emptyTitle: { fontFamily: SANS, fontSize: font.h2 - 2, fontWeight: '600', color: colors.text },
  emptyHint: { fontFamily: SANS, fontSize: font.small, color: colors.textDim },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.md,
    minHeight: HIT,
  },
  footText: { fontFamily: SANS, fontSize: font.small, color: colors.textDim },
  pickBtn: { minHeight: HIT, justifyContent: 'center', paddingLeft: space.lg },
  pickText: { fontFamily: SANS, fontSize: font.small, fontWeight: '600', color: colors.accent },
  pressed: { opacity: 0.75 },
});
