import assert from 'node:assert/strict';
import { createHash, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalJson,
  createUpdateManifest,
} from 'react-native-hotfix-protocol';

import { createHotfixServer } from '../src/server.mjs';
import { generateSigningKeys } from '../src/signing.mjs';

const adminToken = 'test-admin-token-123456';

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null,
  };
}

test('publishes, serves, and signs an update', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'hotfix-server-'));
  const keys = generateSigningKeys(2048);
  const bundle = Buffer.from('function hello() { return 42; }\n');
  const hash = `sha256:${createHash('sha256').update(bundle).digest('hex')}`;
  const manifest = createUpdateManifest({
    id: 'test-update-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    runtimeVersion: '1.0.0',
    channel: 'production',
    platform: 'ios',
    launchAsset: {
      path: 'main.jsbundle',
      hash,
      size: bundle.length,
      contentType: 'application/octet-stream',
    },
    assets: [],
    metadata: { label: 'first update' },
  });

  const instance = createHotfixServer({
    storageDir: root,
    privateKey: keys.privateKey,
    adminToken,
  });
  await instance.listen(0, '127.0.0.1');
  const address = instance.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  });

  const started = await requestJson(`${baseUrl}/v1/admin/updates`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ manifest, rolloutPercent: 100 }),
  });
  assert.equal(started.response.status, 201);

  const uploadUrl = `${baseUrl}${started.body.files[0].url}`;
  const uploaded = await requestJson(uploadUrl, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/octet-stream',
    },
    body: bundle,
  });
  assert.equal(uploaded.response.status, 200);

  const committed = await requestJson(
    `${baseUrl}/v1/admin/updates/${started.body.uploadId}/commit`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    },
  );
  assert.equal(committed.response.status, 200);

  const checked = await requestJson(
    `${baseUrl}/v1/check?channel=production&platform=ios&runtimeVersion=1.0.0`,
    {
      headers: {
        'x-hotfix-protocol-version': '1',
        'x-hotfix-client-id': 'client-1',
      },
    },
  );
  assert.equal(checked.response.status, 200);
  assert.equal(checked.body.updateId, manifest.id);

  const payload = Buffer.from(checked.body.payload, 'base64');
  assert.equal(payload.toString('utf8'), canonicalJson(manifest));
  assert.equal(
    verify(
      'RSA-SHA256',
      payload,
      keys.publicKey,
      Buffer.from(checked.body.signature.value, 'base64'),
    ),
    true,
  );

  const downloaded = await fetch(
    `${checked.body.assetBaseUrl}/${checked.body ? 'main.jsbundle' : ''}`,
  );
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bundle);
});

test('returns 204 when the client already has the active update', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'hotfix-server-'));
  const keys = generateSigningKeys(2048);
  const instance = createHotfixServer({
    storageDir: root,
    privateKey: keys.privateKey,
    adminToken,
  });
  await instance.listen(0, '127.0.0.1');
  const port = instance.server.address().port;
  t.after(async () => {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  });

  const checked = await fetch(
    `http://127.0.0.1:${port}/v1/check?channel=production&platform=android&runtimeVersion=1.0.0`,
    {
      headers: { 'x-hotfix-protocol-version': '1' },
    },
  );
  assert.equal(checked.status, 204);
});
