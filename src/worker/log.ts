/**
 * Tiny leveled logger. Set AUTOPIA_LOG=debug to see every trial and every
 * verification decision; default is info. All output goes to stderr so the
 * MCP server (which talks JSON on stdout) can use it too.
 */
type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function currentLevel(): Level {
  const v = (process.env.AUTOPIA_LOG ?? 'info').toLowerCase();
  return (v in ORDER ? v : 'info') as Level;
}

function emit(level: Level, stage: string, msg: string, data?: unknown) {
  if (ORDER[level] < ORDER[currentLevel()]) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${ts} ${level.padEnd(5)} [${stage}] ${msg}`;
  if (data === undefined) process.stderr.write(line + '\n');
  else process.stderr.write(line + ' ' + safeJson(data) + '\n');
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (stage: string, msg: string, data?: unknown) => emit('debug', stage, msg, data),
  info: (stage: string, msg: string, data?: unknown) => emit('info', stage, msg, data),
  warn: (stage: string, msg: string, data?: unknown) => emit('warn', stage, msg, data),
  error: (stage: string, msg: string, data?: unknown) => emit('error', stage, msg, data),
};
