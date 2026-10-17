import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import type { ProgramGuardResult } from './program-guard.js';
import { computeTier } from './confirm-tier.js';

// 合成 EACCES 缝（随 program-guard 同一手艺）：仅当 realpathSync(.native) 对
// basename 为 eaccs-dir 的段抛 ENOENT 时翻译成 EACCES——其余全部透传真实 fs
// （fixture 读写不受影响）。用于钉 R2 的"解析不可判定 → 跳过溯源检查"。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrap = (real: (p: fs.PathLike) => string) =>
    ((p: fs.PathLike) => {
      try {
        return real(p);
      } catch (err) {
        const isMarker =
          (err as NodeJS.ErrnoException)?.code === 'ENOENT' &&
          typeof p === 'string' &&
          p.split(/[\\/]/).pop() === 'eaccs-dir';
        if (isMarker) {
          throw Object.assign(new Error(`synthetic EACCES: ${String(p)}`), {
            code: 'EACCES',
          });
        }
        throw err;
      }
    }) as typeof real;
  return {
    ...actual,
    realpathSync: Object.assign(wrap(actual.realpathSync.bind(actual)), {
      native: wrap(actual.realpathSync.native.bind(actual)),
    }),
  } as unknown as typeof actual;
});

// ── fixture 基建（os.tmpdir，plan 全局约束）────────────────────────────────

const created: string[] = [];

/** 每个用例独立的临时工作区（os.tmpdir() 下），统一 afterAll 清理。 */
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mecha-confirm-tier-'));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** 规范形（与 path-guard 真实化同源口径）：win32 native——溯源键按登记侧
 * （ProvenanceStore）契约必须是真实化产物，测试键与之对齐。 */
const CANONICAL = (p: string): string =>
  process.platform === 'win32' ? fs.realpathSync.native(p) : fs.realpathSync(p);

// ── ctx / op 构造助手 ──────────────────────────────────────────────────────

const okProgram = (absPath: string): ProgramGuardResult => ({ ok: true, absPath });
const deniedProgram = (): ProgramGuardResult => ({ ok: false, code: 'PROGRAM_DENIED' });
const none = (): boolean => false;

const execOp = (argv: string[], cwd: string): Mecha.MechaOp => ({
  type: 'exec.run',
  argv,
  cwd,
});

// ── 用例 ───────────────────────────────────────────────────────────────────

describe('computeTier（confirm-tier 判级）', () => {
  // ── tier 表逐格 ──────────────────────────────────────────────────────────

  it('fs.list / fs.read = T0（免确认）；非 exec 不查程序表与溯源', () => {
    const ws = makeWorkspace();
    // 双重哨兵：程序表传"拒绝态"、溯源全红——fs 原语的 ctx 一概不参与判级
    const provenance = vi.fn(() => true);
    expect(
      computeTier({ type: 'fs.list', path: ws }, { program: deniedProgram(), provenance }),
    ).toBe('T0');
    expect(
      computeTier(
        { type: 'fs.read', path: join(ws, 'a.txt'), encoding: 'utf8' },
        { program: deniedProgram(), provenance },
      ),
    ).toBe('T0');
    expect(provenance).not.toHaveBeenCalled();
  });

  it('其余 fs.* 与 file.upload = T1；fs 路径（含溯源文件）不在本函数判红', () => {
    const ws = makeWorkspace();
    // 全红哨兵：即便溯源对所有路径都判红，fs 原语也恒 T1——判红是 exec 专属
    const provenance = vi.fn(() => true);
    const ops: Mecha.MechaOp[] = [
      { type: 'fs.write', path: join(ws, 'x'), content: '', encoding: 'utf8' },
      { type: 'fs.mkdir', path: join(ws, 'd') },
      { type: 'fs.move', from: join(ws, 'a'), to: join(ws, 'b') },
      { type: 'fs.copy', from: join(ws, 'a'), to: join(ws, 'b') },
      { type: 'fs.delete', path: join(ws, 'a'), recursive: true },
      { type: 'file.upload', name: 't.py', content: '' },
    ];
    for (const op of ops) {
      expect(computeTier(op, { program: deniedProgram(), provenance })).toBe('T1');
    }
    expect(provenance).not.toHaveBeenCalled();
  });

  it('exec 基线 = T1：程序命中表、非内联、argv 无溯源命中（判级对照）', () => {
    const ws = makeWorkspace();
    const prog = join(ws, 'bin', 'tool.exe');
    expect(
      computeTier(execOp([prog, join(ws, 'in.txt')], ws), {
        program: okProgram(prog),
        provenance: none,
      }),
    ).toBe('T1');
  });

  it('exec argv[0] 未命中程序表 = {deny:"PROGRAM_DENIED"}，且优先于内联/溯源信号', () => {
    const ws = makeWorkspace();
    // 内联旗标与溯源全红同时成立也必须硬拒——拒不判级，硬拒信息量最小
    expect(
      computeTier(execOp(['unknown-prog', '-c', 'x'], ws), {
        program: deniedProgram(),
        provenance: () => true,
      }),
    ).toEqual({ deny: 'PROGRAM_DENIED' });
    // deny 码与协议七码第二位钉死（防常量漂移）
    expect(Mecha.MECHA_ERROR_CODES[1]).toBe('PROGRAM_DENIED');
  });

  // ── Review Focus #3：溯源判红（跨会话马甲——provenance ctx 注入模拟）──────

  it('溯源判红：argv[1] 绝对路径实存 driver-authored 文件 → T2（Review Focus #3）', () => {
    const ws = makeWorkspace();
    fs.mkdirSync(join(ws, 'tools'), { recursive: true });
    fs.writeFileSync(join(ws, 'tools', 'tool.js'), 'x');
    const key = join(CANONICAL(ws), 'tools', 'tool.js');
    // ctx.provenance 注入 = 会话 1 登记的持久溯源表；会话 2 查询照样命中
    expect(
      computeTier(execOp(['node', join(ws, 'tools', 'tool.js')], ws), {
        program: okProgram(join(ws, 'bin', 'node.exe')),
        provenance: (p) => p === key,
      }),
    ).toBe('T2');
  });

  it('溯源判红：argv[1] 相对路径按 exec.cwd 解析（含 .. 穿越）命中 → T2', () => {
    const ws = makeWorkspace();
    fs.mkdirSync(join(ws, 'tools'), { recursive: true });
    fs.mkdirSync(join(ws, 'sub'), { recursive: true });
    fs.writeFileSync(join(ws, 'tools', 'tool.js'), 'x');
    const key = join(CANONICAL(ws), 'tools', 'tool.js');
    expect(
      computeTier(execOp(['node', '../tools/tool.js'], join(ws, 'sub')), {
        program: okProgram(join(ws, 'bin', 'node.exe')),
        provenance: (p) => p === key,
      }),
    ).toBe('T2');
  });

  it('溯源判红：溯源文件在白名单概念之外照红（本函数不做白名单判断）', () => {
    const ws = makeWorkspace();
    const other = makeWorkspace(); // 独立临时目录——"白名单外"的具象
    fs.mkdirSync(join(other, 'x'), { recursive: true });
    fs.writeFileSync(join(other, 'x', 'evil.sh'), 'x');
    const key = join(CANONICAL(other), 'x', 'evil.sh');
    expect(
      computeTier(execOp(['bash', join(other, 'x', 'evil.sh')], ws), {
        program: okProgram(join(ws, 'bin', 'bash')),
        provenance: (p) => p === key,
      }),
    ).toBe('T2');
  });

  it('溯源判红：argv[0] 登记真身本身是 driver-authored 文件 → T2', () => {
    const ws = makeWorkspace();
    const absPath = join(CANONICAL(ws), 'tools', 'tool.js');
    expect(
      computeTier(execOp([join(ws, 'tools', 'tool.js')], ws), {
        program: okProgram(absPath),
        provenance: (p) => p === absPath,
      }),
    ).toBe('T2');
  });

  it('溯源判红：路径不存在但登记过该真实化形态（最长存在前缀+尾段）→ T2（R2）', () => {
    const ws = makeWorkspace();
    fs.mkdirSync(join(ws, 'tools'), { recursive: true }); // evil.py 本身不存在
    const key = join(CANONICAL(ws), 'tools', 'evil.py');
    expect(
      computeTier(execOp(['python', join(ws, 'tools', 'evil.py')], ws), {
        program: okProgram(join(ws, 'bin', 'python.exe')),
        provenance: (p) => p === key,
      }),
    ).toBe('T2');
  });

  it('溯源判红：解析不可判定（非 ENOENT）→ 跳过该元素溯源检查 → T1（R2）', () => {
    const ws = makeWorkspace();
    // 哨兵只对 eaccs 路径判红：被问到即红——结果 T1 证明不可判定元素真的被
    // 跳过（没问；argv[0] 的 python.exe 查询照常发生但不命中）
    const provenance = vi.fn((p: string) => p.includes('eaccs-dir'));
    expect(
      computeTier(execOp(['python', join(ws, 'eaccs-dir', 'evil.py')], ws), {
        program: okProgram(join(ws, 'bin', 'python.exe')),
        provenance,
      }),
    ).toBe('T1');
    expect(provenance).not.toHaveBeenCalledWith(expect.stringContaining('eaccs-dir'));
  });

  it('win32 盘符相对 argv 形态（C:foo）：node 与子进程内核解析基座可能分歧 → fail-safe T2', () => {
    const ws = makeWorkspace();
    const res = computeTier(execOp(['python', 'C:evil.py'], ws), {
      program: okProgram(join(ws, 'bin', 'python.exe')),
      provenance: none, // 溯源全假仍红——形态本身即解析不可靠
    });
    // 仅 win32 有盘符相对语义（posix 上 C:foo 只是普通文件名，T1）
    if (process.platform === 'win32') {
      expect(res).toBe('T2');
    } else {
      expect(res).toBe('T1');
    }
  });

  // ── Review Focus #4：解释器内联（精确清单逐旗标钉）────────────────────────

  it('解释器内联：python / python3 + -c → T2', () => {
    const ws = makeWorkspace();
    for (const name of ['python', 'python3']) {
      expect(
        computeTier(execOp([name, '-c', 'print(1)'], ws), {
          program: okProgram(join(ws, 'bin', `${name}.exe`)),
          provenance: none,
        }),
      ).toBe('T2');
    }
  });

  it('解释器内联：node + -e / --eval → T2', () => {
    const ws = makeWorkspace();
    for (const flag of ['-e', '--eval']) {
      expect(
        computeTier(execOp(['node', flag, 'console.log(1)'], ws), {
          program: okProgram(join(ws, 'bin', 'node.exe')),
          provenance: none,
        }),
      ).toBe('T2');
    }
  });

  it('解释器内联：bash / sh / zsh + -c → T2', () => {
    const ws = makeWorkspace();
    for (const name of ['bash', 'sh', 'zsh']) {
      expect(
        computeTier(execOp([name, '-c', 'ls'], ws), {
          program: okProgram(join(ws, 'bin', name)),
          provenance: none,
        }),
      ).toBe('T2');
    }
  });

  it('解释器内联：powershell / pwsh + -Command（Windows 原生旗标大小写不敏感）→ T2', () => {
    const ws = makeWorkspace();
    for (const flag of ['-Command', '-command', '-COMMAND']) {
      expect(
        computeTier(execOp(['powershell', flag, 'Get-Process'], ws), {
          program: okProgram(join(ws, 'bin', 'powershell.exe')),
          provenance: none,
        }),
      ).toBe('T2');
      expect(
        computeTier(execOp(['pwsh', flag, 'Get-Process'], ws), {
          program: okProgram(join(ws, 'bin', 'pwsh.exe')),
          provenance: none,
        }),
      ).toBe('T2');
    }
  });

  it('解释器内联：cmd + /c（含 /C、/ce、/CE、/cE——大小写不敏感）→ T2', () => {
    const ws = makeWorkspace();
    for (const flag of ['/c', '/C', '/ce', '/CE', '/cE']) {
      expect(
        computeTier(execOp(['cmd', flag, 'dir'], ws), {
          program: okProgram(join(ws, 'bin', 'cmd.exe')),
          provenance: none,
        }),
      ).toBe('T2');
    }
  });

  it('解释器内联：旗标不限 argv[1] 位置（python -u -c、cmd /d /c）→ T2', () => {
    const ws = makeWorkspace();
    expect(
      computeTier(execOp(['python', '-u', '-c', 'print(1)'], ws), {
        program: okProgram(join(ws, 'bin', 'python.exe')),
        provenance: none,
      }),
    ).toBe('T2');
    expect(
      computeTier(execOp(['cmd', '/d', '/c', 'dir'], ws), {
        program: okProgram(join(ws, 'bin', 'cmd.exe')),
        provenance: none,
      }),
    ).toBe('T2');
  });

  it('解释器身份按真身 basename（去 .exe/.bat/.cmd、小写），非 argv[0] 字符串、非登记名', () => {
    const ws = makeWorkspace();
    // 登记名 py → 真身 python.exe：真身 basename 命中 → T2
    expect(
      computeTier(execOp(['py', '-c', 'print(1)'], ws), {
        program: okProgram(join(ws, 'bin', 'python.exe')),
        provenance: none,
      }),
    ).toBe('T2');
    // 登记名 python → 真身 myrunner.exe：真身不命中 → T1（身份钉死为真身文件名）
    expect(
      computeTier(execOp(['python', '-c', 'print(1)'], ws), {
        program: okProgram(join(ws, 'bin', 'myrunner.exe')),
        provenance: none,
      }),
    ).toBe('T1');
    // 无扩展名真身（posix 形态）照常识别
    expect(
      computeTier(execOp(['bash', '-c', 'ls'], ws), {
        program: okProgram(join(ws, 'bin', 'bash')),
        provenance: none,
      }),
    ).toBe('T2');
    // 大小写混合扩展名剥离（win32 盘上真实大小写形态）
    expect(
      computeTier(execOp(['pwsh', '-Command', 'x'], ws), {
        program: okProgram(join(ws, 'bin', 'PWSH.EXE')),
        provenance: none,
      }),
    ).toBe('T2');
  });

  it('负对照：非内联旗标与无旗标 exec 恒 T1（POSIX 旗标大小写敏感钉死）', () => {
    const ws = makeWorkspace();
    // POSIX 旗标大小写敏感：bash -C 是 noclobber、非内联（大小写折叠反而语义错误）
    expect(
      computeTier(execOp(['bash', '-C', 'script'], ws), {
        program: okProgram(join(ws, 'bin', 'bash')),
        provenance: none,
      }),
    ).toBe('T1');
    expect(
      computeTier(execOp(['python', join(ws, 'script.py')], ws), {
        program: okProgram(join(ws, 'bin', 'python.exe')),
        provenance: none,
      }),
    ).toBe('T1');
    expect(
      computeTier(execOp(['node', 'app.js'], ws), {
        program: okProgram(join(ws, 'bin', 'node.exe')),
        provenance: none,
      }),
    ).toBe('T1');
    expect(
      computeTier(execOp(['powershell', '-File', join(ws, 'x.ps1')], ws), {
        program: okProgram(join(ws, 'bin', 'powershell.exe')),
        provenance: none,
      }),
    ).toBe('T1');
    expect(
      computeTier(execOp(['cmd', '/d', 'dir'], ws), {
        program: okProgram(join(ws, 'bin', 'cmd.exe')),
        provenance: none,
      }),
    ).toBe('T1');
  });

  // ── 解释器内联（review 裁定扩充，逐模式钉）────────────────────────────────

  it('解释器内联扩充：powershell/pwsh + -EncodedCommand / -enc 缩写族（大小写不敏感）→ T2', () => {
    const ws = makeWorkspace();
    const b64 = 'R2V0LVByb2Nlc3M=';
    for (const flag of ['-EncodedCommand', '-encodedcommand', '-ENC', '-enc']) {
      expect(
        computeTier(execOp(['pwsh', flag, b64], ws), {
          program: okProgram(join(ws, 'bin', 'pwsh.exe')),
          provenance: none,
        }),
      ).toBe('T2');
    }
    expect(
      computeTier(execOp(['powershell', '-ENCODEDCOMMAND', b64], ws), {
        program: okProgram(join(ws, 'bin', 'powershell.exe')),
        provenance: none,
      }),
    ).toBe('T2');
  });

  it('解释器内联扩充：cmd + /k（含 /K——跑完保壳，同类内联入口）→ T2', () => {
    const ws = makeWorkspace();
    for (const flag of ['/k', '/K']) {
      expect(
        computeTier(execOp(['cmd', flag, 'dir'], ws), {
          program: okProgram(join(ws, 'bin', 'cmd.exe')),
          provenance: none,
        }),
      ).toBe('T2');
    }
  });

  it('解释器内联扩充：bash/sh/zsh 组合短旗标簇含 c（-lc/-cl/-ic）→ T2；无 c 簇与外溢 T1', () => {
    const ws = makeWorkspace();
    for (const [name, cluster] of [
      ['bash', '-lc'],
      ['sh', '-cl'],
      ['zsh', '-ic'],
    ] as Array<[string, string]>) {
      expect(
        computeTier(execOp([name, cluster, 'ls'], ws), {
          program: okProgram(join(ws, 'bin', name)),
          provenance: none,
        }),
      ).toBe('T2');
    }
    // 负对照：簇内无小写 c（-l login、-lC 含大写 C=noclobber）不红
    expect(
      computeTier(execOp(['bash', '-l', 'script'], ws), {
        program: okProgram(join(ws, 'bin', 'bash')),
        provenance: none,
      }),
    ).toBe('T1');
    expect(
      computeTier(execOp(['bash', '-lC', 'script'], ws), {
        program: okProgram(join(ws, 'bin', 'bash')),
        provenance: none,
      }),
    ).toBe('T1');
    // 组合簇规则仅 bash/sh/zsh——不外溢到 python（其多字符旗标语义不同）
    expect(
      computeTier(execOp(['python', '-lc', 'x'], ws), {
        program: okProgram(join(ws, 'bin', 'python.exe')),
        provenance: none,
      }),
    ).toBe('T1');
  });

  it('解释器内联扩充：equals 形（node --eval= / --expression=、pwsh -Command=）→ T2', () => {
    const ws = makeWorkspace();
    for (const flag of ['--eval=console.log(1)', '--expression=console.log(1)']) {
      expect(
        computeTier(execOp(['node', flag], ws), {
          program: okProgram(join(ws, 'bin', 'node.exe')),
          provenance: none,
        }),
      ).toBe('T2');
    }
    expect(
      computeTier(execOp(['pwsh', '-Command=Get-Process'], ws), {
        program: okProgram(join(ws, 'bin', 'pwsh.exe')),
        provenance: none,
      }),
    ).toBe('T2');
  });

  // ── 契约与穷尽 ───────────────────────────────────────────────────────────

  it('schema 外 op type：响亮抛错（穷尽哨兵，编码错误不静默判级）', () => {
    const bogus = { type: 'fs.chmod', path: '/x' } as unknown as Mecha.MechaOp;
    expect(() =>
      computeTier(bogus, { program: okProgram('/bin/true'), provenance: none }),
    ).toThrowError(/未知 op/);
  });
});
