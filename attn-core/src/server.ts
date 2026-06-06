import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { state, isRelayReady } from './state.js';
import {
  encryptMessage,
  signEnvelope,
  decryptMessage,
  encryptBinary,
} from './crypto.js';
import {
  saveMessage,
  getHistory,
  addContact,
  getContacts,
  getContactName,
  removeContact,
  getKeyCache,
  saveOutbox,
} from './db.js';
import { requestKey, requestPresence } from './relay.js';
import { DAEMON_PORT } from './constants.js';
import { handleRegisterName, handleLookup } from './attn-names.js';

// --- Connected pi clients ---

const sessions = new Map<string, WebSocket>();
const unnamedClients = new Set<WebSocket>();

// --- Broadcast to all pi clients ---

const PRIMARY_SESSION = 'main';

export function broadcastInbound(event: object): void {
  const data = JSON.stringify(event);
  // Only deliver remote relay messages to the primary (main) session.
  // Workers use local message routing (type: 'local') for inter-session comms.
  const primary = sessions.get(PRIMARY_SESSION);
  if (primary && primary.readyState === WebSocket.OPEN) {
    try {
      primary.send(data);
    } catch {
      // ignore
    }
  }
}

// --- HTTP handler ---

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
  });
}

function sendJson(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendError(
  res: http.ServerResponse,
  message: string,
  status = 400,
): void {
  sendJson(res, { error: message }, status);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${DAEMON_PORT}`);
  const path = url.pathname;

  try {
    // POST /send — { to, message }
    if (req.method === 'POST' && path === '/send') {
      const body = await parseBody(req);
      const { to, message } = JSON.parse(body) as {
        to: string;
        message: string;
      };

      if (!to || !message) {
        return sendError(res, 'to and message are required');
      }

      if (!isRelayReady()) {
        return sendError(res, 'Not connected to relay', 503);
      }

      // Resolve .attn name via HTTP if needed
      let resolvedTo = to;
      let viaHttp = false;
      if (!to.startsWith('0x')) {
        const label = to.toLowerCase().replace(/\.attn$/, '');
        try {
          const httpRes = await fetch(
            `https://attn.s0nderlabs.xyz/resolve?name=${label}`,
          );
          if (httpRes.ok) {
            const data = (await httpRes.json()) as { address?: string };
            if (data.address) {
              resolvedTo = data.address;
              viaHttp = true;
            }
          }
        } catch {
          // HTTP resolution failed
        }
        if (resolvedTo === to) {
          return sendError(
            res,
            `Could not resolve .attn name "${to}"`,
            404,
          );
        }
      }
      const publicKey = await requestKey(resolvedTo);
      if (!publicKey) {
        return sendError(
          res,
          `Could not find public key for ${to}`,
          404,
        );
      }

      const encrypted = encryptMessage(publicKey, message);
      const id = crypto.randomUUID();
      const envelope = {
        id,
        to: resolvedTo.toLowerCase(),
        encrypted,
      };
      const signature = await signEnvelope(state.account!, envelope);

      try {
        state.relayWs!.send(
          JSON.stringify({
            type: 'message',
            id,
            to: resolvedTo.toLowerCase(),
            encrypted,
            signature,
          }),
        );
      } catch {
        saveOutbox({
          id,
          to_address: to.toLowerCase(),
          encrypted,
          signature,
          ts: Date.now(),
        });
      }

      saveMessage({
        id,
        peer: to,
        direction: 'outbound',
        content: message,
        ts: new Date().toISOString(),
      });

      return sendJson(res, { id, status: 'sent' });
    }

    // POST /send-file — { to, filename, data: base64-encoded bytes }
    if (req.method === 'POST' && path === '/send-file') {
      const body = await parseBody(req);
      const { to, filename, data } = JSON.parse(body) as {
        to: string;
        filename: string;
        data: string;
      };

      if (!to || !filename || !data) {
        return sendError(res, 'to, filename, and data are required');
      }

      if (!isRelayReady()) {
        return sendError(res, 'Not connected to relay', 503);
      }

      // Resolve .attn name via HTTP if needed
      let resolvedTo = to;
      if (!to.startsWith('0x')) {
        const label = to.toLowerCase().replace(/\.attn$/, '');
        try {
          const httpRes = await fetch(
            `https://attn.s0nderlabs.xyz/resolve?name=${label}`,
          );
          if (httpRes.ok) {
            const resData = (await httpRes.json()) as { address?: string };
            if (resData.address) {
              resolvedTo = resData.address;
            }
          }
        } catch {
          // HTTP resolution failed
        }
        if (resolvedTo === to) {
          return sendError(
            res,
            `Could not resolve .attn name "${to}"`,
            404,
          );
        }
      }

      const publicKey = await requestKey(resolvedTo);
      if (!publicKey) {
        return sendError(
          res,
          `Could not find public key for ${to}`,
          404,
        );
      }

      // Decode base64 → encrypt binary
      const fileBuffer = Buffer.from(data, 'base64');
      const encrypted = encryptBinary(publicKey, fileBuffer);

      // Generate file key and upload to relay
      const fileKey = crypto.randomUUID();
      const timestamp = Date.now().toString();
      const method = 'POST';
      const uploadPath = '/upload';
      const authMessage = `${method}:${uploadPath}:${timestamp}`;
      const signature = await state.account!.signMessage({
        message: authMessage,
      });

      const uploadRes = await fetch('https://attn.s0nderlabs.xyz/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Attn-Address': state.address,
          'X-Attn-Timestamp': timestamp,
          'X-Attn-Signature': signature,
          'X-File-Key': fileKey,
        },
        body: Buffer.from(encrypted),
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        return sendError(res, `Upload failed: ${errText}`, 502);
      }

      // Send file message via relay WebSocket
      const id = crypto.randomUUID();
      const fileUrl = `https://attn.s0nderlabs.xyz/files/${fileKey}`;

      try {
        state.relayWs!.send(
          JSON.stringify({
            type: 'file',
            id,
            to: resolvedTo.toLowerCase(),
            url: fileUrl,
            key: fileKey,
            filename,
          }),
        );
      } catch {
        return sendError(res, 'Failed to send file message via relay', 502);
      }

      return sendJson(res, { id, url: fileUrl, key: fileKey, filename, status: 'sent' });
    }

    // GET /peers
    if (req.method === 'GET' && path === '/peers') {
      const peers = getContacts();
      return sendJson(res, { peers });
    }

    // GET /local-peers
    if (req.method === 'GET' && path === '/local-peers') {
      const sessionList = Array.from(sessions.keys());
      return sendJson(res, { sessions: sessionList, count: sessionList.length });
    }

    // GET /history?with=ADDR&limit=N
    if (req.method === 'GET' && path === '/history') {
      const peer = url.searchParams.get('with');
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);

      if (!peer) {
        return sendError(res, 'with parameter is required');
      }

      const messages = getHistory(peer, limit);
      return sendJson(res, { messages });
    }

    // POST /contacts — { address, name? }
    if (req.method === 'POST' && path === '/contacts') {
      const body = await parseBody(req);
      const { address, name } = JSON.parse(body) as {
        address: string;
        name?: string;
      };

      if (!address) {
        return sendError(res, 'address is required');
      }

      addContact(address, name);
      return sendJson(res, { status: 'added', address });
    }

    // DELETE /contacts/:address
    if (req.method === 'DELETE' && path.startsWith('/contacts/')) {
      const address = path.slice('/contacts/'.length);
      removeContact(address);
      return sendJson(res, { status: 'removed', address });
    }

    // POST /register-name — { label }
    if (req.method === 'POST' && path === '/register-name') {
      const body = await parseBody(req);
      const { label } = JSON.parse(body) as { label: string };

      if (!label) {
        return sendError(res, 'label is required');
      }

      const result = await handleRegisterName(label);
      return sendJson(res, result, result.success ? 200 : 400);
    }

    // GET /lookup?name=X
    if (req.method === 'GET' && path === '/lookup') {
      const name = url.searchParams.get('name');

      if (!name) {
        return sendError(res, 'name parameter is required');
      }

      const result = await handleLookup(name);
      return sendJson(res, result, result.success ? 200 : 404);
    }

    // GET /presence?address=X
    if (req.method === 'GET' && path === '/presence') {
      const address = url.searchParams.get('address');

      if (!address) {
        return sendError(res, 'address parameter is required');
      }

      if (!isRelayReady()) {
        return sendError(res, 'Not connected to relay', 503);
      }

      const result = await requestPresence(address);
      if (!result) {
        return sendJson(res, { address, online: false, status: 'unknown' });
      }

      return sendJson(res, {
        address: address.toLowerCase(),
        online: result.state === 'online',
        status: result.state,
        message: result.message,
      });
    }

    // GET /status
    if (req.method === 'GET' && path === '/status') {
      return sendJson(res, {
        address: state.address,
        relayConnected: isRelayReady(),
        peers: getContacts().length,
      });
    }

    // 404
    return sendError(res, 'Not found', 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendError(res, message, 500);
  }
}

// --- Start server ---

export function startServer(): http.Server {
  const server = http.createServer(handleRequest);

  // WebSocket server on same port
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req) => {
    // Parse session name from query param
    let sessionName: string | null = null;
    try {
      const url = new URL(req.url || '/', `http://localhost:${DAEMON_PORT}`);
      sessionName = url.searchParams.get('session');
    } catch {
      // ignore
    }

    if (sessionName) {
      sessions.set(sessionName, ws);
    } else {
      unnamedClients.add(ws);
    }

    // Send current status on connect
    try {
      ws.send(
        JSON.stringify({
          type: 'status',
          address: state.address,
          relayConnected: isRelayReady(),
          session: sessionName,
        }),
      );
    } catch {
      // ignore
    }

    // Handle incoming messages from pi extensions
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          to?: string;
          message?: string;
          [key: string]: unknown;
        };

        // Local message routing
        if (msg.type === 'local' && msg.to && msg.message) {
          const target = sessions.get(msg.to);
          if (target && target.readyState === WebSocket.OPEN) {
            const fromSession = sessionName || 'unknown';
            target.send(
              JSON.stringify({
                type: 'message',
                from: fromSession,
                message: msg.message,
                id: crypto.randomUUID(),
                ts: Date.now(),
                local: true,
              }),
            );
            // Acknowledge to sender
            ws.send(
              JSON.stringify({
                type: 'local-ack',
                to: msg.to,
                status: 'delivered',
              }),
            );
          } else {
            ws.send(
              JSON.stringify({
                type: 'local-ack',
                to: msg.to,
                status: 'offline',
              }),
            );
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on('close', () => {
      if (sessionName) {
        sessions.delete(sessionName);
      } else {
        unnamedClients.delete(ws);
      }
    });

    ws.on('error', () => {
      if (sessionName) {
        sessions.delete(sessionName);
      } else {
        unnamedClients.delete(ws);
      }
    });
  });

  server.listen(DAEMON_PORT, '127.0.0.1', () => {
    process.stderr.write(
      `attn: daemon listening on http://127.0.0.1:${DAEMON_PORT}\n`,
    );
  });

  return server;
}
