# VPS 部署说明

## 压缩包内容

- `tg-cf-dns-bot.mjs`：机器人主程序
- `secure-store.mjs`：加密存储工具
- `package.json`：启动和语法检查脚本
- `.env.example`：配置模板
- `deploy.sh`：新 VPS 一键部署脚本
- `install.sh`：远程一条命令安装脚本
- `docker-deploy.sh`：本地源码一键 Docker 部署脚本
- `docker-image-deploy.sh`：预构建镜像 Docker 部署脚本
- `.github/workflows/docker-image.yml`：推送到 GitHub 后自动构建并发布 GHCR 镜像
- `README.md`：项目说明

## 一键部署

默认假设新 VPS 是带 `systemd` 的 Linux 系统。

1. 把压缩包上传到 VPS
2. 解压压缩包
3. 进入解压后的目录
4. 执行：

```bash
bash deploy.sh
```

## 更省事的一条命令

如果你已经把项目放到 GitHub 或其他可下载地址，还可以直接执行远程安装脚本。

示例一：项目压缩包是 `.tar.gz`

```bash
curl -fsSL https://raw.githubusercontent.com/kazoofly/cf-dns-clean/main/install.sh | \
  bash -s -- https://github.com/kazoofly/cf-dns-clean/archive/refs/heads/main.tar.gz
```

示例二：使用自定义压缩包地址

```bash
curl -fsSL https://raw.githubusercontent.com/kazoofly/cf-dns-clean/main/install.sh | \
  bash -s -- <archive-url>
```

这个脚本会先下载项目压缩包，解压后再自动执行 `deploy.sh`。

## 脚本会自动做什么

- 检查并安装 Node.js 20，如果系统里没有可用的 Node.js 18+
- 创建运行用户 `cfbot`
- 把项目复制到 `/opt/cf-dns-bot`
- 创建 `/etc/cf-dns-bot/master.key` 加密主密钥文件
- 创建 `/opt/cf-dns-bot/.env`
- 创建加密后的 `app-secrets.enc`
- 创建加密后的 `managed-zones.enc`
- 写入 `systemd` 服务 `cf-dns-bot`
- 启用并启动服务

## 首次部署时需要你做什么

脚本会提示你输入：

- 加密主密钥
如果留空，脚本会自动生成一串随机密钥
- `TG_BOT_TOKEN`
- `TG_ALLOWED_USER_ID`
可留空，但建议填写

如果压缩包里已经带了 `app-secrets.enc` 或 `managed-zones.enc`：

- 必须输入原来的加密主密钥
- 不能留空自动生成
- 否则旧的加密数据无法解密

## 数据保存方式

- Telegram 敏感信息保存在 `app-secrets.enc`
- 域名和 Cloudflare Token 保存在 `managed-zones.enc`
- 加密主密钥保存在 `/etc/cf-dns-bot/master.key`

## 常用命令

```bash
systemctl status cf-dns-bot
journalctl -u cf-dns-bot -f
systemctl restart cf-dns-bot
```
