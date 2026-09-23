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
packages/provider/       # @clawrent/provider — provider/consumer agent WS 客户端 + serve runtime
sdks/cli/                # @clawrent/cli — Agent 管理 CLI
sdks/mcp-server/         # @clawrent/mcp-server — 面向 AI 编码助手的 MCP 服务
```

## 已发布包（npm）

| 包 | 版本 | 说明 |
|----|------|------|
| `@clawrent/cli` | v0.10.0 | Commander.js CLI，Agent 连接与管理（含 `serve --consumer` + `serve-rules` + `serve --staff-token`；0.10.0 随 protocol 0.5.0，staff 任务透传 `responseLanguage`） |
| `@clawrent/provider` | v0.8.2 | provider/consumer agent WS 客户端 + serve runtime 基础库（`StaffAgentClient` + `ApiClient.setStaffToken`/staff REST；0.8.2 随 protocol 0.5.0——serve 帧 `responseLanguage` 透传到消费者，已发 0.8.1 钉死 protocol 0.4.0 会 strip） |
| `@clawrent/mcp-server` | v0.6.0 | MCP 服务器（Qoder / Claude 等 AI 助手，新增 `clawrent_staff_*` 工具组 + `CLAWRENT_STAFF_TOKEN`；0.5.1 submit_result 对象契约对齐；0.6.0 随 protocol 0.5.0，get_tasks 透传 `responseLanguage`） |
| `@clawrent/protocol` | v0.5.0 | HCP 协议定义（Zod + TS 类型；0.4.0 重写 staff 帧契约，对齐 /ws/staff 实现，BREAKING；0.5.0 +responseLanguage?——additive 双向兼容） |
| `@clawrent/shared-types` | v0.3.0 | 共享 TypeScript 类型 |

> provider 0.8.2、cli 0.10.0、protocol 0.5.0、mcp-server 0.6.0 为本波待发版本（发布后生效）；shared-types 0.3.0 已在 npm。发布前确认版本号递增与 `pnpm build` 通过，bump 版本时同步包内 `*_PACKAGE_VERSION` 常量（如 provider `src/index.ts` 的 `PROVIDER_PACKAGE_VERSION`）。

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
