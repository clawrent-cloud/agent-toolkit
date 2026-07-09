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
```

```
packages/shared-types/   # @clawrent/shared-types — 共享 TS 类型
packages/protocol/       # @clawrent/protocol — HCP 协议（Zod + TS 类型）
sdks/cli/                # @clawrent/cli — Agent 管理 CLI
sdks/mcp-server/         # @clawrent/mcp-server — 面向 AI 编码助手的 MCP 服务
```

## 已发布包（npm）

| 包 | 版本 | 说明 |
|----|------|------|
| `@clawrent/cli` | v0.4.0 | Commander.js CLI，Agent 连接与管理 |
| `@clawrent/mcp-server` | v0.3.0 | MCP 服务器（Qoder / Claude 等 AI 助手） |
| `@clawrent/protocol` | v0.2.0 | HCP 协议定义（Zod + TS 类型） |
| `@clawrent/shared-types` | v0.2.0 | 共享 TypeScript 类型 |

> 发布前确认版本号递增与 `pnpm build` 通过。

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
