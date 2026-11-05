# react-native-hotfix-server

[English](README.md) | **简体中文**

React Native Hotfix 的单节点自托管更新服务端。

## 安装

```sh
npm install react-native-hotfix-server
```

使用 `react-native-hotfix-cli` 生成签名密钥后启动服务端：

```sh
HOTFIX_PRIVATE_KEY=.hotfix/keys/private.pem \
HOTFIX_ADMIN_TOKEN=replace-with-a-long-random-token \
node node_modules/react-native-hotfix-server/src/index.mjs
```

该包还导出 `createHotfixServer()` 以及 `./signing` TypeScript API，便于将
更新服务嵌入已有的 Node.js 应用。

服务端会校验上传的 bundle，保存不可变更新目录，使用 RSA-SHA256 签名清单，
通过长效缓存响应头提供更新文件，并支持 channel 激活和百分比灰度。

生产部署应将不可变的 `/v1/updates/*` 文件放在 CDN 后面。如果多个服务端实例
同时发布，应使用 PostgreSQL 或对象存储协调状态。当前实现的 channel 指针写入
只保证单节点原子性。
