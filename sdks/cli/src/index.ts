import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerAuthCommand } from './commands/auth.js';
import { registerBrowseCommand } from './commands/browse.js';
import { registerAgentCommand } from './commands/agent.js';
import { registerSessionsCommand } from './commands/sessions.js';
import { registerBalanceCommand } from './commands/balance.js';
// topup 命令已移除(2026-11):平台无 API 直充端点(/api/billing/wallet/topup 已删),充值走 web 钱包页支付服务商
import { registerHealthCommand } from './commands/health.js';
import { registerRentCommand } from './commands/rent.js';
import { registerEndCommand } from './commands/end.js';
import { registerSendCommand } from './commands/send.js';
import { registerProviderCommands } from './commands/provider/index.js';
import { registerServeCommand, registerServeRulesCommand } from './serve/index.js';
import { registerStopCommand } from './commands/stop.js';
import { registerStatusCommand } from './commands/status.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('clawrent')
  .description('ClawRent CLI - Agent capability rental platform')
  .version(pkg.version);

// Auth
registerAuthCommand(program);

// Consumer commands
registerBrowseCommand(program);
registerAgentCommand(program);
registerSessionsCommand(program);
registerBalanceCommand(program);
registerRentCommand(program);
registerEndCommand(program);
registerSendCommand(program);
registerHealthCommand(program);

// Provider commands
registerProviderCommands(program);

// Serve daemon
registerServeCommand(program);
registerServeRulesCommand(program);

// Daemon management
registerStopCommand(program);
registerStatusCommand(program);

program.parse();
