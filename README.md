# cf-dns-clean

一个由 AI 生成、通过 Telegram Bot 管理 Cloudflare DNS 记录的轻量工具。

项目地址：

```text
https://github.com/kazoofly/cf-dns-clean
```

## 功能特性

- 管理多个 Cloudflare 域名
- 每个域名使用独立的 Cloudflare API Token
- 查看和筛选 `A`、`AAAA`、`CNAME` 记录
- 新增、修改、删除指定 DNS 记录
- 修改记录名称、地址、备注和代理状态
- Telegram 私聊按钮交互和分页查看
- Telegram Bot Token、Telegram 用户 ID、Cloudflare Token 加密保存
- 支持普通 VPS `systemd` 部署
- 支持 Docker 源码构建部署
- 支持 GitHub Actions 自动构建并发布 GHCR 镜像

## 适用场景

适合需要通过手机快速管理 Cloudflare DNS 的场景，例如：

- 临时新增解析记录
- 修改某条指定 DNS 的地址
- 管理多个域名的 DNS
- 不登录 Cloudflare 官网也能完成常见 DNS 操作

## 安全设计

机器人启动时必须配置 `TG_ALLOWED_USER_ID`，并且只允许在 Telegram 私聊中操作，避免 DNS 信息被群聊误展示。

项目不会把敏感信息以明文保存在项目目录中。运行后会生成：

- `app-secrets.enc`：加密保存 Telegram Bot Token 和 Telegram 用户 ID
- `managed-zones.enc`：加密保存域名信息和 Cloudflare API Token
- `master.key`：加密主密钥，普通 VPS 部署时默认保存到 `/etc/cf-dns-bot/master.key`

如果同时拿到加密文件和主密钥，就可以解密敏感信息。请妥善保存主密钥，不要把它提交到 GitHub。

## 准备工作

1. 创建 Telegram Bot，拿到 `TG_BOT_TOKEN`
2. 获取自己的 Telegram 用户 ID，作为 `TG_ALLOWED_USER_ID`
3. 为每个要管理的域名创建一枚独立 Cloudflare API Token

Cloudflare Token 推荐权限：

- `Zone` -> `Zone` -> `Read`
- `Zone` -> `DNS` -> `Write`

Cloudflare Token 推荐资源范围：

- `Include` -> `Specific zone`
- 只选择需要交给机器人的那个域名

## 部署方式

### 普通 VPS 部署

适合不使用 Docker、希望用 `systemd` 长期运行的 Linux VPS。

一条命令安装：

```bash
curl -fsSL https://raw.githubusercontent.com/kazoofly/cf-dns-clean/main/install.sh | \
  bash -s -- https://github.com/kazoofly/cf-dns-clean/archive/refs/heads/main.tar.gz
```

如果已经把源码下载到服务器，也可以在项目目录执行：

```bash
bash deploy.sh
```

脚本会自动：

- 检查并安装 Node.js 20，如果系统里没有可用的 Node.js 18+
- 创建运行用户 `cfbot`
- 部署项目到 `/opt/cf-dns-bot`
- 创建 `/etc/cf-dns-bot/master.key`
- 创建加密后的 `app-secrets.enc` 和 `managed-zones.enc`
- 写入并启动 `systemd` 服务 `cf-dns-bot`

首次部署时按提示输入：

- 加密主密钥，留空则自动生成
- `TG_BOT_TOKEN`
- `TG_ALLOWED_USER_ID`

常用命令：

```bash
systemctl status cf-dns-bot
journalctl -u cf-dns-bot -f
systemctl restart cf-dns-bot
```

### Docker 源码构建部署

适合下载源码后在 VPS 本机直接构建镜像并运行。

```bash
bash docker-deploy.sh
```

脚本会自动：

- 检查 `docker` 和 `docker compose`
- 复制运行文件到 `/opt/cf-dns-bot-docker/app`
- 创建数据目录和主密钥目录
- 首次启动时提示输入 Telegram 配置
- 执行 `docker compose up -d --build`

默认运行目录：

```text
/opt/cf-dns-bot-docker
```

常用命令：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml logs -f
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml restart
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml up -d --build
```

### GHCR 镜像部署

项目内置 GitHub Actions 工作流，会在推送到 `main`、`master`、`v*` 标签或手动触发时构建并发布镜像。

默认镜像：

```text
ghcr.io/kazoofly/cf-dns-clean:latest
```

在 VPS 上执行：

```bash
bash docker-image-deploy.sh ghcr.io/kazoofly/cf-dns-clean:latest
```

常用命令：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml logs -f
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml pull
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml up -d
```

## 首次使用流程

1. 部署并启动机器人
2. 在 Telegram 给机器人发送 `/start`
3. 点击 `域名列表`
4. 点击 `新增域名`
5. 发送该域名专用的 Cloudflare API Token
6. 进入域名后查看、新增或修改 DNS 记录

## Telegram 命令

- `/start`：打开主菜单
- `/domains`：打开域名列表
- `/dns`：打开当前域名的 DNS 列表
- `/cancel`：取消当前输入流程
- `/skip`：修改备注时清空备注

## 项目文件

- `tg-cf-dns-bot.mjs`：机器人主程序
- `secure-store.mjs`：加密存储工具
- `deploy.sh`：普通 VPS 一键部署脚本
- `install.sh`：远程安装脚本
- `docker-deploy.sh`：Docker 源码构建部署脚本
- `docker-image-deploy.sh`：GHCR 镜像部署脚本
- `Dockerfile`：Docker 镜像构建文件
- `docker-compose.yml`：源码构建用 Compose 文件
- `docker-compose.image.yml`：预构建镜像用 Compose 文件
- `.github/workflows/docker-image.yml`：GitHub Actions 镜像发布工作流

## 许可证

本项目采用 MIT License，详见 `LICENSE`。
