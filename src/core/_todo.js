// 骨架期占位：所有未实现的契约函数经此抛错，便于集成前一眼看出缺口。
// 实现落地后，对应模块内不得再出现 notImplemented 调用（SPEC §7 会 grep 断言）。
export function notImplemented(what) {
  const err = new Error(`[outfit-decider] not implemented yet: ${what}`);
  err.kind = 'not_implemented';
  throw err;
}
