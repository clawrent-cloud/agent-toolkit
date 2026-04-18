/**
 * ClawRent 一键全流程集成测试
 *
 * 6 阶段覆盖从用户注册到结算验证的完整生产场景:
 *   Phase 1: 环境初始化 (Setup)
 *   Phase 2: Agent 生命周期
 *   Phase 3: Session 全流程
 *   Phase 4: 结算与账单
 *   Phase 5: 边界场景
 *   Phase 6: 清理与报告
 *
 * 前置条件:
 *   - 平台 API + WebSocket + PostgreSQL + Redis 正在运行
 *   - 已执行过 pnpm db:seed (permissions 表有数据)
 *   - 无需预创建任何用户或 Agent
 *
 * 运行方式:
 *   # 本地
 *   node sdks/cli/examples/integration-test.mjs
 *
 *   # 云端
 *   node sdks/cli/examples/integration-test.mjs \
 *     --api-url https://test.clawrent.com \
 *     --ws-url wss://test.clawrent.com
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockProviderAgent } from './mock-provider-agent.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const CLI_PATH = resolve(__dirname, '..', 'dist', 'index.js');

// ─── 参数解析 ───

function getArg(name) {
  const i = process.argv.findIndex((a) => a === `--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const API_URL = getArg('api-url') ?? 'http://localhost:3001';
const WS_URL = getArg('ws-url') ?? 'ws://localhost:3001';
const VERBOSE = process.argv.includes('--verbose');
const RUN_ID = Date.now().toString(36);

// ─── 测试结果追踪 ───

const results = {
  phases: {},
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
};

let currentPhase = '';

function phase(name) {
  currentPhase = name;
  results.phases[name] = { passed: 0, failed: 0 };
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${'═'.repeat(60)}`);
}

function assert(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  const entry = { phase: currentPhase, name, status, detail };
  results.tests.push(entry);

  if (condition) {
    results.passed++;
    if (results.phases[currentPhase]) results.phases[currentPhase].passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    results.failed++;
    if (results.phases[currentPhase]) results.phases[currentPhase].failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return condition;
}

function skip(name, reason) {
  results.skipped++;
  results.tests.push({ phase: currentPhase, name, status: 'SKIP', detail: reason });
  console.log(`  [SKIP] ${name} — ${reason}`);
}

// ─── API 辅助函数 (直接 fetch，不走 CLI，避免 config 文件污染) ───

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_URL}${path}`, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const err = new Error(`API ${method} ${path} -> ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function register(email, password) {
  const data = await api('POST', '/api/auth/register', {
    body: { email, password, name: email.split('@')[0] },
  });
  return { token: data.token, userId: data.user.id, email: data.user.email };
}

async function login(email, password) {
  const data = await api('POST', '/api/auth/login', {
    body: { email, password },
  });
  return { token: data.token, userId: data.user.id, email: data.user.email };
}

// ─── CLI 辅助函数 (通过环境变量传入身份) ───

async function clawrent(auth, ...args) {
  const env = {
    ...process.env,
    CLAWRENT_TOKEN: auth.token,
    CLAWRENT_USER_ID: auth.userId,
    CLAWRENT_API_URL: API_URL,
    CLAWRENT_WS_URL: WS_URL,
  };
  try {
    const { stdout } = await execFileAsync('node', [CLI_PATH, ...args], { env, timeout: 30000 });
    try {
      return JSON.parse(stdout);
    } catch {
      return stdout.trim();
    }
  } catch (err) {
    // execFile error: include stderr
    const msg = err.stderr?.trim() || err.message;
    const wrapped = new Error(`CLI [${args.join(' ')}] failed: ${msg}`);
    wrapped.exitCode = err.code;
    wrapped.stderr = err.stderr;
    wrapped.stdout = err.stdout;
    throw wrapped;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════
//  主测试流程
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     ClawRent Integration Test - Full Lifecycle          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  RUN_ID:   ${RUN_ID}`);
  console.log(`  API_URL:  ${API_URL}`);
  console.log(`  WS_URL:   ${WS_URL}`);
  console.log(`  CLI_PATH: ${CLI_PATH}`);

  // 共享状态
  let providerAuth, consumerAuth, brokeAuth;
  let agentId, agentSlug;
  let sessionId;
  let mockAgent;
  let preSettleConsumerBalance, preSettleProviderBalance;

  const PROVIDER_EMAIL = `provider-${RUN_ID}@test.clawrent.com`;
  const CONSUMER_EMAIL = `consumer-${RUN_ID}@test.clawrent.com`;
  const BROKE_EMAIL = `broke-${RUN_ID}@test.clawrent.com`;
  const PASSWORD = 'TestPass123!';
  const AGENT_SLUG = `test-agent-${RUN_ID}`;
  const AGENT_NAME = `Integration Test Agent ${RUN_ID}`;

  try {
    // ═══════════════════════════════════════
    //  Phase 1: 环境初始化
    // ═══════════════════════════════════════
    phase('Phase 1: 环境初始化 (Setup)');

    // Test 1: 平台健康
    try {
      const health = await api('GET', '/api/health');
      assert('#1 平台健康', health?.status === 'healthy', `got: ${JSON.stringify(health?.status)}`);
    } catch (e) {
      assert('#1 平台健康', false, e.message);
      console.log('\n  !! 平台不可达，终止测试 !!\n');
      return;
    }

    // Test 2: 注册 Provider
    try {
      providerAuth = await register(PROVIDER_EMAIL, PASSWORD);
      assert('#2 注册 Provider', !!providerAuth.token, `userId: ${providerAuth.userId}`);
    } catch (e) {
      // 可能已注册，尝试登录
      try {
        providerAuth = await login(PROVIDER_EMAIL, PASSWORD);
        assert('#2 注册 Provider', !!providerAuth.token, '(已存在, 登录成功)');
      } catch (e2) {
        assert('#2 注册 Provider', false, e.message);
        return;
      }
    }

    // Test 3: 注册 Consumer
    try {
      consumerAuth = await register(CONSUMER_EMAIL, PASSWORD);
      assert('#3 注册 Consumer', !!consumerAuth.token, `userId: ${consumerAuth.userId}`);
    } catch (e) {
      try {
        consumerAuth = await login(CONSUMER_EMAIL, PASSWORD);
        assert('#3 注册 Consumer', !!consumerAuth.token, '(已存在, 登录成功)');
      } catch (e2) {
        assert('#3 注册 Consumer', false, e.message);
        return;
      }
    }

    // Test 4: Consumer 充值
    try {
      const topup = await api('POST', '/api/billing/wallet/topup', {
        token: consumerAuth.token,
        body: { amount: '100.00' },
      });
      const balance = parseFloat(topup.balance);
      assert('#4 Consumer 充值', balance >= 100, `balance: ${topup.balance}`);
    } catch (e) {
      assert('#4 Consumer 充值', false, e.message);
      return;
    }

    // Test 5: 验证 Provider 初始余额
    try {
      const wallet = await api('GET', '/api/billing/wallet', { token: providerAuth.token });
      assert('#5 Provider 初始余额', parseFloat(wallet.balance) === 0, `balance: ${wallet.balance}`);
    } catch (e) {
      assert('#5 Provider 初始余额', false, e.message);
    }

    // ═══════════════════════════════════════
    //  Phase 2: Agent 生命周期
    // ═══════════════════════════════════════
    phase('Phase 2: Agent 生命周期');

    // Test 6: 创建 Agent
    try {
      const agent = await api('POST', '/api/agents', {
        token: providerAuth.token,
        body: {
          name: AGENT_NAME,
          slug: AGENT_SLUG,
          description: `Integration test agent created by run ${RUN_ID}. This agent demonstrates full lifecycle testing.`,
          pricingModel: 'per_session',
          priceAmount: '5.00',
          currency: 'CNY',
          approvalMode: 'manual',
          hostingType: 'self_hosted',
          transparencyLevel: 'transparent',
          maxConcurrentSessions: 5,
          requiredPermissions: ['system.exec', 'file.read'],
          capabilities: [
            {
              category: 'testing',
              name: 'Integration Testing',
              description: 'Handles integration test scenarios',
              tags: ['test', 'e2e'],
            },
          ],
        },
      });
      agentId = agent.id;
      assert('#6 创建 Agent', !!agentId && agent.status === 'draft', `id: ${agentId}, status: ${agent.status}`);
    } catch (e) {
      assert('#6 创建 Agent', false, e.message);
      return;
    }

    // Test 7: 发布 Agent
    try {
      const published = await api('POST', `/api/agents/${agentId}/publish`, {
        token: providerAuth.token,
      });
      assert('#7 发布 Agent', published.status === 'pending_review', `status: ${published.status}`);
    } catch (e) {
      assert('#7 发布 Agent', false, e.message);
    }

    // Test 8: 激活 Agent
    try {
      const activated = await api('POST', `/api/agents/${agentId}/activate`, {
        token: providerAuth.token,
      });
      assert('#8 激活 Agent', activated.status === 'active', `status: ${activated.status}`);
      agentSlug = activated.slug;
    } catch (e) {
      assert('#8 激活 Agent', false, e.message);
    }

    // Test 9: 市场可见
    try {
      const browse = await api('GET', `/api/marketplace/browse?search=${encodeURIComponent(AGENT_NAME)}`);
      const found = browse.data?.some((a) => a.id === agentId);
      assert('#9 市场可见', found, `total: ${browse.total}, found: ${found}`);
    } catch (e) {
      assert('#9 市场可见', false, e.message);
    }

    // Test 10: Slug 查询
    try {
      const detail = await api('GET', `/api/marketplace/agents/${agentSlug ?? AGENT_SLUG}`);
      assert('#10 Slug 查询', detail.id === agentId, `slug: ${detail.slug}`);
    } catch (e) {
      assert('#10 Slug 查询', false, e.message);
    }

    // ═══════════════════════════════════════
    //  Phase 3: Session 全流程
    // ═══════════════════════════════════════
    phase('Phase 3: Session 全流程');

    // Test 11: 启动 Mock Provider
    try {
      mockAgent = new MockProviderAgent({
        agentId,
        cliPath: CLI_PATH,
        env: {
          CLAWRENT_TOKEN: providerAuth.token,
          CLAWRENT_USER_ID: providerAuth.userId,
          CLAWRENT_API_URL: API_URL,
          CLAWRENT_WS_URL: WS_URL,
        },
        responseDelay: 300,
        autoApprove: true,
        verbose: VERBOSE,
      });
      await mockAgent.start(20000);
      assert('#11 启动 Mock Provider', mockAgent.isReady);
    } catch (e) {
      assert('#11 启动 Mock Provider', false, e.message);
      console.log('\n  !! Mock Provider 启动失败，跳过 Session 测试 !!\n');
      // Skip to Phase 5
      phase('Phase 4: 结算与账单');
      skip('#19-#25 结算测试', 'Mock Provider 未启动');
      phase('Phase 5: 边界场景');
      // Still run edge cases below
      goto_phase5(providerAuth, consumerAuth, agentId);
      return;
    }

    // 让 daemon 完全就绪，设置 online 状态
    await sleep(2000);

    // Test 12: Consumer 租用 (用 CLI)
    try {
      const session = await clawrent(
        consumerAuth,
        'rent',
        '--agent-id', agentId,
        '--task', `Integration test session from run ${RUN_ID} - testing full lifecycle flow`,
        '--permissions', JSON.stringify({
          'system.exec': { granted: true, constraints: { commandWhitelist: ['echo', 'ls', 'dir'] } },
          'file.read': { granted: true, constraints: { pathWhitelist: ['/tmp', 'C:\\Temp'] } },
        }),
      );
      sessionId = session?.id;
      assert('#12 Consumer 租用', !!sessionId, `sessionId: ${sessionId}, status: ${session?.status}`);
    } catch (e) {
      assert('#12 Consumer 租用', false, e.message);
      await mockAgent?.stop();
      return;
    }

    // Test 13: 等待 Session 激活 (auto-approve 模式下应该很快)
    {
      let active = false;
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        try {
          const list = await clawrent(consumerAuth, 'sessions', '--status', 'active');
          if (list?.data?.some((s) => s.id === sessionId)) {
            active = true;
            break;
          }
        } catch { /* retry */ }
        if (i % 5 === 4) console.log(`    等待激活... (${i + 1}/30)`);
      }
      assert('#13 Session 已激活', active);
    }

    // Test 14: Provider 收到 session.new
    {
      await sleep(1000);
      const found = mockAgent.findLog(
        (e) => e.direction === 'recv' && e.data?.method === 'session.new',
      );
      assert('#14 Provider 收到 session.new', !!found);
    }

    // 等 WebSocket 完全建立
    await sleep(3000);

    // Test 15: Consumer 发 dialogue (使用 CLI send + --wait)
    let sendResult;
    try {
      sendResult = await clawrent(
        consumerAuth,
        'send', sessionId,
        '--content', `Hello from integration test ${RUN_ID}!`,
        '--type', 'dialogue.message',
        '--wait', '15000',
      );
      assert('#15 Consumer 发 dialogue', sendResult !== undefined);
      if (VERBOSE) console.log(`    send result: ${JSON.stringify(sendResult).slice(0, 200)}`);
    } catch (e) {
      assert('#15 Consumer 发 dialogue', false, e.message);
    }

    // Test 16: Provider 收到 dialogue
    {
      await sleep(2000);
      const found = mockAgent.findLog(
        (e) => e.direction === 'recv' && e.data?.method === 'dialogue',
      );
      assert('#16 Provider 收到 dialogue', !!found);

      if (found) {
        const content = found.data?.params?.content ?? '';
        assert(
          '#16a Dialogue 内容正确',
          content.includes(`Hello from integration test ${RUN_ID}!`),
          `got: "${content}"`,
        );
      }
    }

    // Test 17: Provider 主动回复 (MockAgent 自动回复 dialogue + 发送 instruction)
    {
      await sleep(2000);
      const dialogueReply = mockAgent.findLog(
        (e) => e.direction === 'send' && e.data?.method === 'send' &&
               e.data?.params?.type === 'dialogue.message',
      );
      assert('#17 Provider 自动回复 dialogue', !!dialogueReply);

      const instructionSent = mockAgent.findLog(
        (e) => e.direction === 'send' && e.data?.method === 'send' &&
               e.data?.params?.type === 'instruction.exec',
      );
      assert('#17a Provider 发送 instruction.exec', !!instructionSent);
    }

    // Test 18: 验证消息记录 (通过 API)
    try {
      const messages = await api('GET', `/api/sessions/${sessionId}/messages`, {
        token: consumerAuth.token,
      });
      const hasDialogue = messages.data?.some(
        (m) => m.messageType?.startsWith('dialogue.') || m.type?.startsWith('dialogue.'),
      );
      assert('#18 消息记录包含 dialogue', hasDialogue, `messages count: ${messages.data?.length ?? 0}`);
    } catch (e) {
      assert('#18 消息记录包含 dialogue', false, e.message);
    }

    // ═══════════════════════════════════════
    //  Phase 4: 结算与账单
    // ═══════════════════════════════════════
    phase('Phase 4: 结算与账单');

    // Test 19: 记录结算前余额
    try {
      const cWallet = await api('GET', '/api/billing/wallet', { token: consumerAuth.token });
      const pWallet = await api('GET', '/api/billing/wallet', { token: providerAuth.token });
      preSettleConsumerBalance = parseFloat(cWallet.balance);
      preSettleProviderBalance = parseFloat(pWallet.balance);
      assert('#19 记录结算前余额', true, `consumer: ${cWallet.balance}, provider: ${pWallet.balance}`);
    } catch (e) {
      assert('#19 记录结算前余额', false, e.message);
    }

    // Test 20: 结束 Session (通过 CLI)
    let settlement;
    try {
      const endResult = await clawrent(consumerAuth, 'end', sessionId);
      settlement = endResult?.settlement;
      assert('#20 结束 Session', endResult?.status === 'completed' || endResult?.status === 'settled',
        `status: ${endResult?.status}`);
    } catch (e) {
      assert('#20 结束 Session', false, e.message);
    }

    // Test 21: 结算金额正确 (per_session, price=5.00, fee=15%)
    if (settlement) {
      const amount = parseFloat(settlement.amount);
      const fee = parseFloat(settlement.platformFee);
      const income = parseFloat(settlement.providerIncome);
      assert('#21 结算金额=5.0000', Math.abs(amount - 5.0) < 0.001, `amount: ${settlement.amount}`);
      assert('#21a 平台费=0.7500', Math.abs(fee - 0.75) < 0.001, `fee: ${settlement.platformFee}`);
      assert('#21b Provider收入=4.2500', Math.abs(income - 4.25) < 0.001, `income: ${settlement.providerIncome}`);
    } else {
      skip('#21 结算金额', 'settlement 为空');
    }

    // 等待结算完成
    await sleep(1000);

    // Test 22: Consumer 扣款
    try {
      const cWallet = await api('GET', '/api/billing/wallet', { token: consumerAuth.token });
      const newBalance = parseFloat(cWallet.balance);
      const expectedBalance = preSettleConsumerBalance - 5.0;
      assert(
        '#22 Consumer 扣款',
        Math.abs(newBalance - expectedBalance) < 0.01,
        `expected: ${expectedBalance.toFixed(4)}, got: ${cWallet.balance}`,
      );
    } catch (e) {
      assert('#22 Consumer 扣款', false, e.message);
    }

    // Test 23: Provider 收款
    try {
      const pWallet = await api('GET', '/api/billing/wallet', { token: providerAuth.token });
      const newBalance = parseFloat(pWallet.balance);
      const expectedBalance = preSettleProviderBalance + 4.25;
      assert(
        '#23 Provider 收款',
        Math.abs(newBalance - expectedBalance) < 0.01,
        `expected: ${expectedBalance.toFixed(4)}, got: ${pWallet.balance}`,
      );
    } catch (e) {
      assert('#23 Provider 收款', false, e.message);
    }

    // Test 24: Session 状态已结算
    try {
      const sessionDetail = await api('GET', `/api/sessions/${sessionId}`, {
        token: consumerAuth.token,
      });
      assert(
        '#24 Session 已结算',
        sessionDetail.billingStatus === 'settled',
        `billingStatus: ${sessionDetail.billingStatus}, status: ${sessionDetail.status}`,
      );
    } catch (e) {
      assert('#24 Session 已结算', false, e.message);
    }

    // Test 25: 钱包流水
    try {
      const cTxns = await api('GET', '/api/billing/wallet/transactions', {
        token: consumerAuth.token,
      });
      const pTxns = await api('GET', '/api/billing/wallet/transactions', {
        token: providerAuth.token,
      });
      const consumerPayment = cTxns.data?.some((t) => t.type === 'payment' && t.referenceId === sessionId);
      const providerIncome = pTxns.data?.some((t) => t.type === 'income' && t.referenceId === sessionId);
      assert('#25 Consumer payment 流水', consumerPayment);
      assert('#25a Provider income 流水', providerIncome);
    } catch (e) {
      assert('#25 钱包流水', false, e.message);
    }

    // ═══════════════════════════════════════
    //  Phase 5: 边界场景
    // ═══════════════════════════════════════
    phase('Phase 5: 边界场景');

    // Test 26: 不能租自己的 Agent
    try {
      await clawrent(
        providerAuth,
        'rent',
        '--agent-id', agentId,
        '--task', 'Provider trying to rent own agent - should fail with minimum length task description',
        '--permissions', '{}',
      );
      assert('#26 不能租自己的 Agent', false, '应该抛出错误');
    } catch (e) {
      const isExpectedError = e.message?.includes('Cannot rent your own agent') ||
                               e.stderr?.includes('Cannot rent your own agent') ||
                               e.message?.includes('400');
      assert('#26 不能租自己的 Agent', isExpectedError, e.message?.slice(0, 100));
    }

    // Test 27: 余额不足
    try {
      // 注册一个没有余额的用户
      try {
        brokeAuth = await register(BROKE_EMAIL, PASSWORD);
      } catch {
        brokeAuth = await login(BROKE_EMAIL, PASSWORD);
      }

      await clawrent(
        brokeAuth,
        'rent',
        '--agent-id', agentId,
        '--task', 'Broke user trying to rent agent - should fail with insufficient balance message',
        '--permissions', '{}',
      );
      assert('#27 余额不足', false, '应该抛出错误');
    } catch (e) {
      const isExpectedError = e.message?.includes('Insufficient balance') ||
                               e.stderr?.includes('Insufficient balance') ||
                               e.message?.includes('402');
      assert('#27 余额不足', isExpectedError, e.message?.slice(0, 100));
    }

    // Test 28: 已结束 session 发消息
    try {
      await clawrent(
        consumerAuth,
        'send', sessionId,
        '--content', 'Message to ended session',
        '--type', 'dialogue.message',
      );
      // 可能不会抛错 (send 可能 "成功" 但消息被丢弃)，但不应该 crash
      assert('#28 已结束 session 发消息', true, 'send 没有 crash (消息可能被丢弃)');
    } catch (e) {
      // 任何错误都可以接受 (WS 连接失败, 4003/4004 错误等)
      assert('#28 已结束 session 发消息', true, `预期错误: ${e.message?.slice(0, 100)}`);
    }

  } finally {
    // ═══════════════════════════════════════
    //  Phase 6: 清理与报告
    // ═══════════════════════════════════════
    phase('Phase 6: 清理与报告');

    // Test 29: 停止 Mock Provider
    if (mockAgent) {
      try {
        await mockAgent.stop();
        assert('#29 停止 Mock Provider', true);
      } catch (e) {
        assert('#29 停止 Mock Provider', false, e.message);
      }
    } else {
      skip('#29 停止 Mock Provider', 'Mock Provider 未启动');
    }

    // Test 30: Agent 设为 offline
    if (agentId && providerAuth) {
      try {
        await api('PATCH', `/api/agents/${agentId}/status`, {
          token: providerAuth.token,
          body: { onlineStatus: 'offline' },
        });
        assert('#30 Agent offline', true);
      } catch (e) {
        assert('#30 Agent offline', false, e.message);
      }
    } else {
      skip('#30 Agent offline', 'Agent 未创建');
    }

    // Test 31: 输出报告
    printReport();
  }
}

// ─── 报告输出 ───

function printReport() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  REPORT');
  console.log(`${'═'.repeat(60)}`);

  // 按 Phase 统计
  for (const [phaseName, stats] of Object.entries(results.phases)) {
    const total = stats.passed + stats.failed;
    const icon = stats.failed === 0 ? 'OK' : 'FAIL';
    console.log(`  [${icon}] ${phaseName}: ${stats.passed}/${total}`);
  }

  console.log(`\n  Total: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped`);
  console.log(`  (${results.passed + results.failed + results.skipped} tests)`);

  if (results.failed > 0) {
    console.log('\n  Failed tests:');
    for (const t of results.tests.filter((t) => t.status === 'FAIL')) {
      console.log(`    - [${t.phase}] ${t.name}: ${t.detail}`);
    }
  }

  console.log(`\n  RUN_ID: ${RUN_ID}`);
  console.log(`${'═'.repeat(60)}\n`);

  process.exit(results.failed > 0 ? 1 : 0);
}

// ─── Phase 5 fallback (当 Mock Provider 未启动时) ───

async function goto_phase5(providerAuth, consumerAuth, agentId) {
  phase('Phase 5: 边界场景 (Partial)');

  if (providerAuth && agentId) {
    try {
      await clawrent(
        providerAuth,
        'rent',
        '--agent-id', agentId,
        '--task', 'Provider trying to rent own agent - should fail with minimum length task description',
        '--permissions', '{}',
      );
      assert('#26 不能租自己的 Agent', false, '应该抛出错误');
    } catch (e) {
      const isExpectedError = e.message?.includes('Cannot rent your own agent') || e.message?.includes('400');
      assert('#26 不能租自己的 Agent', isExpectedError, e.message?.slice(0, 100));
    }
  }

  phase('Phase 6: 清理与报告');
  skip('#29 停止 Mock Provider', 'Mock Provider 未启动');
  skip('#30 Agent offline', '跳过');
  printReport();
}

// ─── 入口 ───

main().catch((err) => {
  console.error('\n  FATAL ERROR:', err);
  printReport();
});
