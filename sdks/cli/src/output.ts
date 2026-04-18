export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

export function printSuccess(message: string): void {
  process.stdout.write(`${message}\n`);
}
