/**
 * 机甲 v0 协议聚合出口：policy / ops / confirm / frames 四模块合并为一个
 * 平铺命名空间，由包入口 `export * as Mecha` 一次性导出。
 * 四模块导出名互不冲突（Schema/类型/常量均按域前缀命名），平铺安全。
 */
export * from './policy.js';
export * from './ops.js';
export * from './confirm.js';
export * from './frames.js';
