# Linux VPS 一键部署说明

这份说明适合以下场景：

- 你有一台普通 Linux VPS
- 你不想使用 Docker
- 需要机器人以 `systemd` 服务方式长期运行

## 部署方式

项目自带一键部署脚本：

- `deploy.sh`

它会自动：

- 安装 Node.js 20（如果系统里没有可用的 Node.js 18+）
- 创建运行用户 `cfbot`
- 把项目部署到 `/opt/cf-dns-bot`
- 创建加密主密钥文件
- 创建 Telegram 敏感信息加密文件
- 创建域名数据加密文件
- 写入并启动 `systemd` 服务

## 部署前准备

你需要准备：

- 一台带 `systemd` 的 Linux VPS
- 一个 Telegram Bot Token
- Telegram 用户 ID

建议系统：

- Ubuntu 22.04 / 24.04
- Debian 12
- 其他带 `systemd` 的主流 Linux 发行版

## 部署步骤

1. 下载或克隆项目到服务器

可以使用 `git clone`、下载 GitHub 压缩包、SFTP 等任意方式。

2. 进入项目目录

```bash
cd cf-dns-clean
```

3. 执行部署脚本

```bash
bash deploy.sh
```

4. 按提示输入

脚本会提示你输入：

- 加密主密钥
- `TG_BOT_TOKEN`
- `TG_ALLOWED_USER_ID`（必填，只允许这个 Telegram 用户操作）

如果你第一次部署，不想自己生成主密钥，可以直接回车，让脚本自动生成。

## 部署完成后

服务名是：

```bash
cf-dns-bot
```

常用命令：

```bash
systemctl status cf-dns-bot
journalctl -u cf-dns-bot -f
systemctl restart cf-dns-bot
```

## 数据保存方式

程序运行后会生成这些重要文件：

- `/opt/cf-dns-bot/app-secrets.enc`
- `/opt/cf-dns-bot/managed-zones.enc`
- `/etc/cf-dns-bot/master.key`

其中：

- `app-secrets.enc` 保存 Telegram 相关敏感信息
- `managed-zones.enc` 保存域名和 Cloudflare Token
- `master.key` 是解密主密钥

## 后续使用

部署成功后：

1. 打开 Telegram
2. 给你的机器人发送 `/start`
3. 点击 `域名列表`
4. 点击 `新增域名`
5. 把某个域名专用的 Cloudflare API Token 发给机器人

之后就可以通过机器人管理这个域名的 DNS。

## 升级方式

如果你更新了项目代码，重新进入新版本目录后再次执行：

```bash
bash deploy.sh
```

脚本会尽量保留已有加密数据和主密钥。
