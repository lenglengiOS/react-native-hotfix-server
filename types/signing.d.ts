import type { HotfixManifest } from 'react-native-hotfix-protocol';

export interface SigningKeys {
  publicKey: string;
  privateKey: string;
  keyId: string;
}

export interface SignedManifest {
  protocolVersion: 1;
  keyId: string;
  payload: string;
  signature: {
    algorithm: 'rsa-sha256';
    value: string;
  };
}

export function generateSigningKeys(modulusLength?: number): SigningKeys;
export function keyIdForPublicKey(publicKeyPem: string): string;
export function publicKeyFromPrivateKey(privateKeyPem: string): string;
export function createSignedManifest(
  manifest: HotfixManifest,
  privateKeyPem: string,
): SignedManifest;
