# cf-dns-clean

一个由AI编写的通过Telegram Bot 管理 Cloudflare DNS 记录的轻量工具。

项目地址：

```text
https://github.com/kazoofly/cf-dns-clean
```

## 功能特性

- 支持管理多个 Cloudflare 域名
- 每个域名使用独立的 Cloudflare API Token
- 支持查看 `A`、`AAAA`、`CNAME` 记录
- 支持新增、修改、删除指定 DNS 记录
- 支持修改记录名称、地址、备注和代理状态
- 支持 Telegram 按钮交互和分页查看
- Telegram Bot Token、Telegram 用户 ID、Cloudflare Token 均加密保存
- 支持普通 VPS `systemd` 部署
- 支持 Docker 源码构建部署
- 支持 GitHub Actions 自动构建并发布 GHCR 镜像

## 使用场景

适合需要通过手机快速管理 Cloudflare DNS 的场景，例如：

- 临时新增解析记录
- 修改某条指定 DNS 的地址
- 管理多个域名的 DNS
- 在不登录 Cloudflare 官网的情况下完成常见 DNS 操作

## 安全设计

项目不会把敏感信息以明文保存在项目目录中。

机器人启动时必须配置 `TG_ALLOWED_USER_ID`，并且只允许在 Telegram 私聊中操作，避免 DNS 信息被群聊误展示。

运行后会生成：

- `app-secrets.enc`：加密保存 Telegram Bot Token 和 Telegram 用户 ID
- `managed-zones.enc`：加密保存域名信息和 Cloudflare API Token
- `master.key`：加密主密钥，部署时默认保存在项目目录外

默认主密钥路径：

```text
/etc/cf-dns-bot/master.key
```

需要注意：如果同时拿到加密文件和主密钥，就可以解密敏感信息。请妥善保存主密钥，不要把它提交到 GitHub。

## Cloudflare Token 权限

每个域名建议创建一枚独立的 Cloudflare API Token。

推荐权限：

- `Zone` -> `Zone` -> `Read`
- `Zone` -> `DNS` -> `Write`

推荐资源范围：

- `Include` -> `Specific zone`
- 只选择需要交给机器人的那个域名

## Telegram 命令

- `/start`：打开主菜单
- `/domains`：打开域名列表
- `/dns`：打开当前域名的 DNS 列表
- `/cancel`：取消当前输入流程
- `/skip`：修改备注时清空备注

## 部署方式

### 普通 VPS 部署

适合不使用 Docker 的服务器。

```bash
curl -fsSL https://raw.githubusercontent.com/kazoofly/cf-dns-clean/main/install.sh | \
  bash -s -- https://github.com/kazoofly/cf-dns-clean/archive/refs/heads/main.tar.gz
```

详细说明：

- `docs/guide-vps-systemd.md`

### Docker 源码构建部署

适合下载源码后在 VPS 本机直接构建镜像。

```bash
bash docker-deploy.sh
```

详细说明：

- `docs/guide-docker-build.md`

### GHCR 镜像部署

GitHub Actions 会自动构建并发布镜像：

```text
ghcr.io/kazoofly/cf-dns-clean:latest
```

在 VPS 上执行：

```bash
bash docker-image-deploy.sh ghcr.io/kazoofly/cf-dns-clean:latest
```

详细说明：

- `docs/guide-ghcr-image.md`

## 首次使用流程

1. 部署并启动机器人
2. 在 Telegram 给机器人发送 `/start`
3. 点击 `域名列表`
4. 点击 `新增域名`
5. 发送该域名专用的 Cloudflare API Token
6. 进入域名后查看或修改 DNS 记录

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
- `docs/`：公开部署说明

## 常用维护命令

普通 VPS 部署：

```bash
systemctl status cf-dns-bot
journalctl -u cf-dns-bot -f
systemctl restart cf-dns-bot
```

Docker 源码构建部署：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml logs -f
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml restart
```

GHCR 镜像部署：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml pull
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml up -d
```

## 许可证

当前仓库未附带许可证文件。公开使用或二次分发前，可以根据需要补充 `LICENSE`。
