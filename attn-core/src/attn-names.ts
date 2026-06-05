import { createPublicClient, createWalletClient, http, formatEther } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { state } from './state.js';
import { ATTN_NAMES_ADDRESS, BASE_RPC_DEFAULT } from './constants.js';

export const attnNamesAbi = [
  { type: 'function', name: 'resolve', inputs: [{ name: 'label', type: 'string' }], outputs: [{ name: 'owner_', type: 'address' }, { name: 'node', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'primaryNameOf', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'available', inputs: [{ name: 'label', type: 'string' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'register', inputs: [{ name: 'label', type: 'string' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'setPrimaryName', inputs: [{ name: 'label', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'clearPrimaryName', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'registrationFee', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'namehash', inputs: [{ name: 'label', type: 'string' }], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'pure' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'ownerOf', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'transferFrom', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'event', name: 'NameRegistered', inputs: [{ name: 'node', type: 'bytes32', indexed: true }, { name: 'label', type: 'string', indexed: false }, { name: 'owner', type: 'address', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: true }] },
] as const;

const NAMES_ADDRESS = ATTN_NAMES_ADDRESS as `0x${string}`;

function getBaseRpcUrl(): string {
  return process.env.ATTN_BASE_RPC ?? BASE_RPC_DEFAULT;
}

function getBasePublicClient() {
  return createPublicClient({ chain: base, transport: http(getBaseRpcUrl()) });
}

function getBaseWalletClient() {
  return createWalletClient({
    chain: base,
    transport: http(getBaseRpcUrl()),
    account: privateKeyToAccount(state.privateKey),
  });
}

function normalizeLabel(input: string): string {
  return input.toLowerCase().replace(/\.attn$/, '');
}

export interface RegisterResult {
  success: boolean;
  tx?: string;
  fee?: string;
  error?: string;
  needsFunding?: boolean;
  fundAddress?: string;
}

export async function handleRegisterName(label: string): Promise<RegisterResult> {
  label = normalizeLabel(label);

  if (label.length < 3 || label.length > 32) {
    return { success: false, error: 'Label must be 3-32 characters' };
  }

  if (!/^[a-z0-9-]+$/.test(label)) {
    return { success: false, error: 'Label must be lowercase a-z, 0-9, and hyphens only' };
  }

  const publicClient = getBasePublicClient();

  try {
    const isAvail = await publicClient.readContract({
      address: NAMES_ADDRESS,
      abi: attnNamesAbi,
      functionName: 'available',
      args: [label],
    });

    if (!isAvail) {
      return { success: false, error: `"${label}.attn" is already taken` };
    }

    const fee = (await publicClient.readContract({
      address: NAMES_ADDRESS,
      abi: attnNamesAbi,
      functionName: 'registrationFee',
    })) as bigint;

    try {
      const walletClient = getBaseWalletClient();
      const hash = await walletClient.writeContract({
        address: NAMES_ADDRESS,
        abi: attnNamesAbi,
        functionName: 'register',
        args: [label],
        value: fee,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      return {
        success: true,
        tx: receipt.transactionHash,
        fee: formatEther(fee),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('insufficient funds')) {
        return {
          success: false,
          error: `Insufficient ETH on Base. Need at least ${formatEther(fee)} ETH + gas.`,
          needsFunding: true,
          fundAddress: state.address,
        };
      }
      return { success: false, error: `Registration failed: ${msg}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `RPC error: ${msg}` };
  }
}

export interface LookupResult {
  success: boolean;
  direction?: 'name-to-address' | 'address-to-name';
  label?: string;
  address?: string;
  connected?: boolean;
  error?: string;
}

export async function handleLookup(query: string): Promise<LookupResult> {
  if (!query) {
    return { success: false, error: 'Query is required' };
  }

  const publicClient = getBasePublicClient();

  try {
    // Forward lookup: name → address
    if (!query.startsWith('0x')) {
      const label = normalizeLabel(query);

      const [owner] = (await publicClient.readContract({
        address: NAMES_ADDRESS,
        abi: attnNamesAbi,
        functionName: 'resolve',
        args: [label],
      })) as [string, string];

      if (owner === '0x0000000000000000000000000000000000000000' || !owner) {
        return { success: false, error: `"${label}.attn" is not registered` };
      }

      return {
        success: true,
        direction: 'name-to-address',
        label: `${label}.attn`,
        address: owner.toLowerCase(),
      };
    }

    // Reverse lookup: address → primary name
    const name = (await publicClient.readContract({
      address: NAMES_ADDRESS,
      abi: attnNamesAbi,
      functionName: 'primaryNameOf',
      args: [query as `0x${string}`],
    })) as string;

    if (!name) {
      return { success: false, error: `No primary .attn name set for ${query}` };
    }

    return {
      success: true,
      direction: 'address-to-name',
      label: `${name}.attn`,
      address: query.toLowerCase(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `RPC error: ${msg}` };
  }
}
