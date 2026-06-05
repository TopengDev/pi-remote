import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { encrypt, decrypt } from 'eciesjs';
import { createHmac } from 'node:crypto';

export function deriveIdentity(privateKey: `0x${string}`): {
  address: string;
  account: PrivateKeyAccount;
} {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address.toLowerCase(),
    account,
  };
}

export function deriveSessionKey(
  rootKey: `0x${string}`,
  sessionName: string,
): `0x${string}` {
  const keyBytes = Buffer.from(rootKey.slice(2), 'hex');
  const derived = createHmac('sha256', keyBytes)
    .update(`attn-session:${sessionName}`)
    .digest('hex');
  return `0x${derived}` as `0x${string}`;
}

export function encryptMessage(
  recipientPublicKey: string,
  plaintext: string,
): string {
  const pubKeyHex = recipientPublicKey.startsWith('0x')
    ? recipientPublicKey.slice(2)
    : recipientPublicKey;
  const data = new TextEncoder().encode(plaintext);
  const encrypted = encrypt(pubKeyHex, data);
  return Buffer.from(encrypted).toString('base64');
}

export function decryptMessage(
  privateKey: `0x${string}`,
  encrypted: string,
): string {
  const privKeyHex = privateKey.startsWith('0x')
    ? privateKey.slice(2)
    : privateKey;
  const data = Uint8Array.from(
    Buffer.from(encrypted, 'base64'),
  );
  const decrypted = decrypt(privKeyHex, data);
  return new TextDecoder().decode(decrypted);
}

export function encryptBinary(
  recipientPublicKey: string,
  data: Uint8Array,
): Uint8Array {
  const pubKeyHex = recipientPublicKey.startsWith('0x')
    ? recipientPublicKey.slice(2)
    : recipientPublicKey;
  return encrypt(pubKeyHex, data);
}

export function decryptBinary(
  privateKey: `0x${string}`,
  encrypted: Uint8Array,
): Uint8Array {
  const privKeyHex = privateKey.startsWith('0x')
    ? privateKey.slice(2)
    : privateKey;
  return decrypt(privKeyHex, encrypted);
}

function serializeEnvelope(envelope: {
  id: string;
  to: string;
  encrypted: string;
}): string {
  return JSON.stringify({
    id: envelope.id,
    to: envelope.to,
    encrypted: envelope.encrypted,
  });
}

export async function signEnvelope(
  account: PrivateKeyAccount,
  envelope: { id: string; to: string; encrypted: string },
): Promise<string> {
  return account.signMessage({ message: serializeEnvelope(envelope) });
}

export async function verifyEnvelope(
  from: string,
  envelope: { id: string; to: string; encrypted: string },
  signature: `0x${string}`,
): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({
      message: serializeEnvelope(envelope),
      signature,
    });
    return recovered.toLowerCase() === from.toLowerCase();
  } catch {
    return false;
  }
}
