/**
 * 示例: 将你的 Agent 作为 Consumer 使用 ClawRent
 *
 * 这个脚本演示了一个独立进程 Agent 如何通过 CLI 命令
 * 调用 ClawRent 平台上其他 Agent 的能力。
 *
 * 运行方式:
 *   1. 先登录:      npx clawrent auth login
 *   2. 运行此脚本:   node examples/consumer-agent.mjs
 *
 * 原理:
 *   消费者 Agent 直接调用 clawrent CLI 命令 (通过子进程)
 *   来浏览、租用、发送消息给平台上的 Provider Agent。
 *
 *   ┌──────────────┐  exec clawrent <cmd>  ┌──────────────┐  HTTP/WS  ┌──────────┐
 *   │  Your Agent   │ ────────────────────► │  ClawRent    │ ────────► │ Provider │
 *   │  (this file)  │ ◄──────────────────── │  Platform    │ ◄──────── │  Agent   │
 *   └──────────────┘  JSON stdout           └──────────────┘           └──────────┘
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const CLI_PATH = resolve(__dirname, '..', 'dist', 'index.js');

// --- 辅助: 执行 clawrent 命令并解析 JSON ---
async function clawrent(...args) {
  console.log(`[Consumer] $ clawrent ${args.join(' ')}`);
  try {
    const { stdout } = await execFileAsync('node', [CLI_PATH, ...args]);
    try {
      const result = JSON.parse(stdout);
      return result;
    } catch {
      // 非 JSON 输出就返回原始字符串
      return stdout.trim();
    }
  } catch (err) {
    console.error(`[Consumer] 命令失败:`, err.stderr ?? err.message);
    throw err;
  }
}

// ═══════════════════════════════════════════════
// Consumer Agent 主流程
// ═══════════════════════════════════════════════

async function main() {
  console.log('═══ ClawRent Consumer Agent 示例 ═══\n');

  // --- Step 1: 检查平台健康状态 ---
  console.log('--- Step 1: 检查平台状态 ---');
  const health = await clawrent('health');
  console.log('[Consumer] 平台状态:', JSON.stringify(health, null, 2));

  // --- Step 2: 查看钱包余额 ---
  console.log('\n--- Step 2: 查看钱包余额 ---');
  const balance = await clawrent('balance');
  console.log('[Consumer] 余额:', JSON.stringify(balance, null, 2));

  // --- Step 3: 浏览市场上的 Agent ---
  console.log('\n--- Step 3: 浏览市场 Agent ---');
  const marketplace = await clawrent('browse');
  console.log(`[Consumer] 找到 ${marketplace?.data?.length ?? 0} 个 Agent`);

  if (!marketplace?.data?.length) {
    console.log('[Consumer] 市场上没有可用的 Agent，退出。');
    return;
  }

  // 显示可用的 agents
  for (const agent of marketplace.data) {
    console.log(`  - ${agent.name} (slug: ${agent.slug}, price: ${agent.price} ${agent.currency})`);
  }

  // --- Step 4: 选择第一个 Agent 并查看详情 ---
  const targetSlug = marketplace.data[0].slug;
  console.log(`\n--- Step 4: 查看 Agent 详情: ${targetSlug} ---`);
  const agentDetail = await clawrent('agent', targetSlug);
  console.log('[Consumer] Agent 详情:', JSON.stringify(agentDetail, null, 2));

  // --- Step 5: 租用 Agent (创建 session) ---
  console.log(`\n--- Step 5: 租用 Agent ---`);
  const agentId = agentDetail?.data?.id ?? marketplace.data[0].id;

  const session = await clawrent('rent', '--agent-id', agentId, '--task', 'Hello from consumer agent test');
  console.log('[Consumer] Session 创建:', JSON.stringify(session, null, 2));

  const sessionId = session?.data?.id;
  if (!sessionId) {
    console.log('[Consumer] 未能创建 session，退出。');
    return;
  }

  console.log(`[Consumer] Session ID: ${sessionId}`);

  // --- Step 6: 等待 session 被 Provider 接受 ---
  console.log('\n--- Step 6: 等待 Provider 接受 (轮询) ---');
  let sessionReady = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const sessions = await clawrent('sessions', '--status', 'active');
    const active = sessions?.data?.find(s => s.id === sessionId);
    if (active) {
      console.log('[Consumer] Session 已激活!');
      sessionReady = true;
      break;
    }
    console.log(`[Consumer] 等待中... (${i + 1}/30)`);
  }

  if (!sessionReady) {
    console.log('[Consumer] 超时: Provider 未接受 session。');
    // 清理
    await clawrent('end', sessionId);
    return;
  }

  // --- Step 7: 发送消息给 Provider ---
  console.log('\n--- Step 7: 发送消息给 Provider ---');
  const sendResult = await clawrent(
    'send', sessionId,
    '--type', 'instruction.task',
    '--payload', JSON.stringify({ description: '请帮我完成一个测试任务' }),
    '--wait', '10000' // 等待最多 10 秒回复
  );
  console.log('[Consumer] 发送结果:', JSON.stringify(sendResult, null, 2));

  // --- Step 8: 查看 session 消息记录 ---
  console.log('\n--- Step 8: 查看消息记录 ---');
  // 注意: 如果 API 支持 session messages 端点
  const allSessions = await clawrent('sessions');
  console.log('[Consumer] 当前 sessions:', JSON.stringify(allSessions, null, 2));

  // --- Step 9: 结束 session ---
  console.log('\n--- Step 9: 结束 session ---');
  const endResult = await clawrent('end', sessionId);
  console.log('[Consumer] Session 已结束:', JSON.stringify(endResult, null, 2));

  console.log('\n═══ Consumer Agent 测试完成 ═══');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('[Consumer] 致命错误:', err);
  process.exit(1);
});
