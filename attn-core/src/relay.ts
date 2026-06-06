import WebSocket from 'ws';
import type { RawData } from 'ws';
import { state, isRelayReady } from './state.js';
import { decryptMessage, verifyEnvelope, decryptBinary } from './crypto.js';
import { broadcastInbound } from './server.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveMessage, isContact, isBlocked, getContactName, savePending, hasPendingNotified, markPendingNotified, getOutbox, deleteOutbox, incrementOutboxAttempts, saveKeyCache, getKeyCache, saveReaction, updateContactName } from './db.js';

// --- Types (same protocol as upstream) ---

type ServerMessage =
  | { type: 'challenge'; nonce: string }
  | { type: 'auth_ok'; address: string }
  | { type: 'auth_error'; error: string }
  | {
      type: 'message';
      id: string;
      from: string;
      from_name?: string;
      encrypted: string;
      signature: string;
      ts: number;
      group_id?: string;
      group_name?: string;
    }
  | {
      type: 'reaction';
      id: string;
      from: string;
      from_name?: string;
      message_id: string;
      encrypted: string;
      signature: string;
      ts: number;
      group_id?: string;
      group_name?: string;
    }
  | { type: 'key_response'; address: string; publicKey: string | null }
  | { type: 'presence_response'; address: string; state: 'online' | 'away'; message: string | null }
  | { type: 'received'; id: string }
  | { type: 'delivered'; id: string }
  | { type: 'delivery_status'; id: string; to: string; status: 'delivered' | 'queued'; recipient_state?: 'online' | 'away'; recipient_message?: string | null }
  | {
      type: 'file';
      id: string;
      from: string;
      from_name?: string;
      url: string;
      key: string;
      filename: string;
      ts: number;
    }
  | { type: 'error'; error: string };

type OnInbound = (
  from: string,
  plaintext: string,
  id: string,
  ts: number,
  trust?: string,
  agentName?: string,
  groupId?: string,
  groupName?: string,
  reactionMessageId?: string,
) => void;

let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let authHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
let healthWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastHealthyAt = Date.now();

let currentRelayUrl: string | null = null;
let currentOnInbound: OnInbound | null = null;

const keyTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// --- Whisper pipeline (lazy-loaded singleton) ---
let whisperPipeline: any = null;

async function getWhisperPipeline(): Promise<any> {
  if (!whisperPipeline) {
    const { pipeline } = await import('@xenova/transformers');
    whisperPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en');
    process.stderr.write('attn: whisper pipeline initialized\n');
  }
  return whisperPipeline;
}

// --- Helpers ---

function teardownWsState(): void {
  state.authenticated = false;
  state.relayWs = null;
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  if (authHandshakeTimer) {
    clearTimeout(authHandshakeTimer);
    authHandshakeTimer = null;
  }
}

function forceCleanupAndReconnect(reason: string): void {
  process.stderr.write(`attn: force cleanup + reconnect — ${reason}\n`);
  if (state.relayWs) {
    try {
      state.relayWs.close();
    } catch {
      // ignore
    }
  }
  teardownWsState();
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  process.stderr.write(`attn: reconnect scheduled in ${reconnectDelay}ms\n`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      if (currentRelayUrl && currentOnInbound) {
        connectToRelay(currentRelayUrl, currentOnInbound);
      } else {
        process.stderr.write(`attn: reconnect skipped — no relayUrl captured\n`);
      }
    } catch (err) {
      process.stderr.write(
        `attn: reconnect attempt threw: ${err instanceof Error ? err.message : err}\n`,
      );
      scheduleReconnect();
    }
  }, reconnectDelay);
}

function forceReconnect(ws: WebSocket, reason: string): void {
  process.stderr.write(`attn: forcing reconnect — ${reason}\n`);
  try {
    ws.close(4000, reason);
  } catch {
    // ignore
  }
}

function syncContactName(
  address: string,
  relayName?: string,
): string | null {
  const local = getContactName(address);
  if (relayName && relayName !== local) {
    updateContactName(address, relayName);
  } else if (!relayName && local?.endsWith('.attn')) {
    updateContactName(address, null);
  }
  return relayName ?? (local?.endsWith('.attn') ? null : local);
}

// --- Main connect function ---

export function connectToRelay(
  relayUrl: string,
  onInbound: OnInbound,
): void {
  currentRelayUrl = relayUrl;
  currentOnInbound = onInbound;

  const wsUrl = `${relayUrl}?address=${state.address}`;
  process.stderr.write(`attn: connecting to ${relayUrl}\n`);

  const ws = new WebSocket(wsUrl);
  state.relayWs = ws;

  // Handshake watchdog
  if (authHandshakeTimer) clearTimeout(authHandshakeTimer);
  authHandshakeTimer = setTimeout(() => {
    if (state.relayWs === ws && !state.authenticated) {
      forceCleanupAndReconnect(
        `auth handshake timeout (10s, readyState=${ws.readyState})`,
      );
    }
  }, 10_000);

  ws.on('open', () => {
    process.stderr.write(`attn: connected\n`);
  });

  ws.on('message', async (raw: RawData) => {
    const rawStr = raw.toString();
    if (rawStr === 'pong') {
      state.lastPongAt = Date.now();
      return;
    }

    let msg: ServerMessage;
    try {
      msg = JSON.parse(rawStr) as ServerMessage;
    } catch {
      process.stderr.write(`attn: failed to parse relay message\n`);
      return;
    }

    switch (msg.type) {
      case 'challenge': {
        try {
          const signature = await state.account!.signMessage({
            message: msg.nonce,
          });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'auth',
                address: state.address,
                signature,
                presence: state.presence,
              }),
            );
          }
        } catch (err) {
          forceReconnect(
            ws,
            `challenge handler error: ${err instanceof Error ? err.message : err}`,
          );
        }
        break;
      }

      case 'auth_ok':
        state.authenticated = true;
        state.lastPongAt = Date.now();
        reconnectDelay = 1000;
        process.stderr.write(`attn: authenticated as ${msg.address}\n`);
        if (authHandshakeTimer) {
          clearTimeout(authHandshakeTimer);
          authHandshakeTimer = null;
        }
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
          if (Date.now() - state.lastPongAt > 90_000) {
            process.stderr.write(
              `attn: pong watchdog expired — ${Math.floor((Date.now() - state.lastPongAt) / 1000)}s since last pong\n`,
            );
            forceReconnect(ws, 'pong watchdog');
            return;
          }
          if (ws.readyState !== WebSocket.OPEN) {
            forceReconnect(
              ws,
              `ping on non-open socket (state ${ws.readyState})`,
            );
            return;
          }
          try {
            ws.send('ping');
          } catch (err) {
            process.stderr.write(
              `attn: ping send failed: ${err instanceof Error ? err.message : err}\n`,
            );
            forceReconnect(ws, 'ping send threw');
          }
        }, 30_000);
        flushOutbox(ws);
        break;

      case 'auth_error':
        process.stderr.write(`attn: auth failed: ${msg.error}\n`);
        forceReconnect(ws, `auth_error: ${msg.error}`);
        break;

      case 'message': {
        try {
          if (isBlocked(msg.from)) {
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
            break;
          }

          const plaintext = decryptMessage(state.privateKey, msg.encrypted);

          if (msg.group_id) {
            saveMessage({
              id: msg.id,
              peer: msg.group_id,
              direction: 'inbound',
              content: plaintext,
              ts: new Date(msg.ts).toISOString(),
            });
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
            const agentName = syncContactName(msg.from, msg.from_name);
            onInbound(
              msg.from,
              plaintext,
              msg.id,
              msg.ts,
              undefined,
              agentName ?? undefined,
              msg.group_id,
              msg.group_name,
            );
            break;
          }

          // DEBUG: bypass signature verification
          // TODO: Re-enable verifyEnvelope once we confirm it verifies against the ETH ADDRESS (0x...),
          // NOT the .attn name. .attn names are mutable (register_name/transfer_name) — only the
          // address is a stable identity. The `from` field is already the address, so verifyEnvelope
          // should already be correct, but validate this before removing the bypass.
          // const valid = await verifyEnvelope(
          //   msg.from,
          //   { id: msg.id, to: state.address, encrypted: msg.encrypted },
          //   msg.signature as `0x${string}`,
          // );
          const valid = true;
          // if (!valid) {
          //   process.stderr.write(`attn: invalid signature from ${msg.from}, dropping\n`);
          //   ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
          //   break;
          // }

          if (!isContact(msg.from)) {
            savePending({
              id: msg.id,
              from_address: msg.from,
              plaintext,
              ts: msg.ts,
            });
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }));

            if (!hasPendingNotified(msg.from)) {
              markPendingNotified(msg.from);
              const relayName = (msg as Record<string, unknown>).from_name as
                | string
                | undefined;
              const pendingContent = relayName
                ? `pending message from ${relayName}`
                : `pending message from unknown agent`;
              onInbound(
                msg.from,
                pendingContent,
                msg.id,
                msg.ts,
                'pending',
                relayName,
              );
            }
            break;
          }

          const agentName = syncContactName(msg.from, msg.from_name);
          saveMessage({
            id: msg.id,
            peer: msg.from,
            direction: 'inbound',
            content: plaintext,
            ts: new Date(msg.ts).toISOString(),
          });
          ws.send(JSON.stringify({ type: 'ack', id: msg.id }));

          // Check if this is a file reference (JSON with "file" key)
          try {
            const parsed = JSON.parse(plaintext);
            if (parsed.file && parsed.file.url && parsed.file.key) {
              // Download encrypted file from relay
              const downloadUrl = `https://attn.s0nderlabs.xyz/files/${parsed.file.key}`;
              const fileRes = await fetch(downloadUrl);
              if (fileRes.ok) {
                const encryptedData = new Uint8Array(await fileRes.arrayBuffer());
                const decrypted = decryptBinary(state.privateKey, encryptedData);
                const savePath = join(tmpdir(), parsed.file.filename || `file_${Date.now()}`);
                writeFileSync(savePath, decrypted);
                const sizeKB = Math.round(decrypted.length / 1024);
                let fileMsg = `📎 File received: ${parsed.file.filename} (${sizeKB} KB)\nSaved to: ${savePath}`;
                if (parsed.file.caption) {
                  fileMsg += `\n📝 ${parsed.file.caption}`;
                }

                // Voice note transcription via Whisper
                const isVoice = parsed.file.type === 'voice' ||
                                parsed.file.filename?.endsWith('.ogg') ||
                                parsed.file.filename?.startsWith('voice_');
                if (isVoice) {
                  try {
                    const { OggOpusDecoder } = await import('ogg-opus-decoder');
                    const decoder = new OggOpusDecoder();
                    await decoder.ready;
                    const { channelData } = await decoder.decodeFile(decrypted);
                    decoder.free();
                    const transcriber = await getWhisperPipeline();
                    const result = await transcriber(channelData[0]);
                    fileMsg += `\n🎤 "${result.text}"`;
                  } catch (e) {
                    process.stderr.write(`attn: whisper transcription failed: ${e instanceof Error ? e.message : String(e)}\n`);
                  }
                }
                broadcastInbound({
                  type: 'message',
                  from: msg.from,
                  message: fileMsg,
                  id: msg.id,
                  ts: msg.ts,
                  agentName: agentName ?? undefined,
                });
                break;
              }
            }
          } catch {
            // Not valid JSON or not a file reference — treat as regular message
          }

          onInbound(
            msg.from,
            plaintext,
            msg.id,
            msg.ts,
            undefined,
            agentName ?? undefined,
          );
        } catch (err) {
          process.stderr.write(
            `attn: failed to process message from ${(msg as { from?: string }).from}: ${err instanceof Error ? (err.stack ?? err.message) : err}\n`,
          );
          ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
        }
        break;
      }

      case 'reaction': {
        try {
          if (isBlocked(msg.from)) {
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
            break;
          }

          const emoji = decryptMessage(state.privateKey, msg.encrypted);

          if (!msg.group_id) {
            // DEBUG: bypass signature verification (same as case 'message')
            // const valid = await verifyEnvelope(
            //   msg.from,
            //   { id: msg.id, to: state.address, encrypted: msg.encrypted },
            //   msg.signature as `0x${string}`,
            // );
            const valid = true;
            // if (!valid) {
            //   ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
            //   break;
            // }
            if (!isContact(msg.from)) {
              ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
              break;
            }
          }

          saveReaction({
            message_id: msg.message_id,
            from_address: msg.from,
            emoji,
            ts: new Date(msg.ts).toISOString(),
          });
          ws.send(JSON.stringify({ type: 'ack', id: msg.id }));

          const agentName = syncContactName(msg.from, msg.from_name);
          onInbound(
            msg.from,
            emoji,
            msg.id,
            msg.ts,
            'reaction',
            agentName ?? undefined,
            msg.group_id,
            msg.group_name,
            msg.message_id,
          );
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
        }
        break;
      }

      case 'key_response': {
        const addr = msg.address;
        const timeout = keyTimeouts.get(addr);
        if (timeout) {
          clearTimeout(timeout);
          keyTimeouts.delete(addr);
        }
        const callbacks = state.pendingKeyRequests.get(addr);
        if (callbacks) {
          state.pendingKeyRequests.delete(addr);
          if (msg.publicKey) {
            state.keyCache.set(addr, msg.publicKey);
            saveKeyCache(addr, msg.publicKey);
          }
          for (const cb of callbacks) cb(msg.publicKey);
        }
        break;
      }

      case 'presence_response': {
        const addr = msg.address;
        const cbs = state.pendingPresenceRequests.get(addr);
        if (cbs) {
          state.pendingPresenceRequests.delete(addr);
          for (const cb of cbs) cb({ state: msg.state, message: msg.message });
        }
        break;
      }

      case 'received':
      case 'delivered':
      case 'delivery_status':
        break;

      case 'file': {
        try {
          if (isBlocked(msg.from)) {
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
            break;
          }
          if (!isContact(msg.from)) {
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
            break;
          }

          // Download encrypted file from relay
          const downloadUrl = `https://attn.s0nderlabs.xyz/files/${msg.key}`;
          const fileRes = await fetch(downloadUrl);
          if (!fileRes.ok) {
            process.stderr.write(
              `attn: file download failed for ${msg.key}: HTTP ${fileRes.status}\n`,
            );
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
            break;
          }

          const encryptedData = new Uint8Array(await fileRes.arrayBuffer());

          // Decrypt with our private key
          const decrypted = decryptBinary(state.privateKey, encryptedData);

          // Save to /tmp
          const savePath = join(tmpdir(), msg.filename);
          writeFileSync(savePath, decrypted);

          ws.send(JSON.stringify({ type: 'ack', id: msg.id }));

          const agentName = syncContactName(msg.from, msg.from_name);

          // Broadcast file notification to pi extensions
          broadcastInbound({
            type: 'file',
            from: msg.from,
            filename: msg.filename,
            path: savePath,
            size: decrypted.length,
            id: msg.id,
            ts: msg.ts,
            agentName: agentName ?? undefined,
          });
        } catch (err) {
          process.stderr.write(
            `attn: file processing error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          try {
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
          } catch {
            // ignore
          }
        }
        break;
      }

      case 'error':
        break;
    }
  });

  ws.on('close', () => {
    if (state.relayWs === ws) {
      teardownWsState();
      process.stderr.write(`attn: disconnected\n`);
      scheduleReconnect();
    }
  });

  ws.on('error', () => {
    process.stderr.write(
      `attn: websocket error event (readyState=${ws.readyState})\n`,
    );
    if (
      (ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.CLOSED) &&
      state.relayWs === ws
    ) {
      forceCleanupAndReconnect(
        `error event on ws (readyState=${ws.readyState})`,
      );
    }
  });
}

// --- Outbox ---

function flushOutbox(ws: WebSocket): void {
  const items = getOutbox();
  if (items.length === 0) return;
  process.stderr.write(
    `attn: flushing ${items.length} queued outbound message(s)\n`,
  );

  const sent: string[] = [];
  const failed: string[] = [];

  for (const item of items) {
    if (item.attempts >= 10) {
      sent.push(item.id);
      process.stderr.write(
        `attn: outbox message ${item.id} failed after 10 attempts, discarding\n`,
      );
      continue;
    }
    try {
      ws.send(
        JSON.stringify({
          type: 'message',
          id: item.id,
          to: item.to_address,
          encrypted: item.encrypted,
          signature: item.signature,
        }),
      );
      sent.push(item.id);
    } catch {
      failed.push(item.id);
    }
  }

  for (const id of sent) deleteOutbox(id);
  for (const id of failed) incrementOutboxAttempts(id);
}

// --- Key request ---

export function requestKey(address: string, forceRefresh = false): Promise<string | null> {
  if (!forceRefresh) {
    const cached = state.keyCache.get(address.toLowerCase());
    if (cached) return Promise.resolve(cached);

    const dbCached = getKeyCache(address.toLowerCase());
    if (dbCached) {
      state.keyCache.set(address.toLowerCase(), dbCached);
      return Promise.resolve(dbCached);
    }
  }

  if (!isRelayReady()) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const addr = address.toLowerCase();
    const existing = state.pendingKeyRequests.get(addr) ?? [];
    existing.push(resolve);
    state.pendingKeyRequests.set(addr, existing);

    if (existing.length === 1 && isRelayReady()) {
      try {
        state.relayWs!.send(JSON.stringify({ type: 'get_key', address: addr }));
      } catch (err) {
        process.stderr.write(
          `attn: requestKey send failed: ${err instanceof Error ? err.message : err}\n`,
        );
        state.pendingKeyRequests.delete(addr);
        resolve(null);
        return;
      }

      const timeout = setTimeout(() => {
        keyTimeouts.delete(addr);
        const cbs = state.pendingKeyRequests.get(addr);
        if (cbs) {
          state.pendingKeyRequests.delete(addr);
          for (const cb of cbs) cb(null);
        }
      }, 10000);
      keyTimeouts.set(addr, timeout);
    }
  });
}

// --- Presence request ---

const presenceTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

export function requestPresence(
  address: string,
): Promise<{ state: 'online' | 'away'; message: string | null } | null> {
  if (!isRelayReady()) return Promise.resolve(null);

  return new Promise((resolve) => {
    const addr = address.toLowerCase();
    const existing = state.pendingPresenceRequests.get(addr) ?? [];
    existing.push(resolve);
    state.pendingPresenceRequests.set(addr, existing);

    if (existing.length === 1 && isRelayReady()) {
      try {
        state.relayWs!.send(
          JSON.stringify({ type: 'get_presence', address: addr }),
        );
      } catch (err) {
        state.pendingPresenceRequests.delete(addr);
        resolve(null);
        return;
      }

      const timeout = setTimeout(() => {
        presenceTimeouts.delete(addr);
        const cbs = state.pendingPresenceRequests.get(addr);
        if (cbs) {
          state.pendingPresenceRequests.delete(addr);
          for (const cb of cbs) cb(null);
        }
      }, 10_000);
      presenceTimeouts.set(addr, timeout);
    }
  });
}

// --- Health watchdog ---

const UNHEALTHY_GRACE_MS = 120_000;
const HEALTH_TICK_MS = 30_000;

export function startHealthWatchdog(): void {
  if (healthWatchdogTimer) clearInterval(healthWatchdogTimer);
  lastHealthyAt = Date.now();
  healthWatchdogTimer = setInterval(() => {
    if (isRelayReady()) {
      lastHealthyAt = Date.now();
      return;
    }

    const unhealthyMs = Date.now() - lastHealthyAt;
    if (unhealthyMs < UNHEALTHY_GRACE_MS) return;

    process.stderr.write(
      `attn: health watchdog triggering recovery — unhealthy for ${Math.floor(unhealthyMs / 1000)}s\n`,
    );
    reconnectDelay = 1000;
    forceCleanupAndReconnect(`health watchdog (${Math.floor(unhealthyMs / 1000)}s stuck)`);
    lastHealthyAt = Date.now();
  }, HEALTH_TICK_MS);
}

export function stopHealthWatchdog(): void {
  if (healthWatchdogTimer) {
    clearInterval(healthWatchdogTimer);
    healthWatchdogTimer = null;
  }
}

// --- Cleanup ---

export function cleanup(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  if (authHandshakeTimer) {
    clearTimeout(authHandshakeTimer);
    authHandshakeTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHealthWatchdog();
  if (state.relayWs) {
    try {
      state.relayWs.close();
    } catch {
      // ignore
    }
  }
}
