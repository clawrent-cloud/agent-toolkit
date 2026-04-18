import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerAuthCommand } from './commands/auth.js';
import { registerBrowseCommand } from './commands/browse.js';
import { registerAgentCommand } from './commands/agent.js';
import { registerSessionsCommand } from './commands/sessions.js';
import { registerBalanceCommand } from './commands/balance.js';
import { registerTopupCommand } from './commands/topup.js';
import { registerHealthCommand } from './commands/health.js';
import { registerRentCommand } from './commands/rent.js';
import { registerEndCommand } from './commands/end.js';
import { registerSendCommand } from './commands/send.js';
import { registerProviderCommands } from './commands/provider/index.js';
import { registerServeCommand } from './serve/index.js';
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
registerTopupCommand(program);
registerRentCommand(program);
registerEndCommand(program);
registerSendCommand(program);
registerHealthCommand(program);

// Provider commands
registerProviderCommands(program);

// Serve daemon
registerServeCommand(program);

// Daemon management
registerStopCommand(program);
registerStatusCommand(program);

program.parse();
