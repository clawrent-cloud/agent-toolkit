import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '@clawrent/provider';
import { printError, printSuccess } from '../output.js';

/**
 * Task 3(staff 拆 skill 线): `clawrent staff install-skill` —— 从平台受控端点
 * GET /api/staff/skill(X-Staff-Token 门禁)拉取 clawrent-staff skill 文件包并落盘到
 * 目标 harness 的 skills 目录。npm 包自身不携带 skill 内容(红线);token 只用于
 * 本次拉取,不落任何配置。路径全程 node:path(win32 兼容);files[].path 落盘前
 * 强制校验不逃逸目标目录(端点内容被篡改时的最后防线)。
 */

export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillBundle {
  version: string;
  files: SkillFile[];
}

export type TargetResolution =
  | { kind: 'claude' | 'openclaw' | 'dir'; dir: string }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

const SKILL_NAME = 'clawrent-staff';

function harnessDir(home: string, harness: 'claude' | 'openclaw'): string {
  return path.join(home, harness === 'claude' ? '.claude' : '.openclaw', 'skills', SKILL_NAME);
}

export function resolveTargetDir(target: string | undefined, home: string): TargetResolution {
  if (target === 'claude') return { kind: 'claude', dir: harnessDir(home, 'claude') };
  if (target === 'openclaw') return { kind: 'openclaw', dir: harnessDir(home, 'openclaw') };
  if (target) return { kind: 'dir', dir: path.resolve(target) };

  const claude = existsSync(path.join(home, '.claude'));
  const openclaw = existsSync(path.join(home, '.openclaw'));
  if (claude && openclaw) return { kind: 'ambiguous' };
  if (claude) return { kind: 'claude', dir: harnessDir(home, 'claude') };
  if (openclaw) return { kind: 'openclaw', dir: harnessDir(home, 'openclaw') };
  return { kind: 'none' };
}

export function assertSafePaths(files: Array<{ path: string }>, dir: string): void {
  const root = path.resolve(dir);
  for (const f of files) {
    const resolved = path.resolve(root, f.path);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`unsafe skill file path (escapes target dir): ${f.path}`);
    }
  }
}

export async function fetchSkillBundle(server: string, staffToken: string): Promise<SkillBundle> {
  const res = await fetch(`${server.replace(/\/+$/, '')}/api/staff/skill`, {
    headers: { 'X-Staff-Token': staffToken },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`token rejected (HTTP ${res.status}) — issue a fresh staff/delegation token from the admin console`);
  }
  if (!res.ok) {
    throw new Error(`fetch failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as SkillBundle;
  if (typeof body.version !== 'string' || !Array.isArray(body.files)) {
    throw new Error('malformed skill bundle (version/files missing)');
  }
  for (const f of body.files) {
    if (typeof f.path !== 'string' || typeof f.content !== 'string') {
      throw new Error('malformed skill bundle (file entry shape)');
    }
  }
  return body;
}

export function writeSkillFiles(dir: string, files: SkillFile[]): void {
  assertSafePaths(files, dir);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const dest = path.join(dir, f.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, f.content, 'utf8');
  }
}

export function registerStaffCommand(program: Command): void {
  const staff = program.command('staff').description('ClawRent staff delegate operations');

  staff
    .command('install-skill')
    .description('Install the clawrent-staff skill from the platform (token-gated) into a harness skills directory')
    .requiredOption('--staff-token <token>', 'stf_clawrent_* or dlg_clawrent_* token')
    .option('--target <target>', 'claude | openclaw | an explicit directory path')
    .option('--server <url>', 'API base URL (defaults to saved config / https://clawrent.cloud)')
    .action(async (opts: { staffToken: string; target?: string; server?: string }) => {
      try {
        const server = opts.server ?? loadConfig().apiUrl;
        const bundle = await fetchSkillBundle(server, opts.staffToken);

        const resolution = resolveTargetDir(opts.target, homedir());
        if (resolution.kind === 'ambiguous') {
          printError('Both ~/.claude and ~/.openclaw detected — pass --target claude or --target openclaw (or a directory path).');
          process.exitCode = 1;
          return;
        }
        if (resolution.kind === 'none') {
          printError('No agent harness detected (neither ~/.claude nor ~/.openclaw) — pass --target <directory path>.');
          process.exitCode = 1;
          return;
        }

        writeSkillFiles(resolution.dir, bundle.files);
        printSuccess(`clawrent-staff skill v${bundle.version} installed to ${resolution.dir}`);
        printSuccess('Files written: ' + bundle.files.map((f) => f.path).join(', '));
        printSuccess('Next: run the MCP server with CLAWRENT_STAFF_TOKEN set, or `clawrent serve --staff-token ... --listen | --exec`.');
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
