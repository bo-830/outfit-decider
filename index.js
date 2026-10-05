import { registerRootComponent } from 'expo';

import App from './App';

// 入口：直接注册根组件。不做平台分支初始化 —— 本项目不使用 Skia / WASM，
// 依赖全部是纯 JS 或 Expo 官方模块，web 与原生走同一条路径。
registerRootComponent(App);
