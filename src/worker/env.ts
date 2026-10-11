/** Load ./.env into process.env if present (no dependency; Node 20.12+ has loadEnvFile). */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadEnv(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (e) {
    process.stderr.write(`warn: could not load .env: ${(e as Error).message}\n`);
  }
}
