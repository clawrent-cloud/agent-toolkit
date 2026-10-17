# CLAUDE.md — ClawRent Agent Toolkit

本文件为 Claude Code (claude.ai/code) 在 **clawrent-agent-toolkit** 仓库内协作开发提供指引。工作区根（`e:\QorderWorkspace\`）另有跨项目总览 CLAUDE.md；本文件专注本开源工具包。面向终端用户的安装/快速开始见仓库 `README.md`，本文件聚焦协作者开发指引。

## 项目定位

开源工具包，用于构建和集成 AI Agent，对接 [ClawRent](https://clawrent.cloud) 市场。仓库：`github.com/clawrent-cloud/agent-toolkit`，协议 ISC。

## 技术栈
- pnpm monorepo（pnpm 10+，Node 22+）
- TypeScript 5.7+ strict
- 构建工具：tsup（SDK/包打包）
- 协议层：Zod schemas
- CLI：Commander.js；MCP 服务：MCP SDK

## 包结构与依赖链

依赖链（**构建顺序**，`pnpm build` 通过 workspace 解析自动处理）：

```
@clawrent/shared-types  （无依赖）
        ↓
@clawrent/protocol      （依赖 shared-types，Zod 模式）
        ↓
@clawrent/cli           （依赖 protocol + shared-types，Commander.js）
        ↓
@clawrent/mcp-server    （依赖 cli + protocol + shared-types）

@clawrent/mecha         （独立叶子包：依赖 protocol + shared-types + commander/ws/zod；
                          devDep @clawrent/provider 仅供 e2e 驾驶测试，非运行时依赖）
```

```
packages/shared-types/   # @clawrent/shared-types — 共享 TS 类型
packages/protocol/       # @clawrent/protocol — HCP 协议（Zod + TS 类型）
packages/provider/       # @clawrent/provider — provider/consumer agent WS 客户端 + serve runtime
sdks/cli/                # @clawrent/cli — Agent 管理 CLI
sdks/mcp-server/         # @clawrent/mcp-server — 面向 AI 编码助手的 MCP 服务
sdks/mecha/              # @clawrent/mecha — 机甲设备端（CLI + 守护进程 + 本地强制层）
```

## 已发布包（npm）

| 包 | 版本 | 说明 |
|----|------|------|
| `@clawrent/cli` | v0.10.0 | Commander.js CLI，Agent 连接与管理（含 `serve --consumer` + `serve-rules` + `serve --staff-token`；0.10.0 随 protocol 0.5.0，staff 任务透传 `responseLanguage`） |
| `@clawrent/provider` | v0.9.0 | provider/consumer agent WS 客户端 + serve runtime 基础库；0.9.0 新增 `MechaDriver` 机甲驾驶 SDK（`on('attached')` + fs/upload/exec 流式原语 + 确认回路） |
| `@clawrent/mcp-server` | v0.7.0 | MCP 服务器（Qoder / Claude 等 AI 助手）；0.7.0 新增 `clawrent_mecha_*` 机甲驾驶工具组（八工具，判级/确认/流块语义与 SDK 一致） |
| `@clawrent/protocol` | v0.6.0 | HCP 协议定义（Zod + TS 类型）；0.6.0 新增 `Mecha.*` 机甲帧族（策略/能力清单/驾驶原语/确认/设备通道帧 + `MECHA_LIMITS_DEFAULTS`） |
| `@clawrent/shared-types` | v0.3.0 | 共享 TypeScript 类型 |
| `@clawrent/mecha` | v0.1.0 | 机甲设备端分发包：`mecha` CLI（setup/status/halt/daemon/update/uninstall）+ 常驻守护进程（纯出站、零监听）+ 本地强制层（目录白名单 realpath 前缀 / 程序表钉死绝对路径 / 溯源判红 / 确认判级）+ 行车记录仪；驾驶员面见 mcp-server `clawrent_mecha_*` 与 provider `MechaDriver` |

> protocol 0.6.0、provider 0.9.0、mcp-server 0.7.0、mecha 0.1.0 为本波待发版本（发布后生效；mecha 为全新首包）；cli 0.10.0、shared-types 0.3.0 已在 npm。发布前确认版本号递增与 `pnpm build` 通过，bump 版本时同步包内 `*_PACKAGE_VERSION` 常量（如 provider `src/index.ts` 的 `PROVIDER_PACKAGE_VERSION`、mecha `src/constants.ts` 的 `MECHA_PACKAGE_VERSION`；cli/mcp-server/protocol/shared-types 无版本常量）。

## 常用命令

```bash
pnpm build        # 构建所有包（按依赖链顺序）
pnpm typecheck    # 类型检查所有包
pnpm lint         # Lint 所有包
```

## 开发约定

- **依赖链即构建顺序**：改 `shared-types` / `protocol` 后，下游 `cli` / `mcp-server` 需重新构建才能消费新类型；本地 `pnpm build` 一次性处理。
- **Skill 资产**：`skills/clawrent/` 目录是 ClawRent 平台的 AI Agent 技能文档（IDE 无关，Qoder / Claude Code / Cursor 等均可加载），教 AI Agent 如何与 ClawRent 平台交互（认证、浏览市场、注册 Agent、会话管理）。改协议/CLI 行为时，同步检查该 Skill 是否需更新。
- **MCP 客户端配置示例**见 README；新增 MCP 工具时确保命名与 protocol 一致。
