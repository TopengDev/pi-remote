import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { STATE_DIR_NAME, ENV_FILE_NAME } from './constants.js';

export function getStateDir(): string {
  return join(homedir(), STATE_DIR_NAME);
}

export function getPeersDir(): string {
  return join(getStateDir(), 'peers');
}

export function getDbPath(): string {
  return join(getStateDir(), 'history.db');
}

export function loadEnvFile(): void {
  const envFile = join(getStateDir(), ENV_FILE_NAME);
  try {
    try {
      chmodSync(envFile, 0o600);
    } catch {
      // no-op on Windows
    }
    const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2];
      }
    }
  } catch {
    // env file doesn't exist yet — OK
  }
}

export function resolvePrivateKey(): `0x${string}` {
  // 1. Check env var
  if (process.env.ATTN_PRIVATE_KEY) {
    const key = process.env.ATTN_PRIVATE_KEY;
    if (!key.startsWith('0x')) {
      return `0x${key}` as `0x${string}`;
    }
    return key as `0x${string}`;
  }

  // 2. Load from .env file
  loadEnvFile();
  if (process.env.ATTN_PRIVATE_KEY) {
    const key = process.env.ATTN_PRIVATE_KEY;
    if (!key.startsWith('0x')) {
      return `0x${key}` as `0x${string}`;
    }
    return key as `0x${string}`;
  }

  // 3. Generate new key
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const stateDir = getStateDir();

  mkdirSync(stateDir, { recursive: true });
  const envPath = join(stateDir, ENV_FILE_NAME);

  // Append to existing file or create new one
  const existing = existsSync(envPath)
    ? readFileSync(envPath, 'utf8')
    : '';
  if (!existing.includes('ATTN_PRIVATE_KEY=')) {
    writeFileSync(envPath, `${existing}ATTN_PRIVATE_KEY=${privateKey}\n`);
  }
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // no-op on Windows
  }

  process.stderr.write(`attn: Generated new agent identity\n`);
  process.stderr.write(`attn: Address: ${account.address}\n`);
  process.stderr.write(`attn: Key stored at ${join(stateDir, ENV_FILE_NAME)}\n`);

  return privateKey;
}

export function getAddress(): string {
  if (process.env.ATTN_PRIVATE_KEY) {
    const key = process.env.ATTN_PRIVATE_KEY;
    const pk = key.startsWith('0x') ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`);
    return privateKeyToAccount(pk).address.toLowerCase();
  }
  loadEnvFile();
  if (process.env.ATTN_PRIVATE_KEY) {
    const key = process.env.ATTN_PRIVATE_KEY;
    const pk = key.startsWith('0x') ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`);
    return privateKeyToAccount(pk).address.toLowerCase();
  }
  return '';
}
