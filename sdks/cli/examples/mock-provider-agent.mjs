/**
 * Mock Provider Agent - 模拟真实 Provider Agent 行为
 *
 * 独立的 Node.js 进程，通过 `clawrent serve` 接入平台，
 * 自动处理 session 审批、instruction 响应、dialogue 回复。
 *
 * 架构:
 *   integration-test.mjs
 *     └─ 导入 MockProviderAgent 类
 *          └─ start() → 启动 clawrent serve 子进程
 *               ├─ stdout ← JSON-RPC 通知/请求 (readline JSON Lines)
 *               └─ stdin  → JSON-RPC 响应/主动发送
 *
 * 独立运行:
 *   node mock-provider-agent.mjs --agent-id <id> [--auto-approve] [--verbose]
 *
 * 环境变量:
 *   CLAWRENT_TOKEN    - Provider JWT token
 *   CLAWRENT_USER_ID  - Provider user ID
 *   CLAWRENT_API_URL  - API 地址 (默认 http://localhost:3001)
 *   CLAWRENT_WS_URL   - WS 地址 (默认 ws://localhost:3001)
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * MockProviderAgent - 模拟 Provider Agent 的核心类
 *
 * Events:
 *   'ready'              - daemon 已就绪
 *   'session:new'        - 新 session 已建立 (params: { sessionId, taskDescription })
 *   'session:connected'  - WebSocket 已连接 (params: { sessionId })
 *   'session:ended'      - session 已结束 (params: { sessionId, reason })
 *   'instruction'        - 收到 instruction 请求 (params: { sessionId, type, payload })
 *   'dialogue'           - 收到 dialogue 消息 (params: { sessionId, content })
 *   'error'              - 错误 (params: Error)
 */
export class MockProviderAgent extends EventEmitter {
  /** @type {import('node:child_process').ChildProcess | null} */
  #daemon = null;
  /** @type {import('node:readline').Interface | null} */
  #rl = null;
  /** @type {Array<{time: number, direction: string, data: object}>} */
  #log = [];
  /** @type {boolean} */
  #ready = false;
  /** @type {Set<string>} */
  #activeSessions = new Set();

  /**
   * @param {object} options
   * @param {string} options.agentId       - Agent ID
   * @param {string} [options.cliPath]     - clawrent CLI dist/index.js 路径
   * @param {object} [options.env]         - 环境变量 (CLAWRENT_TOKEN, CLAWRENT_USER_ID, etc.)
   * @param {number} [options.responseDelay=500] - 模拟响应延迟 (ms)
   * @param {boolean} [options.autoApprove=true] - 是否自动审批 session
   * @param {boolean} [options.verbose=false]    - 详细日志
   */
  constructor({
    agentId,
    cliPath,
    env = {},
    responseDelay = 500,
    autoApprove = true,
    verbose = false,
  }) {
    super();
    this.agentId = agentId;
    this.cliPath = cliPath ?? resolve(__dirname, '..', 'dist', 'index.js');
    this.env = env;
    this.responseDelay = responseDelay;
    this.autoApprove = autoApprove;
    this.verbose = verbose;
  }

  /** 启动 serve daemon，返回 Promise (resolve on ready, reject on timeout) */
  async start(timeoutMs = 20000) {
    if (this.#daemon) throw new Error('MockProviderAgent already started');

    const args = ['serve', '--agent-id', this.agentId];
    if (this.autoApprove) args.push('--auto-approve');

    const daemonEnv = { ...process.env, ...this.env };

    this.#log = [];
    this.#ready = false;
    this.#activeSessions.clear();

    this.#daemon = spawn('node', [this.cliPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: daemonEnv,
    });

    // Capture stderr for debugging
    this.#daemon.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text && this.verbose) {
        console.log(`  [MockAgent stderr] ${text}`);
      }
    });

    this.#daemon.on('error', (err) => {
      this.emit('error', err);
    });

    this.#daemon.on('exit', (code) => {
      this.#logEntry('system', { event: 'daemon_exit', code });
      if (this.verbose) console.log(`  [MockAgent] daemon exited (code=${code})`);
      this.#daemon = null;
      this.#rl = null;
    });

    // Set up JSON Lines reader on stdout
    this.#rl = createInterface({ input: this.#daemon.stdout, crlfDelay: Infinity });
    this.#rl.on('line', (line) => this.#handleLine(line));

    // Wait for ready
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`MockProviderAgent not ready within ${timeoutMs}ms`));
      }, timeoutMs);

      this.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 优雅停止 daemon */
  async stop() {
    if (!this.#daemon) return;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#daemon) {
          this.#daemon.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      this.#daemon.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      this.#daemon.kill('SIGINT');
    });
  }

  /** 获取活动日志 (用于测试断言) */
  getLog() {
    return [...this.#log];
  }

  /** 查找日志中匹配条件的条目 */
  findLog(predicate) {
    return this.#log.find(predicate);
  }

  /** 查找日志中所有匹配条件的条目 */
  filterLog(predicate) {
    return this.#log.filter(predicate);
  }

  /** 是否就绪 */
  get isReady() {
    return this.#ready;
  }

  /** 活跃 session ID 集合 */
  get activeSessions() {
    return new Set(this.#activeSessions);
  }

  /** 主动向 session 发送消息 */
  sendToSession(sessionId, type, payload) {
    this.#writeToDaemon({
      jsonrpc: '2.0',
      method: 'send',
      id: `send_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      params: { sessionId, type, payload },
    });
  }

  // ─── 内部方法 ───

  #handleLine(line) {
    if (!line.trim()) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (this.verbose) console.log(`  [MockAgent] non-JSON: ${line}`);
      return;
    }

    this.#logEntry('recv', msg);

    if (this.verbose) {
      const method = msg.method ?? (msg.result ? 'response' : 'unknown');
      const sid = msg.params?.sessionId ?? '';
      console.log(`  [MockAgent <-] ${method} ${sid}`);
    }

    // Dispatch by method
    const method = msg.method;

    if (method === 'ready') {
      this.#ready = true;
      this.emit('ready', msg.params);
      return;
    }

    if (method === 'session.pending') {
      // 非 auto-approve 模式下自动审批
      this.#logEntry('action', { event: 'auto_approve', sessionId: msg.params?.sessionId });
      this.#writeToDaemon({
        jsonrpc: '2.0',
        method: 'approve',
        id: `approve_${Date.now().toString(36)}`,
        params: { sessionId: msg.params?.sessionId },
      });
      return;
    }

    if (method === 'session.new') {
      const sid = msg.params?.sessionId;
      this.#activeSessions.add(sid);
      this.emit('session:new', msg.params);
      return;
    }

    if (method === 'session.connected') {
      this.emit('session:connected', msg.params);
      return;
    }

    if (method === 'session.peer_connected') {
      this.emit('session:peer_connected', msg.params);
      return;
    }

    if (method === 'instruction' && msg.id) {
      this.#handleInstruction(msg);
      return;
    }

    if (method === 'dialogue') {
      this.#handleDialogue(msg);
      return;
    }

    if (method === 'session.ended' || method === 'session.disconnected') {
      const sid = msg.params?.sessionId;
      this.#activeSessions.delete(sid);
      this.emit('session:ended', msg.params);
      return;
    }

    if (method === 'session.error') {
      this.emit('error', new Error(`Session error: ${msg.params?.message}`));
      return;
    }

    if (method === 'shutdown') {
      this.emit('shutdown', msg.params);
      return;
    }
  }

  /** 处理 instruction 请求 — 模拟执行后返回 result */
  async #handleInstruction(msg) {
    const { id, params } = msg;
    const { sessionId, type, payload } = params;

    this.emit('instruction', { sessionId, type, payload, messageId: id });

    // 模拟处理延迟
    if (this.responseDelay > 0) {
      await new Promise((r) => setTimeout(r, this.responseDelay));
    }

    // 构造结果 — 根据 instruction 类型返回不同响应
    let resultPayload;
    if (type === 'instruction.exec') {
      resultPayload = {
        exitCode: 0,
        stdout: `mock output for: ${payload?.command ?? 'unknown'}`,
        stderr: '',
      };
    } else if (type === 'instruction.query') {
      resultPayload = {
        answer: `Mock answer for: ${JSON.stringify(payload)}`,
        confidence: 0.95,
      };
    } else {
      resultPayload = {
        echo: true,
        receivedType: type,
        receivedPayload: payload,
        processedAt: new Date().toISOString(),
      };
    }

    // 以 JSON-RPC Response 形式回复 (id 必须匹配)
    this.#writeToDaemon({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId,
        type: 'result.success',
        payload: resultPayload,
      },
    });
  }

  /** 处理 dialogue 消息 — 自动回复 + 可选主动发送 instruction */
  async #handleDialogue(msg) {
    const { sessionId, content, dialogueType } = msg.params ?? {};

    this.emit('dialogue', { sessionId, content, dialogueType });

    // 模拟处理延迟
    if (this.responseDelay > 0) {
      await new Promise((r) => setTimeout(r, this.responseDelay));
    }

    // 自动回复 dialogue
    this.sendToSession(sessionId, 'dialogue.message', {
      content: `[MockAgent] Received: "${content}"`,
      dialogueType: 'message',
    });

    // 对话后主动发送一个 instruction.exec 给消费者
    // (验证 Provider -> Consumer 的 instruction 流向)
    await new Promise((r) => setTimeout(r, 200));
    this.sendToSession(sessionId, 'instruction.exec', {
      command: 'echo mock-instruction-from-provider',
      description: 'Provider-initiated instruction after dialogue',
    });
  }

  #writeToDaemon(msg) {
    if (!this.#daemon?.stdin?.writable) return;
    this.#logEntry('send', msg);
    if (this.verbose) {
      const method = msg.method ?? (msg.result ? 'response' : 'unknown');
      console.log(`  [MockAgent ->] ${method}`);
    }
    this.#daemon.stdin.write(JSON.stringify(msg) + '\n');
  }

  #logEntry(direction, data) {
    this.#log.push({ time: Date.now(), direction, data });
  }
}

// ═══════════════════════════════════════════════
// 独立运行模式
// ═══════════════════════════════════════════════

const isMain = !process.argv[1] || process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--agent-id')) {
  const agentId = process.argv[process.argv.indexOf('--agent-id') + 1];
  const autoApprove = process.argv.includes('--auto-approve');
  const verbose = process.argv.includes('--verbose');

  if (!agentId) {
    console.error('Usage: node mock-provider-agent.mjs --agent-id <id> [--auto-approve] [--verbose]');
    process.exit(1);
  }

  const agent = new MockProviderAgent({
    agentId,
    autoApprove,
    verbose: true, // 独立运行时始终 verbose
  });

  agent.on('ready', (params) => {
    console.log(`\n[MockAgent] Ready! Agent: ${params?.agentName ?? agentId}`);
    console.log('[MockAgent] Waiting for sessions... (Ctrl+C to stop)\n');
  });

  agent.on('session:new', (params) => {
    console.log(`[MockAgent] Session started: ${params?.sessionId}`);
  });

  agent.on('dialogue', ({ sessionId, content }) => {
    console.log(`[MockAgent] Dialogue [${sessionId?.slice(0, 8)}]: ${content}`);
  });

  agent.on('instruction', ({ sessionId, type }) => {
    console.log(`[MockAgent] Instruction [${sessionId?.slice(0, 8)}]: ${type}`);
  });

  agent.on('session:ended', (params) => {
    console.log(`[MockAgent] Session ended: ${params?.sessionId} (${params?.reason})`);
  });

  agent.on('error', (err) => {
    console.error(`[MockAgent] Error: ${err.message}`);
  });

  process.on('SIGINT', async () => {
    console.log('\n[MockAgent] Shutting down...');
    await agent.stop();
    process.exit(0);
  });

  agent.start().catch((err) => {
    console.error(`[MockAgent] Failed to start: ${err.message}`);
    process.exit(1);
  });
}
