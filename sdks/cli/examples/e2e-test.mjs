/**
 * 端到端测试: Provider Agent + Consumer Agent 对跑
 *
 * 这个脚本自动完成以下流程:
 *   1. Provider 用户登录，启动 clawrent serve
 *   2. Consumer 用户登录，租用该 Agent
 *   3. Consumer 发送指令，Provider 自动回复
 *   4. 结束 session，验证全流程
 *
 * 前置条件:
 *   - 平台 API 和 WS 正在运行
 *   - 两个测试用户已注册 (Provider + Consumer)
 *
 * 运行方式:
 *   node examples/e2e-test.mjs \
 *     --agent-id <id> \
 *     --provider-email clitest@test.com --provider-password "Test1234!" \
 *     --consumer-email consumer@test.com --consumer-password "Test1234!"
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const CLI_PATH = resolve(__dirname, '..', 'dist', 'index.js');

// --- 解析参数 ---
function getArg(name) {
  const i = process.argv.findIndex(a => a === `--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const AGENT_ID = getArg('agent-id') ?? '';
const API_URL = getArg('api-url') ?? 'http://localhost:3001';
const WS_URL = getArg('ws-url') ?? 'ws://localhost:3001';
const PROVIDER_EMAIL = getArg('provider-email') ?? 'clitest@test.com';
const PROVIDER_PASSWORD = getArg('provider-password') ?? 'Test1234!';
const CONSUMER_EMAIL = getArg('consumer-email') ?? 'consumer@test.com';
const CONSUMER_PASSWORD = getArg('consumer-password') ?? 'Test1234!';

if (!AGENT_ID) {
  console.error('用法: node e2e-test.mjs --agent-id <id> [options]');
  console.error('  --provider-email <email>     Provider 邮箱 (默认: clitest@test.com)');
  console.error('  --provider-password <pass>   Provider 密码 (默认: Test1234!)');
  console.error('  --consumer-email <email>     Consumer 邮箱 (默认: consumer@test.com)');
  console.error('  --consumer-password <pass>   Consumer 密码 (默认: Test1234!)');
  console.error('  --api-url <url>              API 地址 (默认: http://localhost:3001)');
  process.exit(1);
}

// --- 辅助函数 ---

/** 通过 API 登录获取 token */
async function login(email, password) {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed for ${email}: ${res.status} ${text}`);
  }
  const data = await res.json();
  return { token: data.token, user: data.user };
}

/** 执行 CLI 命令 (使用指定 token 和 userId) */
async function clawrent(auth, ...args) {
  const env = {
    ...process.env,
    CLAWRENT_TOKEN: auth.token,
    CLAWRENT_USER_ID: auth.userId,
    CLAWRENT_API_URL: API_URL,
    CLAWRENT_WS_URL: WS_URL,
  };
  const { stdout } = await execFileAsync('node', [CLI_PATH, ...args], { env });
  try { return JSON.parse(stdout); } catch { return stdout.trim(); }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════
// 测试主流程
// ═══════════════════════════════════════════════

async function main() {
  const results = { passed: 0, failed: 0, tests: [] };

  function assert(name, condition, detail = '') {
    if (condition) {
      results.passed++;
      results.tests.push({ name, status: 'PASS' });
      console.log(`  [PASS] ${name}`);
    } else {
      results.failed++;
      results.tests.push({ name, status: 'FAIL', detail });
      console.log(`  [FAIL] ${name} ${detail ? `- ${detail}` : ''}`);
    }
  }

  console.log('=== ClawRent E2E Test ===\n');

  // --- Test 1: 平台健康检查 ---
  console.log('Test 1: 平台健康检查');
  try {
    const res = await fetch(`${API_URL}/api/health`);
    const health = await res.json();
    assert('平台可达', health?.status === 'healthy');
  } catch (e) {
    assert('平台可达', false, e.message);
    console.log('平台不可达，终止测试。');
    printResults(results);
    return;
  }

  // --- Test 2: 双方登录 ---
  console.log('\nTest 2: 双方登录');
  let providerAuth, consumerAuth;
  try {
    providerAuth = await login(PROVIDER_EMAIL, PROVIDER_PASSWORD);
    assert('Provider 登录', !!providerAuth.token, `user: ${providerAuth.user.email} (${providerAuth.user.id})`);
  } catch (e) {
    assert('Provider 登录', false, e.message);
    printResults(results);
    return;
  }

  try {
    consumerAuth = await login(CONSUMER_EMAIL, CONSUMER_PASSWORD);
    assert('Consumer 登录', !!consumerAuth.token, `user: ${consumerAuth.user.email} (${consumerAuth.user.id})`);
  } catch (e) {
    assert('Consumer 登录', false, e.message);
    printResults(results);
    return;
  }

  // Build auth objects for CLI calls
  const providerCli = { token: providerAuth.token, userId: providerAuth.user.id };
  const consumerCli = { token: consumerAuth.token, userId: consumerAuth.user.id };

  // --- Test 3: 启动 Provider Serve Daemon ---
  console.log('\nTest 3: 启动 Provider Serve Daemon');

  const daemonEnv = {
    ...process.env,
    CLAWRENT_TOKEN: providerCli.token,
    CLAWRENT_USER_ID: providerCli.userId,
    CLAWRENT_API_URL: API_URL,
    CLAWRENT_WS_URL: WS_URL,
  };

  const daemon = spawn('node', [CLI_PATH, 'serve', '--agent-id', AGENT_ID, '--auto-approve'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: daemonEnv,
  });

  const daemonMessages = [];
  let daemonReady = false;

  const rl = createInterface({ input: daemon.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      daemonMessages.push(msg);
      console.log(`  [Daemon ->] ${msg.method ?? 'response'} ${msg.params?.sessionId ?? ''}`);

      // 自动处理 instruction: echo 回去
      if (msg.method === 'instruction' && msg.id) {
        const response = {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: msg.params.sessionId,
            type: 'result.success',
            payload: {
              echo: true,
              received: msg.params.payload,
              processedAt: new Date().toISOString(),
            },
          },
        };
        daemon.stdin.write(JSON.stringify(response) + '\n');
        console.log(`  [-> Daemon] result for ${msg.id}`);
      }

      if (msg.method === 'ready') daemonReady = true;
    } catch { /* skip non-JSON lines */ }
  });

  // 等待 daemon 就绪 (最多 15s)
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (daemonReady) break;
  }

  assert('Serve daemon 就绪', daemonReady, 'daemon 未在 15s 内就绪');
  if (!daemonReady) {
    daemon.kill('SIGINT');
    printResults(results);
    return;
  }

  // --- Test 4: Consumer 租用 Agent ---
  console.log('\nTest 4: Consumer 租用 Agent');
  let sessionId;
  try {
    const session = await clawrent(consumerCli, 'rent', '--agent-id', AGENT_ID, '--task', 'E2E test task from consumer');
    // rent API returns session object directly (no data wrapper)
    sessionId = session?.id ?? session?.data?.id;
    assert('创建 Session', !!sessionId, `response keys: ${JSON.stringify(Object.keys(session ?? {}))}`);
    console.log(`  Session ID: ${sessionId}, Status: ${session?.status ?? session?.data?.status}`);
  } catch (e) {
    assert('创建 Session', false, e.stderr ?? e.message);
    daemon.kill('SIGINT');
    printResults(results);
    return;
  }

  // --- Test 5: 等待 session 被 auto-approve ---
  console.log('\nTest 5: 等待 Session 激活 (auto-approve)');
  let sessionActive = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const sessions = await clawrent(consumerCli, 'sessions', '--status', 'active');
      if (sessions?.data?.some(s => s.id === sessionId)) {
        sessionActive = true;
        break;
      }
    } catch { /* retry */ }
    if (i % 5 === 4) console.log(`  等待中... (${i + 1}/30)`);
  }
  assert('Session 已激活', sessionActive);

  // 检查 daemon 是否收到 session.new
  const sessionNewMsg = daemonMessages.find(m => m.method === 'session.new');
  assert('Provider 收到 session.new', !!sessionNewMsg);

  if (!sessionActive) {
    try { await clawrent(consumerCli, 'end', sessionId); } catch { /* best effort */ }
    daemon.kill('SIGINT');
    printResults(results);
    return;
  }

  // 等一下让 WebSocket 完全建立
  await sleep(3000);

  // --- Test 6: Consumer 发送消息 ---
  console.log('\nTest 6: Consumer 发送消息');
  try {
    const sendResult = await clawrent(
      consumerCli,
      'send', sessionId,
      '--content', 'Hello from E2E test!',
      '--type', 'dialogue.message',
      '--wait', '15000'
    );
    assert('发送消息成功', sendResult !== undefined);
    console.log(`  收到回复: ${JSON.stringify(sendResult).substring(0, 200)}`);
  } catch (e) {
    assert('发送消息成功', false, e.stderr ?? e.message);
  }

  // 验证 daemon 收到消息 (dialogue.* 消息作为 notification 转发)
  await sleep(2000);
  const dialogueMsg = daemonMessages.find(m => m.method === 'dialogue');
  assert('Provider 收到 dialogue', !!dialogueMsg);
  if (dialogueMsg) {
    assert('Dialogue 内容正确', dialogueMsg.params?.content === 'Hello from E2E test!');
  }

  // --- Test 7: 结束 Session ---
  console.log('\nTest 7: 结束 Session');
  try {
    await clawrent(consumerCli, 'end', sessionId);
    assert('Session 已结束', true);
  } catch (e) {
    assert('Session 已结束', false, e.message);
  }

  // --- Test 8: 停止 Daemon ---
  console.log('\nTest 8: 停止 Daemon');
  daemon.kill('SIGINT');
  await sleep(2000);
  assert('Daemon 已停止', daemon.killed || daemon.exitCode !== null);

  // 检查 daemon 收到 session.ended
  const sessionEndedMsg = daemonMessages.find(m =>
    m.method === 'session.ended' || m.method === 'session.disconnected'
  );
  assert('Provider 收到 session 结束通知', !!sessionEndedMsg);

  // --- 结果 ---
  printResults(results);
}

function printResults(results) {
  console.log('\n=== 测试结果 ===');
  console.log(`  通过: ${results.passed}`);
  console.log(`  失败: ${results.failed}`);
  console.log(`  总计: ${results.passed + results.failed}`);

  if (results.failed > 0) {
    console.log('\n失败项:');
    for (const t of results.tests.filter(t => t.status === 'FAIL')) {
      console.log(`  - ${t.name}: ${t.detail}`);
    }
  }

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('致命错误:', err);
  process.exit(1);
});
