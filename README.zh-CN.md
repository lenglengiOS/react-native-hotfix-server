# react-native-hotfix-server

[English](README.md) | **简体中文**

React Native Hotfix 的单节点自托管更新服务端。

## 安装

```sh
npm install react-native-hotfix-server@0.1.1
npm install -D react-native-hotfix-cli@0.1.1
```

使用 `react-native-hotfix-cli` 生成签名密钥后启动服务端：

```sh
HOTFIX_PRIVATE_KEY=.hotfix/keys/private.pem \
HOTFIX_ADMIN_TOKEN=replace-with-a-long-random-token \
HOTFIX_STORAGE_DIR=.hotfix/server \
npx hotfix-server
```

该包还导出 `createHotfixServer()` 以及 `./signing` TypeScript API，便于将
更新服务嵌入已有的 Node.js 应用。

检查本地服务：

```sh
curl http://127.0.0.1:3000/health
```

生产环境需要持久存储目录和 HTTPS 公网地址：

```sh
HOTFIX_STORAGE_DIR=/var/lib/react-native-hotfix \
HOTFIX_PRIVATE_KEY=/run/secrets/hotfix-private.pem \
HOTFIX_ADMIN_TOKEN='<高强度随机值>' \
HOTFIX_BASE_URL=https://updates.example.com \
npx hotfix-server
```

服务端会校验上传的 bundle，保存不可变更新目录，使用 RSA-SHA256 签名清单，
通过长效缓存响应头提供更新文件，并支持 channel 激活和百分比灰度。

生产部署应将不可变的 `/v1/updates/*` 文件放在 CDN 后面。如果多个服务端实例
同时发布，应使用 PostgreSQL 或对象存储协调状态。当前实现的 channel 指针写入
只保证单节点原子性。
