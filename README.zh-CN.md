# React Native Hotfix Server

[English](README.md) | **简体中文**

React Native Hotfix 的单节点自托管更新服务端。本 README 同时是完整的服务端
私有化部署指南。

## 安装

```sh
npm install react-native-hotfix-server@0.1.3
npm install -D react-native-hotfix-cli@0.1.3
```

生成签名密钥后启动服务端：

```sh
npx hotfix keys generate --out .hotfix/keys

HOTFIX_PRIVATE_KEY=.hotfix/keys/private.pem \
HOTFIX_ADMIN_TOKEN=replace-with-a-long-random-token \
HOTFIX_STORAGE_DIR=.hotfix/server \
npx hotfix-server
```

检查服务：

```sh
curl http://127.0.0.1:3000/health
```

该包导出 `createHotfixServer()` 和 `./signing`，可以嵌入现有 Node.js 应用。

# 服务端私有化部署

本文说明如何将 React Native Hotfix 更新服务端部署到私有 VM、企业内网或私有云。
内容覆盖 Docker、Node.js systemd、HTTPS、发布入口隔离、备份、升级和安全。

当前服务端是单节点参考实现，适合只有一个发布写入实例的内部更新服务。不要在
多个节点使用各自本地磁盘，也不要假设本地 channel 文件具备分布式事务能力。

## 部署架构

```text
发布端 CLI
    |
    | HTTPS 或 SSH Tunnel + 管理 Token
    v
私有服务端
  - /v1/admin/*       发布接口
  - /v1/check         App 检查更新
  - /v1/updates/*     不可变更新文件
  - 持久磁盘         清单、bundle、资源、channel 状态
    ^
    | 经过反向代理的 HTTPS
    |
React Native App / 内部 CDN
```

签名私钥和管理 Token 绝不能进入移动 App。客户端只包含 RSA 公钥。

## 环境要求

- 具有持久数据盘的 Linux 服务器或 VM
- Docker + Compose，或者 Node.js `22.11+`
- 目标设备可访问的 DNS 域名
- 可信 HTTPS 证书
- 仅在安装镜像/依赖时需要外网
- 独立且安全的备份存储
- 准确系统时间，建议启用 NTP

公开给 App 的接口必须使用 HTTPS。管理接口只允许通过 VPN、内部管理域名、
IP 白名单或 SSH 隧道访问。

## 第 1 步：准备签名材料

在可信发布机器生成密钥：

```sh
npx hotfix keys generate --out .hotfix/keys
```

分开放置：

- `.hotfix/keys/public-key-der-base64.txt`：写入 Android 和 iOS。
- `.hotfix/keys/private.pem`：部署到服务端 Secret Store。
- `.hotfix/keys/key-id.txt`：与服务端版本一起记录。

不要提交私钥，也不要把整个密钥生成工作目录挂载到服务端容器。

## 第 2 步：创建部署 Secret

在 Git 仓库外创建：

```sh
mkdir -p .secrets
cp .hotfix/keys/private.pem .secrets/hotfix_private_key.pem
openssl rand -hex 32 > .secrets/hotfix_admin_token
chmod 600 .secrets/hotfix_private_key.pem .secrets/hotfix_admin_token
```

继续前确认 `.secrets/` 已被 Git 忽略。

生产环境可使用 Docker Secrets、Kubernetes Secrets、Vault、云厂商 Secret
Manager 或 KMS/HSM 注入。

## 方案 A：Docker Compose

仓库提供：

- `deploy/Dockerfile`
- `deploy/docker-compose.yml`
- `deploy/Caddyfile.example`

设置公开更新地址：

```sh
export HOTFIX_BASE_URL=https://updates.example.com
docker compose -f deploy/docker-compose.yml up -d --build
```

容器会：

- 使用非特权 `hotfix` 用户运行；
- 只在宿主机回环地址暴露 3000；
- 将 `/data` 保存到 `hotfix-data` volume；
- 从 Docker Secrets 读取私钥和管理 Token；
- 使用 Docker health check。

检查：

```sh
curl http://127.0.0.1:3000/health
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs --tail=100 hotfix
```

受监管或离线环境应使用固定镜像 Tag 和私有镜像仓库，记录 `HOTFIX_VERSION`
及最终镜像 digest。

## 方案 B：Node.js + systemd

创建专用用户和目录：

```sh
sudo useradd --system --home-dir /opt/react-native-hotfix \
  --shell /usr/sbin/nologin hotfix
sudo install -d -o hotfix -g hotfix /opt/react-native-hotfix
sudo install -d -o hotfix -g hotfix /var/lib/react-native-hotfix
sudo install -d -o root -g hotfix -m 750 /etc/react-native-hotfix
```

安装服务端：

```sh
sudo npm install --prefix /opt/react-native-hotfix \
  react-native-hotfix-server@0.1.3
```

安装私钥：

```sh
sudo install -o root -g hotfix -m 640 \
  .secrets/hotfix_private_key.pem \
  /etc/react-native-hotfix/hotfix_private_key.pem
```

根据 `deploy/server.env.example` 创建
`/etc/react-native-hotfix/server.env`：

```text
HOTFIX_STORAGE_DIR=/var/lib/react-native-hotfix
HOTFIX_PRIVATE_KEY=/etc/react-native-hotfix/hotfix_private_key.pem
HOTFIX_ADMIN_TOKEN=replace-with-at-least-32-random-characters
HOTFIX_BASE_URL=https://updates.example.com
HOTFIX_MAX_BYTES=209715200
HOST=127.0.0.1
PORT=3000
```

保护环境文件：

```sh
sudo chown root:root /etc/react-native-hotfix/server.env
sudo chmod 600 /etc/react-native-hotfix/server.env
```

创建 `/etc/systemd/system/react-native-hotfix.service`：

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

启动：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now react-native-hotfix
sudo systemctl status react-native-hotfix
curl http://127.0.0.1:3000/health
```

服务仅绑定回环地址，由反向代理提供 HTTPS。

## 第 3 步：配置 HTTPS

### Caddy

以 `deploy/Caddyfile.example` 为起点：

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

该配置向 App 开放检查和下载，但公网访问 `/v1/admin/*` 返回 `404`。发布操作
应通过私有入口或 SSH Tunnel。

使用私有 CA 时，需要分发 CA 证书链并让移动设备信任。

### Nginx

Nginx 配置需要：

- 使用完整可信证书终止 TLS；
- 将 `/v1/check` 和 `/v1/updates/` 代理到 `127.0.0.1:3000`；
- 除非来自内网或经过身份代理，否则拒绝 `/v1/admin/`；
- 请求体上限不小于 `HOTFIX_MAX_BYTES`；
- 保留 `Host`，或者正确设置 `HOTFIX_BASE_URL`。

管理接口隔离示例：

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

发布人员从不可信网络访问时，应在 IP 白名单之外增加企业身份代理。

## 第 4 步：配置移动 App

服务端本机开发：

```text
http://127.0.0.1:3000/v1/check
```

Android 模拟器：

```text
http://10.0.2.2:3000/v1/check
```

私有生产部署：

```text
https://updates.example.com/v1/check
```

App 公钥必须与服务器私钥匹配，channel 和 runtime version 也必须与发布时
一致。Android/iOS 的具体配置见
[接入指南](https://github.com/lenglengiOS/react-native-hotfix/blob/master/docs/zh-CN/getting-started.md)。

## 第 5 步：通过私有管理入口发布

公网代理会阻止 `/v1/admin/*`，可选择以下发布方式。

### SSH Tunnel

```sh
ssh -N -L 3000:127.0.0.1:3000 ops@updates.example.com
```

在另一个终端执行：

```sh
HOTFIX_ADMIN_TOKEN='<secret>' \
npx hotfix publish \
  --server http://127.0.0.1:3000 \
  --input .hotfix/dist/ios-1.0.0 \
  --rollout-percent 5
```

SSH 只保护管理连接。`HOTFIX_BASE_URL` 仍然必须指向 App 下载时使用的 HTTPS
地址。

### 内部管理域名

配置仅限 VPN 或办公网访问的内部域名和 TLS 端点，例如
`updates-admin.corp.example.com`，再向该地址发布。

不要在构建日志、Shell 历史、CI 输出或移动端配置中泄露管理 Token。

## 数据目录

持久目录包含不可变更新和 channel 状态：

```text
/var/lib/react-native-hotfix/
  pending/
  published/
  channels/
```

需要备份整个目录。发布端 Source Map 默认不在服务器上。

## 备份与恢复

备份前暂停发布写入，或使用存储层原子快照。

示例：

```sh
sudo systemctl stop react-native-hotfix
sudo tar -C /var/lib -czf /secure-backups/react-native-hotfix-$(date +%F-%H%M).tgz \
  react-native-hotfix
sudo systemctl start react-native-hotfix
```

Docker：

```sh
docker compose -f deploy/docker-compose.yml stop hotfix
docker run --rm \
  -v react-native-hotfix_hotfix-data:/data \
  -v "$PWD/backups:/backup" \
  alpine tar -C /data -czf /backup/hotfix-data.tgz .
docker compose -f deploy/docker-compose.yml start hotfix
```

恢复时保持目录结构、文件所有者和权限，并验证 `/health` 与 staging 发布。

私钥和管理 Token 需要单独备份。备份应加密并定期演练恢复。

## 升级流程

1. 记录当前服务端版本、镜像 digest、key ID 和最新更新 ID。
2. 备份数据。
3. 先在 staging 安装新版本服务端。
4. 验证健康、检查、发布、激活和 App 下载。
5. 替换生产 container/service。
6. 验证健康并发布低比例测试更新。

保留上一版镜像或 npm 包，以便服务端回滚。已经发布的更新 ID 不可变。

## 更新回滚

服务端版本回滚与 App 更新回滚不同：

- 服务端回滚恢复服务版本；
- 更新回滚重新激活之前的不可变更新 ID；
- 原生回滚需要重新安装旧原生 App。

激活已知稳定版本：

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

## 私有 CA 与离线环境

移动设备必须信任 HTTPS 证书。使用私有 CA 时：

- 按公司规范分发企业根证书；
- 配置 Android Network Security Config/信任设置；
- 配置 iOS 信任与 MDM Profile；
- 验证证书续期、SAN 和系统时间；
- 生产环境不要回退到 HTTP 明文。

离线部署时：

- 镜像或复制 Node 基础镜像；
- 使用内部 npm registry 安装服务端；
- 镜像固定版本的依赖 tarball；
- 使用内部 DNS、TLS 和存储；
- 通过审批后的离线流程导入签名密钥；
- 保留 NTP/时间源，避免 TLS 和时间令牌失效。

## 多实例限制

当前服务端使用本地文件保存 channel 指针，只允许一个活跃写入实例。

需要多 API 副本或高可用时，应替换为：

- 事务数据库保存指针和幂等元数据；
- 对象存储保存不可变文件；
- compare-and-swap 或数据库事务完成发布；
- 分布式锁协调上传暂存。

不要把同一个本地卷挂载给多个宿主机并假设并发发布安全。

## 监控与运维

至少监控：

- `/health` 可用性与延迟；
- 磁盘容量和 inode；
- 更新下载量与 HTTP 错误率；
- 签名/哈希失败；
- 发布和激活错误；
- TLS 证书到期时间；
- 备份成功与恢复演练；
- 未授权管理请求。

生产部署还应增加边缘鉴权、限流、访问日志、告警和日志保留策略。

## 生产验收清单

- [ ] 私钥权限受限且不在 Git 中。
- [ ] 管理 Token 随机生成，不进入 App bundle。
- [ ] 公网代理阻止 `/v1/admin/*`。
- [ ] 测试设备信任 HTTPS 证书。
- [ ] 容器或服务重启后持久数据仍然存在。
- [ ] `/health` 正常。
- [ ] staging 更新可以发布和安装。
- [ ] App 完全冷启动后激活更新。
- [ ] 故意制造的错误更新可以回滚。
- [ ] 已执行备份恢复测试。
- [ ] 已配置监控和告警。
