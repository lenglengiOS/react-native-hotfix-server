# React Native Hotfix Server

**English** | [简体中文](README.zh-CN.md)

Single-node, self-hosted update server for React Native Hotfix. This README is
also the complete private deployment guide.

## Install

```sh
npm install react-native-hotfix-server@0.1.3
npm install -D react-native-hotfix-cli@0.1.3
```

Generate signing keys, then start the server:

```sh
npx hotfix keys generate --out .hotfix/keys

HOTFIX_PRIVATE_KEY=.hotfix/keys/private.pem \
HOTFIX_ADMIN_TOKEN=replace-with-a-long-random-token \
HOTFIX_STORAGE_DIR=.hotfix/server \
npx hotfix-server
```

Check health:

```sh
curl http://127.0.0.1:3000/health
```

The package exports `createHotfixServer()` and `./signing` for embedding the
service in a larger Node.js application.

# Private server deployment

**English** | [简体中文](zh-CN/server-deployment.md)

This guide deploys the React Native Hotfix update server on a private VM,
company network, or private cloud. It covers Docker, a native Node.js service,
TLS, publishing access, backup, upgrades, and security.

The included server is a single-node reference deployment. It is suitable for
an internal update service with one active writer. Do not run multiple writer
instances against separate local disks or expect the local channel files to
provide distributed transactions.

## Deployment architecture

```text
Publisher CLI
    |
    | HTTPS or SSH tunnel + admin token
    v
Private server
  - /v1/admin/*       publishing API
  - /v1/check         app update check
  - /v1/updates/*     immutable update files
  - persistent disk   manifests, bundles, assets, channel state
    ^
    | HTTPS through reverse proxy
    |
React Native apps / internal CDN
```

The private signing key and admin token never enter the mobile app. Mobile
clients contain only the RSA public key.

## Prerequisites

- Linux server or VM with a persistent data volume
- Docker with Compose, or Node.js `22.11+`
- A DNS name reachable by target devices
- A trusted HTTPS certificate
- Outbound network access only when installing images/packages
- A separate secure location for backups
- Accurate system time, preferably using NTP

Public app endpoints must be reachable over HTTPS. The admin endpoints should
be available only through a VPN, private admin hostname, IP allowlist, or SSH
tunnel.

## Step 1: Prepare signing material

Generate the key pair on a trusted publisher machine:

```sh
npx hotfix keys generate --out .hotfix/keys
```

Keep these values separate:

- `.hotfix/keys/public-key-der-base64.txt`: embed in Android and iOS.
- `.hotfix/keys/private.pem`: copy to the server secret store.
- `.hotfix/keys/key-id.txt`: record with the deployed version.

Never commit the private key. Do not mount the directory containing the entire
key-generation workspace into the server container.

## Step 2: Create deployment secrets

Create a secret directory outside Git:

```sh
mkdir -p .secrets
cp .hotfix/keys/private.pem .secrets/hotfix_private_key.pem
openssl rand -hex 32 > .secrets/hotfix_admin_token
chmod 600 .secrets/hotfix_private_key.pem .secrets/hotfix_admin_token
```

Verify that `.secrets/` is ignored by Git before continuing.

For a production server, the equivalent secure stores are Docker secrets,
Kubernetes Secrets, Vault, AWS Secrets Manager, or an HSM/KMS-backed secret
injection mechanism.

## Option A: Docker Compose

The repository includes:

- `deploy/Dockerfile`
- `deploy/docker-compose.yml`
- `deploy/Caddyfile.example`

Set the public update origin:

```sh
export HOTFIX_BASE_URL=https://updates.example.com
docker compose -f deploy/docker-compose.yml up -d --build
```

The container:

- runs as an unprivileged `hotfix` user;
- exposes port `3000` only on host loopback;
- persists `/data` in the `hotfix-data` volume;
- reads the private key and admin token from Docker secrets;
- includes a Docker health check.

Check health:

```sh
curl http://127.0.0.1:3000/health
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs --tail=100 hotfix
```

Use an immutable image tag and registry mirror for regulated or air-gapped
environments. Pin `HOTFIX_VERSION` in the Compose build arguments and record
the resulting image digest.

## Option B: Native Node.js service

Create a dedicated service account and directories:

```sh
sudo useradd --system --home-dir /opt/react-native-hotfix \
  --shell /usr/sbin/nologin hotfix
sudo install -d -o hotfix -g hotfix /opt/react-native-hotfix
sudo install -d -o hotfix -g hotfix /var/lib/react-native-hotfix
sudo install -d -o root -g hotfix -m 750 /etc/react-native-hotfix
```

Install the server package:

```sh
sudo npm install --prefix /opt/react-native-hotfix \
  react-native-hotfix-server@0.1.3
```

Install secrets:

```sh
sudo install -o root -g hotfix -m 640 \
  .secrets/hotfix_private_key.pem \
  /etc/react-native-hotfix/hotfix_private_key.pem
```

Create `/etc/react-native-hotfix/server.env` from
`deploy/server.env.example` and set a strong admin token:

```text
HOTFIX_STORAGE_DIR=/var/lib/react-native-hotfix
HOTFIX_PRIVATE_KEY=/etc/react-native-hotfix/hotfix_private_key.pem
HOTFIX_ADMIN_TOKEN=replace-with-at-least-32-random-characters
HOTFIX_BASE_URL=https://updates.example.com
HOTFIX_MAX_BYTES=209715200
HOST=127.0.0.1
PORT=3000
```

Secure the environment file:

```sh
sudo chown root:root /etc/react-native-hotfix/server.env
sudo chmod 600 /etc/react-native-hotfix/server.env
```

Create `/etc/systemd/system/react-native-hotfix.service`:

```ini
[Unit]
Description=React Native Hotfix server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hotfix
Group=hotfix
WorkingDirectory=/opt/react-native-hotfix
EnvironmentFile=/etc/react-native-hotfix/server.env
ExecStart=/opt/react-native-hotfix/node_modules/.bin/hotfix-server
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/react-native-hotfix

[Install]
WantedBy=multi-user.target
```

Enable and start:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now react-native-hotfix
sudo systemctl status react-native-hotfix
curl http://127.0.0.1:3000/health
```

The service binds only to loopback. A reverse proxy provides HTTPS.

## Step 3: Configure HTTPS

### Caddy

Use `deploy/Caddyfile.example` as a starting point:

```caddyfile
updates.example.com {
  encode zstd gzip

  @admin path /v1/admin/*
  respond @admin 404

  reverse_proxy 127.0.0.1:3000 {
    header_up X-Forwarded-Proto {scheme}
  }
}
```

This exposes update checks/files to mobile clients while returning `404` for
public admin requests. Publish through a private route or SSH tunnel.

If the environment uses a private CA, install its certificate chain and ensure
mobile devices trust that CA.

### Nginx

An equivalent Nginx location must:

- terminate TLS with a valid certificate chain;
- proxy `/v1/check` and `/v1/updates/` to `127.0.0.1:3000`;
- deny `/v1/admin/` unless the request comes from a private network or identity
  proxy;
- allow request bodies at least as large as `HOTFIX_MAX_BYTES`;
- preserve `Host` or configure `HOTFIX_BASE_URL`.

Example admin isolation:

```nginx
location ^~ /v1/admin/ {
    allow 10.0.0.0/8;
    allow 172.16.0.0/12;
    allow 192.168.0.0/16;
    deny all;

    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 200m;
}
```

Use an identity-aware proxy in addition to IP allowlisting when publishers
connect from mobile or untrusted networks.

## Step 4: Configure the mobile app

Development on the server host:

```text
http://127.0.0.1:3000/v1/check
```

Android emulator:

```text
http://10.0.2.2:3000/v1/check
```

Private production deployment:

```text
https://updates.example.com/v1/check
```

The app must use the public key matching the server private key and the same
channel/runtime version used for publishing. See the
[integration guide](https://github.com/lenglengiOS/react-native-hotfix/blob/master/docs/getting-started.md) for exact Android/iOS configuration.

## Step 5: Publish through the private admin path

The public proxy blocks `/v1/admin/*`. Choose one of these publishing paths:

### SSH tunnel

```sh
ssh -N -L 3000:127.0.0.1:3000 ops@updates.example.com
```

In another terminal:

```sh
HOTFIX_ADMIN_TOKEN='<secret>' \
npx hotfix publish \
  --server http://127.0.0.1:3000 \
  --input .hotfix/dist/ios-1.0.0 \
  --rollout-percent 5
```

The SSH tunnel only protects the admin connection. `HOTFIX_BASE_URL` must still
point to the HTTPS URL embedded in download responses.

### Private admin hostname

Add an internal-only DNS record and TLS endpoint such as
`updates-admin.corp.example.com`. Permit only VPN or office networks, then publish
to that origin.

Do not expose the admin token in build logs, shell history, CI output, or mobile
configuration.

## Data layout

The persistent directory contains immutable update releases and channel state:

```text
/var/lib/react-native-hotfix/
  pending/
  published/
  channels/
```

Back up this entire directory. Source maps remain on the publisher unless you
intentionally archive them elsewhere.

## Backup and restore

Pause publishing and application writes before taking a filesystem snapshot, or
use storage-level atomic snapshots.

Example archive:

```sh
sudo systemctl stop react-native-hotfix
sudo tar -C /var/lib -czf /secure-backups/react-native-hotfix-$(date +%F-%H%M).tgz \
  react-native-hotfix
sudo systemctl start react-native-hotfix
```

For Docker:

```sh
docker compose -f deploy/docker-compose.yml stop hotfix
docker run --rm \
  -v react-native-hotfix_hotfix-data:/data \
  -v "$PWD/backups:/backup" \
  alpine tar -C /data -czf /backup/hotfix-data.tgz .
docker compose -f deploy/docker-compose.yml start hotfix
```

Restore into the same directory layout, preserve ownership and file modes, and
verify `/health` plus a staged update before moving traffic.

Back up the signing key and admin token separately. Encrypt backups and test
restore procedures regularly.

## Upgrade procedure

1. Record the current server version, image digest, key ID, and latest update ID.
2. Take a data backup.
3. Install the new `react-native-hotfix-server` version in a staging deployment.
4. Verify health, check, publish, activation, and app download behavior.
5. Replace the production container/service.
6. Confirm health and publish a low-rollout test update.

Keep the previous image or package version available for server rollback.
Published update IDs remain immutable.

## Application update rollback

Server deployment rollback and app update rollback are different:

- Server rollback restores the service version.
- Update rollback activates an earlier immutable update ID.
- Native rollback requires reinstalling the previous native app.

Activate a known-good update:

```sh
HOTFIX_ADMIN_TOKEN='<secret>' \
npx hotfix activate \
  --server https://admin-or-tunnel-origin \
  --channel production \
  --platform ios \
  --runtime-version 1.0.0 \
  --update-id <known-good-id> \
  --rollout-percent 100
```

## Private CA and air-gapped environments

Mobile devices must trust the HTTPS certificate. For a private CA:

- distribute the enterprise root certificate according to company policy;
- configure Android network security/trust settings;
- configure iOS trust and MDM profiles;
- verify certificate renewal, SANs, and clock accuracy;
- do not fall back to cleartext HTTP in production.

For air-gapped deployment:

- mirror or copy the Node base image;
- install the server from an internal npm registry;
- mirror pinned package tarballs and dependency metadata;
- use internal DNS, TLS, and storage;
- bring signing keys through an approved offline process;
- keep NTP/time sources available for TLS and access tokens.

## Multi-instance limitations

The provided server stores channel pointers in local files. A single active
writer is required.

For multiple API replicas or high availability, replace the storage layer with:

- a transactional database for pointer/idempotency metadata;
- durable object storage for immutable files;
- a publish workflow with compare-and-swap or database transactions;
- shared distributed locking for upload staging.

Do not attach the same local volume to multiple hosts and assume concurrent
publishes are safe.

## Monitoring and operations

Monitor:

- `/health` availability and latency;
- disk utilization and inode usage;
- update downloads and HTTP error rate;
- signature/hash failures;
- publish and activation errors;
- TLS certificate expiration;
- backup success and restore drills;
- unknown or unauthorized admin requests.

Add edge authentication, rate limiting, access logs, alerts, and retention
controls for a production deployment.

## Production acceptance checklist

- [ ] Private key permissions are restrictive and stored outside Git.
- [ ] Admin token is random and not present in app bundles.
- [ ] Public proxy blocks `/v1/admin/*`.
- [ ] HTTPS certificate is trusted by test devices.
- [ ] Persistent storage survives container/service restart.
- [ ] `/health` is green.
- [ ] A staging update publishes and installs.
- [ ] The app activates the update after a full cold start.
- [ ] A deliberately bad update rolls back.
- [ ] Restore from backup has been tested.
- [ ] Monitoring and alerting are configured.
