import { resolvePrivateKey } from './env.js';
import { deriveIdentity } from './crypto.js';
import { initDb, expirePending, getAllKeyCache } from './db.js';
import { state } from './state.js';
import { connectToRelay, startHealthWatchdog, cleanup } from './relay.js';
import { startServer, broadcastInbound } from './server.js';
import { DEFAULT_RELAY_URL } from './constants.js';

process.on('unhandledRejection', (err) => {
  process.stderr.write(`attn: unhandled rejection: ${err}\n`);
});
process.on('uncaughtException', (err) => {
  process.stderr.write(`attn: uncaught exception: ${err}\n`);
});

// 1. Load private key + derive identity
const rootKey = resolvePrivateKey();
const { address, account } = deriveIdentity(rootKey);

state.privateKey = rootKey;
state.address = address;
state.account = account;

process.stderr.write(`attn: address ${address}\n`);

// 2. Initialize DB + maintenance
initDb();

const expired = expirePending(30 * 24 * 60 * 60 * 1000);
if (expired > 0) {
  process.stderr.write(
    `attn: expired ${expired} stale pending message(s)\n`,
  );
}

const cachedKeys = getAllKeyCache();
for (const entry of cachedKeys) {
  state.keyCache.set(entry.address, entry.public_key);
}
if (cachedKeys.length > 0) {
  process.stderr.write(
    `attn: loaded ${cachedKeys.length} cached key(s)\n`,
  );
}

// 3. Start HTTP + WebSocket server
startServer();

// 4. Connect to relay
const relayUrl = process.env.ATTN_RELAY_URL ?? DEFAULT_RELAY_URL;
connectToRelay(relayUrl, (from, plaintext, id, ts, trust, agentName, groupId, groupName, reactionMessageId) => {
  // Broadcast to connected pi extensions
  broadcastInbound({
    type: 'message',
    from,
    message: plaintext,
    id,
    ts,
    trust: trust ?? undefined,
    agentName: agentName ?? undefined,
    groupId: groupId ?? undefined,
    groupName: groupName ?? undefined,
    reactionMessageId: reactionMessageId ?? undefined,
  });

  // Update last inbound tracking
  state.lastInboundFrom = from;
  state.lastInboundMessageId = id;
});

startHealthWatchdog();

// 5. Shutdown handlers
let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`attn: shutting down (${reason})\n`);
  setTimeout(() => process.exit(0), 3000);
  try {
    cleanup();
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Parent PID watchdog
const parentPid = process.ppid;
if (parentPid && parentPid > 1) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      shutdown('parent died');
    }
  }, 5000);
}
