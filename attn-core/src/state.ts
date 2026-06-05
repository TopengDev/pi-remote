import type { PrivateKeyAccount } from 'viem/accounts';
import WebSocket from 'ws';

export type PresenceState = 'online' | 'away';

export interface DaemonState {
  address: string;
  account: PrivateKeyAccount | null;
  privateKey: `0x${string}`;
  keyCache: Map<string, string>;
  relayWs: import('ws').WebSocket | null;
  authenticated: boolean;
  lastPongAt: number;
  lastInboundFrom: string | null;
  lastInboundMessageId: string | null;
  pendingKeyRequests: Map<string, Array<(key: string | null) => void>>;
  pendingPresenceRequests: Map<string, Array<(res: { state: 'online' | 'away'; message: string | null } | null) => void>>;
  presence: PresenceState;
}

export const state: DaemonState = {
  address: '',
  account: null,
  privateKey: '' as `0x${string}`,
  keyCache: new Map<string, string>(),
  relayWs: null,
  authenticated: false,
  lastPongAt: 0,
  lastInboundFrom: null,
  lastInboundMessageId: null,
  pendingKeyRequests: new Map<string, Array<(key: string | null) => void>>(),
  pendingPresenceRequests: new Map(),
  presence: 'online',
};

export function isRelayReady(): boolean {
  return (
    state.relayWs !== null &&
    state.relayWs.readyState === WebSocket.OPEN &&
    state.authenticated
  );
}
