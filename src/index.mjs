#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createHotfixServer } from './server.mjs';
import { keyIdForPublicKey, publicKeyFromPrivateKey } from './signing.mjs';

function usage() {
  console.log(`React Native Hotfix server

Environment:
  HOTFIX_STORAGE_DIR   Update storage directory (default: .hotfix/server)
  HOTFIX_PRIVATE_KEY   Path to the RSA private key in PEM format (required)
  HOTFIX_ADMIN_TOKEN   Admin bearer token, at least 16 characters (required)
  HOTFIX_BASE_URL      Public server origin used in download URLs
  HOTFIX_MAX_BYTES     Maximum total update size in bytes
  HOST                 Listen address (default: 0.0.0.0)
  PORT                 Listen port (default: 3000)

Generate keys with:
  node packages/hotfix-cli/bin/hotfix.mjs keys generate --out .hotfix/keys
`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage();
  process.exit(0);
}

const privateKeyPath = process.env.HOTFIX_PRIVATE_KEY;
const adminToken = process.env.HOTFIX_ADMIN_TOKEN;
if (!privateKeyPath || !adminToken) {
  usage();
  console.error('\nHOTFIX_PRIVATE_KEY and HOTFIX_ADMIN_TOKEN are required.');
  process.exit(1);
}

const privateKey = await readFile(path.resolve(privateKeyPath), 'utf8');
const publicKey = publicKeyFromPrivateKey(privateKey);
const keyId = keyIdForPublicKey(publicKey);

const hotfixServer = createHotfixServer({
  storageDir: process.env.HOTFIX_STORAGE_DIR || '.hotfix/server',
  privateKey,
  adminToken,
  baseUrl: process.env.HOTFIX_BASE_URL,
  maxUpdateBytes: process.env.HOTFIX_MAX_BYTES
    ? Number(process.env.HOTFIX_MAX_BYTES)
    : undefined,
});

const address = await hotfixServer.listen(
  Number(process.env.PORT || 3000),
  process.env.HOST || '0.0.0.0',
);
console.log(
  `React Native Hotfix server listening on http://${address.address}:${address.port}`,
);
console.log(`Signing key id: ${keyId}`);

async function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down.`);
  await hotfixServer.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
