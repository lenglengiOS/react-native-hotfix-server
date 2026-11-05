import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOTFIX_PROTOCOL_VERSION,
  isCompatibleClient,
  validateManifest,
} from 'react-native-hotfix-protocol';

import { HotfixStorage } from './storage.mjs';

const JSON_BODY_LIMIT = 1024 * 1024;
const ADMIN_PREFIX = '/v1/admin';
const UPDATES_PREFIX = '/v1/updates/';

function sendJson(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendError(response, status, code, message) {
  sendJson(response, status, {
    error: {
      code,
      message,
    },
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_BODY_LIMIT) {
      throw new RangeError('Request body is too large');
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw new TypeError('Request body is required');
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(request, token) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return false;
  }
  const provided = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function clientIsInRollout(clientId, updateId, rolloutPercent) {
  if (rolloutPercent >= 100) {
    return true;
  }
  if (rolloutPercent <= 0) {
    return false;
  }
  const digest = createHash('sha256')
    .update(`${clientId || 'anonymous'}:${updateId}`)
    .digest();
  return digest.readUInt32BE(0) % 100 < rolloutPercent;
}

function validateQueryIdentity({ channel, platform, runtimeVersion }) {
  validateManifest({
    protocolVersion: HOTFIX_PROTOCOL_VERSION,
    id: 'validation',
    createdAt: new Date(0).toISOString(),
    runtimeVersion,
    channel,
    platform,
    launchAsset: {
      path: 'validation',
      hash: `sha256:${'0'.repeat(64)}`,
      size: 0,
      contentType: 'application/octet-stream',
    },
    assets: [],
    metadata: {},
    rollback: { maxFailedLaunches: 2 },
  });
}

function publicBaseUrl(request, configuredBaseUrl) {
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, '');
  }
  const protocol = request.socket.encrypted ? 'https' : 'http';
  return `${protocol}://${request.headers.host}`;
}

async function serveAsset(response, storage, url, baseUrl) {
  const rawPath = url.pathname.slice(UPDATES_PREFIX.length);
  const segments = rawPath.split('/');
  if (segments.length < 5) {
    return sendError(response, 404, 'not_found', 'Update file was not found');
  }

  const [channel, platform, runtimeVersion, updateId] = segments.map(decodeURIComponent);
  const relativePath = segments.slice(4).map(decodeURIComponent).join('/');
  let published;
  try {
    published = await storage.getPublishedUpdate({
      channel,
      platform,
      runtimeVersion,
      updateId,
    });
  } catch (error) {
    return sendError(response, 400, 'invalid_path', error.message);
  }
  if (!published) {
    return sendError(response, 404, 'not_found', 'Update was not found');
  }

  const descriptor = [
    published.manifest.launchAsset,
    ...published.manifest.assets,
  ].find(asset => asset.path === relativePath);
  if (!descriptor) {
    return sendError(response, 404, 'not_found', 'Update file was not found');
  }

  let file;
  try {
    file = storage.resolvePublishedFile(published.dir, relativePath);
  } catch (error) {
    return sendError(response, 400, 'invalid_path', error.message);
  }

  response.writeHead(200, {
    'content-type': descriptor.contentType,
    'content-length': descriptor.size,
    'cache-control': 'public, max-age=31536000, immutable',
    etag: `"${descriptor.hash}"`,
    'x-content-type-options': 'nosniff',
    'x-hotfix-file': encodeURIComponent(descriptor.path),
    'x-hotfix-base-url': baseUrl,
  });
  createReadStream(file).pipe(response);
}

export function createHotfixServer({
  storageDir,
  privateKey,
  adminToken,
  baseUrl,
  maxUpdateBytes = 200 * 1024 * 1024,
}) {
  if (!adminToken || adminToken.length < 16) {
    throw new TypeError('adminToken must contain at least 16 characters');
  }
  const storage = new HotfixStorage({
    root: storageDir,
    privateKey,
    maxUpdateBytes,
  });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const method = request.method || 'GET';
      const requestBaseUrl = publicBaseUrl(request, baseUrl);

      if (method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { ok: true });
      }

      if (method === 'GET' && url.pathname === '/v1/check') {
        const channel = url.searchParams.get('channel');
        const platform = url.searchParams.get('platform');
        const runtimeVersion = url.searchParams.get('runtimeVersion');
        try {
          validateQueryIdentity({ channel, platform, runtimeVersion });
        } catch (error) {
          return sendError(response, 400, 'invalid_request', error.message);
        }

        const protocol = request.headers['x-hotfix-protocol-version'];
        if (protocol !== String(HOTFIX_PROTOCOL_VERSION)) {
          return sendError(response, 400, 'unsupported_protocol', 'Unsupported client protocol');
        }

        const release = await storage.getChannelRelease(channel, platform, runtimeVersion);
        if (
          !release ||
          !clientIsInRollout(
            request.headers['x-hotfix-client-id'],
            release.updateId,
            release.rolloutPercent,
          ) ||
          request.headers['x-hotfix-current-update-id'] === release.updateId
        ) {
          response.writeHead(204, { 'cache-control': 'no-store' });
          return response.end();
        }

        const published = await storage.getPublishedUpdate({
          channel,
          platform,
          runtimeVersion,
          updateId: release.updateId,
        });
        if (!published || !isCompatibleClient({
          manifest: published.manifest,
          runtimeVersion,
          channel,
          platform,
        })) {
          return sendError(response, 409, 'invalid_release', 'Active release is invalid');
        }

        return sendJson(response, 200, {
          updateId: published.manifest.id,
          createdAt: published.manifest.createdAt,
          payload: published.envelope.payload,
          signature: published.envelope.signature,
          keyId: published.envelope.keyId,
          assetBaseUrl: `${requestBaseUrl}${UPDATES_PREFIX}${encodeURIComponent(
            channel,
          )}/${platform}/${encodeURIComponent(runtimeVersion)}/${encodeURIComponent(
            published.manifest.id,
          )}`,
        });
      }

      if (method === 'GET' && url.pathname.startsWith(UPDATES_PREFIX)) {
        return await serveAsset(response, storage, url, requestBaseUrl);
      }

      if (url.pathname.startsWith(ADMIN_PREFIX) && !authorized(request, adminToken)) {
        return sendError(response, 401, 'unauthorized', 'A valid admin token is required');
      }

      if (method === 'POST' && url.pathname === '/v1/admin/updates') {
        const body = await readJsonBody(request);
        const manifest = validateManifest(body.manifest);
        const upload = await storage.beginUpload({
          manifest,
          rolloutPercent: body.rolloutPercent,
        });
        return sendJson(response, 201, {
          uploadId: upload.uploadId,
          files: upload.filePaths.map(filePath => ({
            path: filePath,
            url: `/v1/admin/updates/${upload.uploadId}/files?path=${encodeURIComponent(
              filePath,
            )}`,
          })),
        });
      }

      const uploadMatch = url.pathname.match(
        /^\/v1\/admin\/updates\/([a-zA-Z0-9-]+)\/files$/,
      );
      if (method === 'PUT' && uploadMatch) {
        const filePath = url.searchParams.get('path');
        const result = await storage.receiveFile(
          uploadMatch[1],
          filePath,
          request,
        );
        return sendJson(response, 200, result);
      }

      const commitMatch = url.pathname.match(
        /^\/v1\/admin\/updates\/([a-zA-Z0-9-]+)\/commit$/,
      );
      if (method === 'POST' && commitMatch) {
        const result = await storage.commitUpload(commitMatch[1]);
        return sendJson(response, 200, result);
      }

      if (method === 'POST' && url.pathname === '/v1/admin/channels/activate') {
        const body = await readJsonBody(request);
        await storage.activateRelease(body);
        return sendJson(response, 200, { ok: true });
      }

      return sendError(response, 404, 'not_found', 'Route was not found');
    } catch (error) {
      const status =
        error instanceof RangeError
          ? 413
          : error instanceof SyntaxError || error instanceof TypeError
            ? 400
            : 500;
      if (status === 500) {
        console.error(error);
      }
      if (!response.headersSent) {
        return sendError(response, status, status === 500 ? 'internal_error' : 'invalid_request', error.message);
      }
      response.destroy();
    }
  });

  return {
    server,
    storage,
    async listen(port = 3000, host = '0.0.0.0') {
      await storage.initialize();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      if (!server.listening) {
        return;
      }
      await new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => (error ? reject(error) : resolve()));
      });
    },
  };
}

export const serverModulePath = fileURLToPath(import.meta.url);
export const serverModuleDir = path.dirname(serverModulePath);
