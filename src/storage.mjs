import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
} from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  assertSafeRelativePath,
  createUpdateManifest,
  encodedAssetPath,
  validateManifest,
} from 'react-native-hotfix-protocol';

import { createSignedManifest } from './signing.mjs';

async function exists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

function assertSegment(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function resolveInside(root, relativePath) {
  assertSafeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, ...relativePath.split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new TypeError(`Path escapes storage root: ${relativePath}`);
  }
  return resolved;
}

export class HotfixStorage {
  constructor({ root, privateKey, maxUpdateBytes = 200 * 1024 * 1024 }) {
    this.root = path.resolve(root);
    this.privateKey = privateKey;
    this.maxUpdateBytes = maxUpdateBytes;
  }

  async initialize() {
    await mkdir(path.join(this.root, 'pending'), { recursive: true });
    await mkdir(path.join(this.root, 'published'), { recursive: true });
    await mkdir(path.join(this.root, 'channels'), { recursive: true });
  }

  pendingDir(uploadId) {
    assertSegment(uploadId, 'uploadId');
    return path.join(this.root, 'pending', uploadId);
  }

  publishedDir(manifest) {
    this.assertCoordinates(manifest.channel, manifest.platform, manifest.runtimeVersion);
    return path.join(
      this.root,
      'published',
      manifest.channel,
      manifest.platform,
      manifest.runtimeVersion,
      manifest.id,
    );
  }

  channelPath(channel, platform, runtimeVersion) {
    this.assertCoordinates(channel, platform, runtimeVersion);
    return path.join(
      this.root,
      'channels',
      channel,
      platform,
      `${runtimeVersion}.json`,
    );
  }

  async beginUpload({ manifest, rolloutPercent = 100 }) {
    validateManifest(manifest);
    this.assertUpdateSizes(manifest);
    if (
      !Number.isInteger(rolloutPercent) ||
      rolloutPercent < 0 ||
      rolloutPercent > 100
    ) {
      throw new TypeError('rolloutPercent must be an integer from 0 to 100');
    }

    const uploadId = randomUUID();
    const dir = this.pendingDir(uploadId);
    await mkdir(path.join(dir, 'files'), { recursive: true });
    await writeJsonAtomic(path.join(dir, 'record.json'), {
      uploadId,
      manifest,
      rolloutPercent,
      createdAt: new Date().toISOString(),
    });

    return {
      uploadId,
      filePaths: [
        manifest.launchAsset.path,
        ...manifest.assets.map(asset => asset.path),
      ],
    };
  }

  async receiveFile(uploadId, relativePath, readable) {
    assertSafeRelativePath(relativePath);
    const pendingDir = this.pendingDir(uploadId);
    const record = await readJson(path.join(pendingDir, 'record.json'));
    const descriptors = [record.manifest.launchAsset, ...record.manifest.assets];
    const descriptor = descriptors.find(asset => asset.path === relativePath);
    if (!descriptor) {
      throw new TypeError(`File is not declared by the pending manifest: ${relativePath}`);
    }

    const destination = resolveInside(path.join(pendingDir, 'files'), relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.upload`;
    const hash = createHash('sha256');
    let size = 0;

    try {
      await pipeline(
        readable,
        async function* enforceLimit(source) {
          for await (const chunk of source) {
            size += chunk.length;
            if (
              size > descriptor.size ||
              size > this.maxUpdateBytes
            ) {
              throw new RangeError(`Uploaded file exceeds declared size: ${relativePath}`);
            }
            hash.update(chunk);
            yield chunk;
          }
        }.bind(this),
        createWriteStream(temporary, { flags: 'wx' }),
      );

      if (size !== descriptor.size) {
        throw new RangeError(
          `Uploaded file size mismatch for ${relativePath}: expected ${descriptor.size}, got ${size}`,
        );
      }
      const digest = `sha256:${hash.digest('hex')}`;
      if (digest !== descriptor.hash) {
        throw new RangeError(`Uploaded file hash mismatch for ${relativePath}`);
      }
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    return {
      path: relativePath,
      size,
      hash: descriptor.hash,
    };
  }

  assertUpdateSizes(manifest) {
    const total = [manifest.launchAsset, ...manifest.assets].reduce(
      (sum, asset) => sum + asset.size,
      0,
    );
    if (total > this.maxUpdateBytes) {
      throw new RangeError(`Update exceeds maximum size of ${this.maxUpdateBytes} bytes`);
    }
  }

  async commitUpload(uploadId) {
    const pendingDir = this.pendingDir(uploadId);
    const record = await readJson(path.join(pendingDir, 'record.json'));
    const manifest = validateManifest(record.manifest);
    const descriptors = [manifest.launchAsset, ...manifest.assets];

    for (const descriptor of descriptors) {
      const file = resolveInside(path.join(pendingDir, 'files'), descriptor.path);
      let metadata;
      try {
        metadata = await stat(file);
      } catch {
        throw new TypeError(`Missing update file: ${descriptor.path}`);
      }
      if (!metadata.isFile() || metadata.size !== descriptor.size) {
        throw new TypeError(`Invalid update file: ${descriptor.path}`);
      }
      const hash = createHash('sha256');
      await pipeline(createReadStream(file), hash);
      const digest = `sha256:${hash.digest('hex')}`;
      if (digest !== descriptor.hash) {
        throw new TypeError(`Hash mismatch for update file: ${descriptor.path}`);
      }
    }

    const envelope = createSignedManifest(manifest, this.privateKey);
    const updateDir = this.publishedDir(manifest);
    await mkdir(path.dirname(updateDir), { recursive: true });
    if (await exists(updateDir)) {
      throw new TypeError(`Update already exists: ${manifest.id}`);
    }
    await rename(pendingDir, updateDir);
    await writeJsonAtomic(path.join(updateDir, 'update.json'), envelope);

    await writeJsonAtomic(
      this.channelPath(manifest.channel, manifest.platform, manifest.runtimeVersion),
      {
        updateId: manifest.id,
        rolloutPercent: record.rolloutPercent,
        publishedAt: new Date().toISOString(),
      },
    );

    return {
      updateId: manifest.id,
      keyId: envelope.keyId,
      rolloutPercent: record.rolloutPercent,
    };
  }

  async getChannelRelease(channel, platform, runtimeVersion) {
    const target = this.channelPath(channel, platform, runtimeVersion);
    if (!(await exists(target))) {
      return null;
    }
    return readJson(target);
  }

  async getPublishedUpdate({ channel, platform, runtimeVersion, updateId }) {
    this.assertCoordinates(channel, platform, runtimeVersion);
    assertSegment(updateId, 'updateId');
    const dir = path.join(
      this.root,
      'published',
      channel,
      platform,
      runtimeVersion,
      updateId,
    );
    const envelopePath = path.join(dir, 'update.json');
    if (!(await exists(envelopePath))) {
      return null;
    }
    const envelope = await readJson(envelopePath);
    const manifest = JSON.parse(
      Buffer.from(envelope.payload, 'base64').toString('utf8'),
    );
    if (
      manifest.channel !== channel ||
      manifest.platform !== platform ||
      manifest.runtimeVersion !== runtimeVersion ||
      manifest.id !== updateId
    ) {
      throw new Error('Published update metadata does not match its storage location');
    }
    return {
      envelope,
      manifest,
      dir: path.join(dir, 'files'),
    };
  }

  resolvePublishedFile(dir, relativePath) {
    return resolveInside(dir, relativePath);
  }

  assertCoordinates(channel, platform, runtimeVersion) {
    assertSegment(channel, 'channel');
    assertSegment(runtimeVersion, 'runtimeVersion');
    if (platform !== 'ios' && platform !== 'android') {
      throw new TypeError('platform must be ios or android');
    }
  }

  assetURL(baseUrl, manifest, relativePath) {
    return `${baseUrl}/v1/updates/${encodeURIComponent(
      manifest.channel,
    )}/${manifest.platform}/${encodeURIComponent(
      manifest.runtimeVersion,
    )}/${encodeURIComponent(manifest.id)}/${encodedAssetPath(relativePath)}`;
  }

  async activateRelease({
    channel,
    platform,
    runtimeVersion,
    updateId,
    rolloutPercent = 100,
  }) {
    const published = await this.getPublishedUpdate({
      channel,
      platform,
      runtimeVersion,
      updateId,
    });
    if (!published) {
      throw new TypeError('Published update was not found');
    }
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
      throw new TypeError('rolloutPercent must be an integer from 0 to 100');
    }
    await writeJsonAtomic(
      this.channelPath(channel, platform, runtimeVersion),
      {
        updateId,
        rolloutPercent,
        publishedAt: new Date().toISOString(),
      },
    );
  }
}

export function manifestFromDescriptors({
  id,
  runtimeVersion,
  channel,
  platform,
  descriptors,
  launchPath,
  metadata,
  maxFailedLaunches,
}) {
  const launchAsset = descriptors.find(asset => asset.path === launchPath);
  if (!launchAsset) {
    throw new TypeError(`Launch asset not found: ${launchPath}`);
  }
  return createUpdateManifest({
    id,
    runtimeVersion,
    channel,
    platform,
    launchAsset,
    assets: descriptors.filter(asset => asset.path !== launchPath),
    metadata,
    maxFailedLaunches,
  });
}
