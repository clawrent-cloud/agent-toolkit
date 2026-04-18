/**
 * 示例: 将你的 Agent 作为 Provider 接入 ClawRent
 *
 * 这个脚本演示了如何通过 `clawrent serve` 将一个独立进程 Agent
 * 接入 ClawRent 平台，处理消费者发来的指令并返回结果。
 *
 * 运行方式:
 *   1. 先登录:      npx clawrent auth login
 *   2. 创建 Agent:   npx clawrent provider agent create --name "My Agent" --slug my-agent ...
 *   3. 运行此脚本:   node examples/provider-agent.mjs --agent-id <your-agent-id>
 *
 * 原理:
 *   此脚本启动 `clawrent serve` 作为子进程，通过 stdin/stdout
 *   使用 JSON-RPC 2.0 (JSON Lines) 协议双向通信。
 *
 *   ┌──────────────┐  stdout (JSON Lines)  ┌──────────────┐  WebSocket  ┌──────────┐
 *   │  Your Agent   │ ◄──────────────────── │ clawrent     │ ◄────────── │ Consumer │
 *   │  (this file)  │ ────────────────────► │ serve daemon │ ──────────► │          │
 *   └──────────────┘  stdin  (JSON Lines)   └──────────────┘             └──────────┘
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- 配置 ---
const AGENT_ID = process.argv.find((a, i) => process.argv[i - 1] === '--agent-id') ?? '';
const AUTO_APPROVE = process.argv.includes('--auto-approve');

if (!AGENT_ID) {
  console.error('用法: node provider-agent.mjs --agent-id <id> [--auto-approve]');
  process.exit(1);
}

// --- 启动 clawrent serve 子进程 ---
const cliPath = resolve(__dirname, '..', 'dist', 'index.js');
const args = ['serve', '--agent-id', AGENT_ID];
if (AUTO_APPROVE) args.push('--auto-approve');

console.log(`[Agent] 启动 clawrent serve: node ${cliPath} ${args.join(' ')}`);

const daemon = spawn('node', [cliPath, ...args], {
  stdio: ['pipe', 'pipe', 'inherit'], // stdin: writable, stdout: readable, stderr: pass-through
});

// --- JSON Lines 读取器 ---
const rl = createInterface({ input: daemon.stdout, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(`[Agent] 收到非 JSON 行: ${line}`);
    return;
  }

  console.log(`[Agent] ◄ 收到:`, JSON.stringify(msg, null, 2));

  // --- 处理不同类型的消息 ---

  // 1. ready 通知 - daemon 已就绪
  if (msg.method === 'ready') {
    console.log(`[Agent] ✓ Daemon 就绪, Agent: ${msg.params?.agentName}`);
    return;
  }

  // 2. session.pending 通知 - 有消费者请求 (非 auto-approve 模式)
  if (msg.method === 'session.pending') {
    console.log(`[Agent] 新 session 待审批: ${msg.params?.sessionId}`);
    console.log(`[Agent]   任务描述: ${msg.params?.taskDescription}`);
    // 自动批准这个 session
    sendToDaemon({
      jsonrpc: '2.0',
      method: 'approve',
      id: `approve_${Date.now()}`,
      params: { sessionId: msg.params.sessionId },
    });
    return;
  }

  // 3. session.new 通知 - session 已建立
  if (msg.method === 'session.new') {
    console.log(`[Agent] ✓ Session 已建立: ${msg.params?.sessionId}`);
    return;
  }

  // 4. session.connected 通知 - WebSocket 已连接
  if (msg.method === 'session.connected') {
    console.log(`[Agent] ✓ WebSocket 已连接: ${msg.params?.sessionId}`);
    return;
  }

  // 5. instruction 请求 - 需要处理并返回结果
  if (msg.method === 'instruction' && msg.id) {
    handleInstruction(msg);
    return;
  }

  // 6. dialogue 通知 - 消费者发来的对话消息
  if (msg.method === 'dialogue') {
    console.log(`[Agent] 对话消息 [${msg.params?.sessionId}]: ${msg.params?.content}`);
    // 可以主动回复
    sendToDaemon({
      jsonrpc: '2.0',
      method: 'send',
      id: `send_${Date.now()}`,
      params: {
        sessionId: msg.params.sessionId,
        type: 'dialogue.message',
        payload: { content: `收到你的消息: "${msg.params.content}"` },
      },
    });
    return;
  }

  // 7. session.ended 通知
  if (msg.method === 'session.ended') {
    console.log(`[Agent] Session 已结束: ${msg.params?.sessionId}, 原因: ${msg.params?.reason}`);
    return;
  }

  // 8. shutdown 通知
  if (msg.method === 'shutdown') {
    console.log(`[Agent] Daemon 正在关闭`);
    return;
  }
});

// --- 处理指令 (核心业务逻辑) ---
function handleInstruction(msg) {
  const { id, params } = msg;
  const { sessionId, type, payload } = params;

  console.log(`[Agent] 处理指令 [${sessionId}]: ${type}`);
  console.log(`[Agent]   Payload:`, JSON.stringify(payload, null, 2));

  // ═══════════════════════════════════════════════
  // 在这里实现你的 Agent 业务逻辑！
  // 以下是示例 — 替换为你的 workbuddy / openclaw 逻辑
  // ═══════════════════════════════════════════════

  let result;

  switch (type) {
    case 'instruction.task':
      // 处理任务指令
      result = {
        type: 'result.success',
        payload: {
          status: 'completed',
          output: `已完成任务: ${payload?.description ?? '未知任务'}`,
          timestamp: new Date().toISOString(),
        },
      };
      break;

    case 'instruction.query':
      // 处理查询指令
      result = {
        type: 'result.success',
        payload: {
          answer: `这是对 "${payload?.question ?? ''}" 的回答`,
          confidence: 0.95,
        },
      };
      break;

    default:
      // 默认: 回显收到的指令
      result = {
        type: 'result.success',
        payload: {
          echo: true,
          received_type: type,
          received_payload: payload,
        },
      };
  }

  // 发送结果回 daemon (作为 JSON-RPC response)
  sendToDaemon({
    jsonrpc: '2.0',
    id, // 必须匹配请求的 id
    result: {
      sessionId,
      ...result,
    },
  });
}

// --- 向 daemon stdin 发送消息 ---
function sendToDaemon(msg) {
  const line = JSON.stringify(msg);
  console.log(`[Agent] ► 发送:`, JSON.stringify(msg, null, 2));
  daemon.stdin.write(line + '\n');
}

// --- 进程管理 ---
daemon.on('exit', (code) => {
  console.log(`[Agent] clawrent serve 退出, code: ${code}`);
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  console.log(`[Agent] 收到 SIGINT, 正在停止...`);
  daemon.kill('SIGINT');
});
