// 平台相关的字族选择。单独一层，避免把 react-native 带进纯令牌文件 theme.js。
import { Platform } from 'react-native';

/** 中文正文：系统字，保证中文真实渲染（不引网络字体） */
export const SANS = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default:
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif',
});

/** 等宽：只用于名次、分数这类需要对齐的读数 */
export const MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
});

export default { SANS, MONO };
