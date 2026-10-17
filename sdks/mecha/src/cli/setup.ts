import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Mecha } from '@clawrent/protocol';
import { configPath } from '../constants.js';
import { realpathCanonical } from '../enforcement/path-guard.js';
import { runDeviceFlow } from './device-flow.js';

/**
 * setup 向导（plan Task 18）：把一台裸机接成在线机甲的唯一入口。步骤——
 *
 *  1. 设备登录：复用 T17 `runDeviceFlow`（fetch 注入，打印经 io.note；
 *     终端绝不处理密码——授权只在浏览器完成）；
 *  2. 目录白名单勾选：桌面/文档/下载快捷项（`homedir()` 拼接，**只列出
 *     实际存在的**）+ 自定义路径反复追加。诚实文案（白名单语义）在此步
 *     展示：白名单目录是你愿意被驾驶员读到、并可能被发送出去的范围；
 *  3. 程序预设档：'none'（纯文件整理，programs 留空）| 'dev'（python/
 *     node/git）；自定义条目 v0 不在终端做（提示去网页添加）；
 *  4. 探测真身（Ruling R4）：对每个预设名跨平台探测——win32 `where`、
 *     posix `which`（child_process execFile，经 execImpl 注入）——取
 *     **首个**匹配行为绝对路径，再按本仓规范形 realpath（win32 用
 *     realpathSync.native，见 path-guard.realpathCanonical）；解析不出
 *     的条目跳过并提示「未找到 <名>，已跳过（可稍后在网页添加）」。
 *     条目 name = 预设名，absPath = 真身；
 *  5. 组装 MechaPolicy：dirs（绝对、realpath 规范形、去重）+ programs +
 *     limits（MECHA_LIMITS_DEFAULTS 单一事实源）；
 *  6. 注册到平台：POST `<apiBase>/api/mecha/devices`，body
 *     `{ deviceId, policy }`，头 `Authorization: Bearer <deviceToken>`；
 *     非 2xx 抛错（消息携带 status + body）。
 *     **平台侧端点属 spec §7.7（另立 plan，本任务时点尚不存在）——上述
 *     为客户端单方契约**（与 T17 device-flow 文件头同一体例）；对齐平台
 *     plan 时若有出入，改 REGISTER_DEVICES_PATH 一处即可。
 *  7. 落盘 config.json（`<home>/config.json`，daemon T16 装载的同一形状）：
 *     `{ deviceId, deviceToken, apiBase, profile }`；apiBase 先剥尾斜杠
 *     （与 device flow 同一口径）；目录自建；POSIX 追加 chmod 0o600
 *     （尽力而为，失败提示不阻断），win32 跳过并提示；
 *  8. T19 席位：hooks.installRuntime / hooks.installAutostart（缺省不调，
 *     旗标 false；提供即 await，拒绝则响亮抛错——半装的 runtime 不是可
 *     交付状态）；成功则对应旗标 true；
 *  9. 完成摘要（io.note）：含本地刹车安全提示 `mecha halt`。
 *
 * 交互契约（io 注入；缺省 readline/console，结束自动 close）：
 *  - 快捷项勾选 = **一次** ask：逗号/空格分隔的编号（如 `1,3`），回车跳过；
 *    无效编号提示后整题重问；
 *  - 自定义路径 = **反复** ask 直到回车空行；相对路径 / 不存在的目录提示
 *    后留在循环里重问；
 *  - 两段都空（零目录）→ 提示「至少一个」并从快捷项整段重问；
 *  - 预设 = 一次 ask：`1|none`（回车默认）|`2|dev`，其余提示后重问。
 */

/** 交互注入面（测试收集断言；缺省 readline/console）。 */
export interface SetupIo {
  /** 提问并读取一行回答（已 trim 由实现方保证）。 */
  ask(prompt: string): Promise<string>;
  /** 输出提示/进度/摘要。 */
  note(s: string): void;
  /** 释放交互资源（缺省 io 的 readline 句柄；注入替身可不提供）。 */
  close?(): void;
}

/** fs 注入面（测试内存替身；缺省真实 fs）。realpathSync 必须返回**规范形**
 * （缺省 = path-guard.realpathCanonical：win32 native、posix realpath）。
 * statSync（I4）：程序真身的占位桩探测（0 字节 / WindowsApps 别名归宿）。 */
export interface SetupFs {
  existsSync(path: string): boolean;
  realpathSync(path: string): string;
  statSync(path: string): { size: number };
  mkdirSync(path: string, opts: { recursive: true }): unknown;
  writeFileSync(path: string, data: string): unknown;
  chmodSync(path: string, mode: number): unknown;
}

/** 子进程探测注入面（R4）。resolve = { stdout }；reject = 找不到/探测失败。 */
export type ExecImpl = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string }>;

/** T19 席位：runtime 自装与自启安装的挂点（本任务缺省不调）。 */
export interface SetupHooks {
  installRuntime?(): Promise<void>;
  installAutostart?(): Promise<void>;
}

/** runSetup 选项。 */
export interface SetupOpts {
  /** 平台 API base（device flow 与设备注册同源；尾斜杠容忍并归一）。 */
  apiBase: string;
  /** 实例 profile（config.json 四字段之一；同机多实例门 A8）。 */
  profile?: string;
  /** 交互注入（缺省 readline/console）。 */
  io?: SetupIo;
  /** fetch 注入（device flow + 设备注册共用；测试 mock）。 */
  fetchImpl?: typeof fetch;
  /** 子进程探测注入（R4；测试 mock）。 */
  execImpl?: ExecImpl;
  /** fs 注入（测试内存替身）。 */
  fsImpl?: SetupFs;
  /** T19 席位（缺省不调）。 */
  hooks?: SetupHooks;
  /** 机甲根目录覆盖（R17 裁定，**test-only**）：config.json 落点由此派生。 */
  homeOverride?: string;
}

/** setup 结果（T18 契约）。 */
export interface SetupResult {
  deviceId: string;
  policy: Mecha.MechaPolicy;
  configPath: string;
  runtimeInstalled: boolean;
  autostartInstalled: boolean;
}

/** dev 预设的程序名（R4：name = 预设名，真身探测取得）。 */
const DEV_PRESET: readonly string[] = ['python', 'node', 'git'];

/** 设备注册端点（客户端单方契约——平台 plan 对齐点，见文件头步骤⑥）。 */
const REGISTER_DEVICES_PATH = '/api/mecha/devices';

/** 快捷项（homedir 拼接，仅列出实存者）。 */
const QUICK_PICKS: ReadonlyArray<{ label: string; rel: string }> = [
  { label: '桌面', rel: 'Desktop' },
  { label: '文档', rel: 'Documents' },
  { label: '下载', rel: 'Downloads' },
];

/** 缺省交互：readline 问答 + console 输出；close 释放句柄（进程不悬挂）。 */
function makeDefaultIo(): Required<SetupIo> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (prompt) => rl.question(prompt),
    note: (s) => console.log(s),
    close: () => rl.close(),
  };
}

/** 缺省 fs：真实 fs；realpath 走本仓规范形（win32 native）。 */
const defaultFs: SetupFs = {
  existsSync: (p) => fs.existsSync(p),
  realpathSync: (p) => realpathCanonical(p),
  statSync: (p) => fs.statSync(p),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  writeFileSync: (p, data) => fs.writeFileSync(p, data, 'utf8'),
  chmodSync: (p, mode) => fs.chmodSync(p, mode),
};

/** 缺省探测：execFile（无 shell；非零退出/找不到 → reject）。 */
function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      if (err !== null) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });
}

const WIN32 = process.platform === 'win32';

/** 探测单个程序真身（R4）：where/which 首个匹配行 → 绝对路径 → 规范形
 * realpath。占位桩防线（I4，final review）：0 字节文件（Windows Store 的
 * AppExecution alias 桩——`where python` 会命中它但一跑就弹商店）与
 * realpath 落在 `WindowsApps` 段下的重parse别名归宿都不可注册——注册进去
 * 只会让每次 exec 撞占位符。任何一环不成立 → 跳过并提示（可稍后在网页
 * 添加），返回 null。 */
async function probeProgram(
  name: string,
  execImpl: ExecImpl,
  fsImpl: SetupFs,
  note: (s: string) => void,
): Promise<Mecha.MechaProgramEntry | null> {
  const skip = (): null => {
    note(`未找到 ${name}，已跳过（可稍后在网页添加）`);
    return null;
  };
  const skipStub = (): null => {
    note('探测到 Windows Store 占位桩，已跳过（请安装真实 Python 或稍后在网页添加）');
    return null;
  };
  let stdout: string;
  try {
    ({ stdout } = await execImpl(WIN32 ? 'where' : 'which', [name]));
  } catch {
    return skip();
  }
  const first = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (first === undefined || !isAbsolute(first)) return skip();
  let absPath: string;
  try {
    absPath = fsImpl.realpathSync(first);
  } catch {
    return skip();
  }
  // I4 占位桩探测：0 字节桩先查（主判据）；再查 realpath 归宿在 WindowsApps
  // 段下（重parse别名未被展开时的兜底）。stat 不可判定 → 按跳过处理。
  try {
    if (fsImpl.statSync(absPath).size === 0) return skipStub();
  } catch {
    return skip();
  }
  if (absPath.split(/[\\/]/).includes('WindowsApps')) return skipStub();
  return { name, absPath };
}

/** 目录白名单勾选（交互契约见文件头）。返回去重后的规范形绝对路径列表。 */
async function selectDirs(io: SetupIo, fsImpl: SetupFs): Promise<string[]> {
  io.note(
    '白名单目录是你愿意被驾驶员读到、并可能被发送出去的范围；只勾选你愿意开放的目录。',
  );
  for (;;) {
    const chosen = new Set<string>();
    const picks = QUICK_PICKS.filter((qp) => fsImpl.existsSync(join(homedir(), qp.rel)));
    if (picks.length > 0) {
      const listed = picks
        .map((qp, i) => `${i + 1}) ${qp.label}（${join(homedir(), qp.rel)}）`)
        .join('  ');
      const answer = (
        await io.ask(`选择要加入白名单的目录（输入编号，可多选如 1,3；回车跳过）：${listed}`)
      ).trim();
      if (answer !== '') {
        let invalid = false;
        for (const token of answer.split(/[,\s，、]+/).filter((t) => t !== '')) {
          const idx = Number(token) - 1;
          if (!Number.isInteger(idx) || idx < 0 || idx >= picks.length) {
            io.note(`无效编号「${token}」，请重新选择`);
            invalid = true;
            break;
          }
          const pick = picks[idx]!;
          chosen.add(fsImpl.realpathSync(join(homedir(), pick.rel)));
        }
        if (invalid) continue;
      }
    }
    // 自定义循环：回车空行结束；非法输入提示后留在循环里
    for (;;) {
      const answer = (
        await io.ask('输入自定义白名单目录的绝对路径（直接回车结束）')
      ).trim();
      if (answer === '') break;
      if (!isAbsolute(answer)) {
        io.note(`「${answer}」不是绝对路径，已忽略——请输入绝对路径`);
        continue;
      }
      if (!fsImpl.existsSync(answer)) {
        io.note(`目录不存在或不可访问：${answer}，已跳过`);
        continue;
      }
      chosen.add(fsImpl.realpathSync(answer));
    }
    if (chosen.size === 0) {
      io.note('至少需要选择一个白名单目录，请重新选择');
      continue;
    }
    return [...chosen];
  }
}

/** 程序预设档提问。 */
async function askPreset(io: SetupIo): Promise<'none' | 'dev'> {
  for (;;) {
    const answer = (
      await io.ask(
        '选择程序白名单预设：1) none 纯文件整理（回车默认） 2) dev（python/node/git）',
      )
    )
      .trim()
      .toLowerCase();
    if (answer === '' || answer === '1' || answer === 'none') return 'none';
    if (answer === '2' || answer === 'dev') return 'dev';
    io.note('无效选择，请输入 1 或 2');
  }
}

/**
 * 跑完整 setup 向导，兑现 SetupResult（步骤与交互契约见文件头）。
 */
export async function runSetup(opts: SetupOpts): Promise<SetupResult> {
  if (opts.apiBase.trim() === '') {
    throw new Error('mecha setup: apiBase 不能为空');
  }
  const io = opts.io ?? makeDefaultIo();
  const ownIo = opts.io === undefined;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const execImpl = opts.execImpl ?? defaultExec;
  const fsImpl = opts.fsImpl ?? defaultFs;
  const profile = opts.profile ?? 'default';
  const base = opts.apiBase.replace(/\/+$/, '');

  try {
    // ① 设备登录（T17）：授权在浏览器完成，终端不碰密码
    io.note('[1/5] 设备登录：请在浏览器完成授权');
    const { deviceId, deviceToken } = await runDeviceFlow(
      base,
      fetchImpl,
      (s) => io.note(s),
    );

    // ② 目录白名单（诚实文案在 selectDirs 内展示）
    io.note('[2/5] 选择白名单目录');
    const dirs = await selectDirs(io, fsImpl);

    // ③ 程序预设档
    io.note('[3/5] 程序白名单预设');
    const preset = await askPreset(io);

    // ④ 探测真身（R4）：找不到的跳过并提示，绝不编造条目
    io.note('[4/5] 探测程序真身');
    const programs: Mecha.MechaProgramEntry[] = [];
    if (preset === 'dev') {
      for (const name of DEV_PRESET) {
        const entry = await probeProgram(name, execImpl, fsImpl, (s) => io.note(s));
        if (entry !== null) programs.push(entry);
      }
    }

    // ⑤ 组装 MechaPolicy（limits 单一事实源 = MECHA_LIMITS_DEFAULTS）
    const policy: Mecha.MechaPolicy = {
      dirs,
      programs,
      limits: { ...Mecha.MECHA_LIMITS_DEFAULTS },
    };
    const selfCheck = Mecha.MechaPolicySchema.safeParse(policy);
    if (!selfCheck.success) {
      throw new Error('mecha setup: 组装的策略未通过协议 schema 校验（内部错误）');
    }

    // ⑥ 注册到平台（端点契约见文件头：客户端单方契约，平台 plan 对齐点）
    io.note('[5/5] 注册到平台');
    const res = await fetchImpl(`${base}${REGISTER_DEVICES_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ deviceId, policy }),
    });
    if (res.status < 200 || res.status >= 300) {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        // body 不可读也照样抛——status 本身已在消息里
      }
      throw new Error(`mecha setup: 注册设备失败（status ${res.status}）：${bodyText}`);
    }

    // ⑦ 落盘 config.json（daemon T16 装载的同一形状；POSIX 权限收紧）
    const cfgPath =
      opts.homeOverride !== undefined
        ? join(opts.homeOverride, 'config.json')
        : configPath();
    fsImpl.mkdirSync(dirname(cfgPath), { recursive: true });
    fsImpl.writeFileSync(
      cfgPath,
      `${JSON.stringify({ deviceId, deviceToken, apiBase: base, profile }, null, 2)}\n`,
    );
    if (WIN32) {
      io.note('Windows：跳过 config.json 权限收紧（chmod 0o600 仅适用于 POSIX）');
    } else {
      try {
        fsImpl.chmodSync(cfgPath, 0o600);
      } catch (err) {
        io.note(
          `config.json 权限收紧失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ⑧ T19 席位：runtime 自装 → 自启安装（缺省不调，旗标 false）
    let runtimeInstalled = false;
    let autostartInstalled = false;
    if (opts.hooks?.installRuntime !== undefined) {
      await opts.hooks.installRuntime();
      runtimeInstalled = true;
    }
    if (opts.hooks?.installAutostart !== undefined) {
      await opts.hooks.installAutostart();
      autostartInstalled = true;
    }

    // ⑨ 完成摘要 + 本地刹车安全提示
    io.note(
      `机甲已上线：设备 ${deviceId} 已注册，配置已写入 ${cfgPath}（profile ${profile}）`,
    );
    io.note(`白名单目录 ${dirs.length} 个，程序白名单 ${programs.length} 个`);
    io.note('安全提示：本地刹车随时可用——终端运行 mecha halt（紧急刹车，离线可用，幂等）');

    return { deviceId, policy, configPath: cfgPath, runtimeInstalled, autostartInstalled };
  } finally {
    if (ownIo) io.close?.();
  }
}
