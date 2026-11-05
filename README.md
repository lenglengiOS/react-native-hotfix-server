# react-native-hotfix-server

**English** | [简体中文](README.zh-CN.md)

Single-node, self-hosted update server for React Native Hotfix.

## Install

```sh
npm install react-native-hotfix-server@0.1.1
npm install -D react-native-hotfix-cli@0.1.1
```

Generate signing keys with `react-native-hotfix-cli`, then start the server:

```sh
HOTFIX_PRIVATE_KEY=.hotfix/keys/private.pem \
HOTFIX_ADMIN_TOKEN=replace-with-a-long-random-token \
HOTFIX_STORAGE_DIR=.hotfix/server \
npx hotfix-server
```

The package also exports `createHotfixServer()` and `./signing` TypeScript APIs
for embedding the service in a larger Node.js application.

Verify the local service:

```sh
curl http://127.0.0.1:3000/health
```

Production requires a persistent storage directory and an HTTPS public origin:

```sh
HOTFIX_STORAGE_DIR=/var/lib/react-native-hotfix \
HOTFIX_PRIVATE_KEY=/run/secrets/hotfix-private.pem \
HOTFIX_ADMIN_TOKEN='<strong-random-secret>' \
HOTFIX_BASE_URL=https://updates.example.com \
npx hotfix-server
```

It validates uploaded bundles, stores immutable update directories, signs
manifests with RSA-SHA256, serves update files with long-lived cache headers,
and supports channel activation and percentage rollouts.

Production deployments should place immutable `/v1/updates/*` files behind a
CDN and use PostgreSQL or object storage if multiple server instances publish
at the same time. Channel pointers are written atomically for a single node.
