import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { getDbPath, getStateDir } from './env.js';

let db: Database.Database | null = null;

export function initDb(): Database.Database {
  if (db) return db;

  const stateDir = getStateDir();
  mkdirSync(stateDir, { recursive: true });

  db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      peer TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      content TEXT NOT NULL,
      ts TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_peer_ts ON messages(peer, ts DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_dir_ts ON messages(direction, ts)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      address TEXT PRIMARY KEY,
      name TEXT,
      added_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked (
      address TEXT PRIMARY KEY,
      blocked_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending (
      id TEXT PRIMARY KEY,
      from_address TEXT NOT NULL,
      plaintext TEXT NOT NULL,
      ts INTEGER NOT NULL,
      notified INTEGER DEFAULT 0
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_from ON pending(from_address)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      to_address TEXT NOT NULL,
      encrypted TEXT NOT NULL,
      signature TEXT NOT NULL,
      ts INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS key_cache (
      address TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      from_address TEXT NOT NULL,
      emoji TEXT NOT NULL,
      ts TEXT NOT NULL,
      PRIMARY KEY (message_id, from_address)
    )
  `);

  return db;
}

// --- Messages ---

export function saveMessage(msg: {
  id: string;
  peer: string;
  direction: 'inbound' | 'outbound';
  content: string;
  ts: string;
}): void {
  const d = initDb();
  d.prepare(
    `INSERT OR IGNORE INTO messages (id, peer, direction, content, ts) VALUES (?, ?, ?, ?, ?)`,
  ).run(msg.id, msg.peer.toLowerCase(), msg.direction, msg.content, msg.ts);
}

export interface HistoryEntry {
  id: string;
  peer: string;
  direction: string;
  content: string;
  ts: string;
}

export function getHistory(
  peer: string,
  limit: number = 20,
): HistoryEntry[] {
  const d = initDb();
  const rows = d
    .prepare(
      `SELECT id, peer, direction, content, ts FROM messages WHERE peer = ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(peer.toLowerCase(), limit) as HistoryEntry[];
  return rows.reverse();
}

// --- Contacts ---

export function isContact(address: string): boolean {
  const d = initDb();
  const row = d
    .prepare(`SELECT address FROM contacts WHERE address = ?`)
    .get(address.toLowerCase());
  return !!row;
}

export function addContact(address: string, name?: string): void {
  const d = initDb();
  d.prepare(
    `INSERT INTO contacts (address, name, added_at) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)`,
  ).run(address.toLowerCase(), name ?? null, new Date().toISOString());
}

export function updateContactName(address: string, name: string | null): void {
  const d = initDb();
  d.prepare(`UPDATE contacts SET name = ? WHERE address = ?`).run(
    name,
    address.toLowerCase(),
  );
}

export function getContactName(address: string): string | null {
  const d = initDb();
  const row = d
    .prepare(`SELECT name FROM contacts WHERE address = ?`)
    .get(address.toLowerCase()) as { name: string | null } | undefined;
  return row?.name ?? null;
}

export function getContacts(): Array<{
  address: string;
  name: string | null;
  added_at: string;
}> {
  const d = initDb();
  return d
    .prepare(
      `SELECT address, name, added_at FROM contacts ORDER BY added_at DESC`,
    )
    .all() as Array<{ address: string; name: string | null; added_at: string }>;
}

export function removeContact(address: string): void {
  const d = initDb();
  d.prepare(`DELETE FROM contacts WHERE address = ?`).run(address.toLowerCase());
}

// --- Blocked ---

export function blockContact(address: string): void {
  const d = initDb();
  d.prepare(
    `INSERT OR IGNORE INTO blocked (address, blocked_at) VALUES (?, ?)`,
  ).run(address.toLowerCase(), new Date().toISOString());
  d.prepare(`DELETE FROM contacts WHERE address = ?`).run(address.toLowerCase());
  d.prepare(`DELETE FROM pending WHERE from_address = ?`).run(
    address.toLowerCase(),
  );
}

export function unblockContact(address: string): void {
  const d = initDb();
  d.prepare(`DELETE FROM blocked WHERE address = ?`).run(address.toLowerCase());
}

export function isBlocked(address: string): boolean {
  const d = initDb();
  const row = d
    .prepare(`SELECT address FROM blocked WHERE address = ?`)
    .get(address.toLowerCase());
  return !!row;
}

// --- Pending ---

export function savePending(msg: {
  id: string;
  from_address: string;
  plaintext: string;
  ts: number;
}): void {
  const d = initDb();
  d.prepare(
    `INSERT OR IGNORE INTO pending (id, from_address, plaintext, ts) VALUES (?, ?, ?, ?)`,
  ).run(msg.id, msg.from_address.toLowerCase(), msg.plaintext, msg.ts);
}

export function hasPendingNotified(from_address: string): boolean {
  const d = initDb();
  const row = d
    .prepare(
      `SELECT notified FROM pending WHERE from_address = ? AND notified = 1 LIMIT 1`,
    )
    .get(from_address.toLowerCase());
  return !!row;
}

export function markPendingNotified(from_address: string): void {
  const d = initDb();
  d.prepare(`UPDATE pending SET notified = 1 WHERE from_address = ?`).run(
    from_address.toLowerCase(),
  );
}

export function flushPending(
  from_address: string,
): Array<{ id: string; plaintext: string; ts: number }> {
  const d = initDb();
  const rows = d
    .prepare(
      `SELECT id, plaintext, ts FROM pending WHERE from_address = ? ORDER BY ts ASC`,
    )
    .all(from_address.toLowerCase()) as Array<{
    id: string;
    plaintext: string;
    ts: number;
  }>;
  if (rows.length > 0) {
    d.prepare(`DELETE FROM pending WHERE from_address = ?`).run(
      from_address.toLowerCase(),
    );
  }
  return rows;
}

export function getPendingSenders(): Array<{
  from_address: string;
  count: number;
}> {
  const d = initDb();
  return d
    .prepare(
      `SELECT from_address, COUNT(*) as count FROM pending GROUP BY from_address ORDER BY count DESC`,
    )
    .all() as Array<{ from_address: string; count: number }>;
}

export function expirePending(maxAgeMs: number): number {
  const d = initDb();
  const cutoff = Date.now() - maxAgeMs;
  const result = d.prepare(`DELETE FROM pending WHERE ts < ?`).run(cutoff);
  return result.changes;
}

// --- Outbox ---

export function saveOutbox(msg: {
  id: string;
  to_address: string;
  encrypted: string;
  signature: string;
  ts: number;
}): void {
  const d = initDb();
  d.prepare(
    `INSERT OR IGNORE INTO outbox (id, to_address, encrypted, signature, ts) VALUES (?, ?, ?, ?, ?)`,
  ).run(msg.id, msg.to_address.toLowerCase(), msg.encrypted, msg.signature, msg.ts);
}

export function getOutbox(): Array<{
  id: string;
  to_address: string;
  encrypted: string;
  signature: string;
  ts: number;
  attempts: number;
}> {
  const d = initDb();
  return d
    .prepare(
      `SELECT id, to_address, encrypted, signature, ts, attempts FROM outbox ORDER BY ts ASC`,
    )
    .all() as Array<{
    id: string;
    to_address: string;
    encrypted: string;
    signature: string;
    ts: number;
    attempts: number;
  }>;
}

export function deleteOutbox(id: string): void {
  const d = initDb();
  d.prepare(`DELETE FROM outbox WHERE id = ?`).run(id);
}

export function incrementOutboxAttempts(id: string): void {
  const d = initDb();
  d.prepare(`UPDATE outbox SET attempts = attempts + 1 WHERE id = ?`).run(id);
}

// --- Key Cache ---

export function saveKeyCache(address: string, publicKey: string): void {
  const d = initDb();
  d.prepare(
    `INSERT INTO key_cache (address, public_key, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET public_key = excluded.public_key, updated_at = excluded.updated_at`,
  ).run(address.toLowerCase(), publicKey, new Date().toISOString());
}

export function getKeyCache(address: string): string | null {
  const d = initDb();
  const row = d
    .prepare(`SELECT public_key FROM key_cache WHERE address = ?`)
    .get(address.toLowerCase()) as { public_key: string } | undefined;
  return row?.public_key ?? null;
}

export function getAllKeyCache(): Array<{
  address: string;
  public_key: string;
}> {
  const d = initDb();
  return d
    .prepare(`SELECT address, public_key FROM key_cache`)
    .all() as Array<{ address: string; public_key: string }>;
}

// --- Reactions ---

export function saveReaction(reaction: {
  message_id: string;
  from_address: string;
  emoji: string;
  ts: string;
}): void {
  const d = initDb();
  d.prepare(
    `INSERT OR REPLACE INTO reactions (message_id, from_address, emoji, ts) VALUES (?, ?, ?, ?)`,
  ).run(
    reaction.message_id,
    reaction.from_address.toLowerCase(),
    reaction.emoji,
    reaction.ts,
  );
}
