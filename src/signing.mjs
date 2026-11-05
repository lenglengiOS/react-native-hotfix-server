import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';

import { canonicalJson } from 'react-native-hotfix-protocol';

export function generateSigningKeys(modulusLength = 3072) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  return {
    publicKey,
    privateKey,
    keyId: keyIdForPublicKey(publicKey),
  };
}

export function keyIdForPublicKey(publicKeyPem) {
  const publicKey = createPublicKey(publicKeyPem);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function publicKeyFromPrivateKey(privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  return createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

export function createSignedManifest(manifest, privateKeyPem) {
  const payload = Buffer.from(canonicalJson(manifest), 'utf8');
  const signature = sign('RSA-SHA256', payload, privateKeyPem).toString('base64');
  const keyId = keyIdForPublicKey(publicKeyFromPrivateKey(privateKeyPem));

  return {
    protocolVersion: 1,
    keyId,
    payload: payload.toString('base64'),
    signature: {
      algorithm: 'rsa-sha256',
      value: signature,
    },
  };
}
