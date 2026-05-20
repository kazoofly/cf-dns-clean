# Docker 源码构建部署说明

这份说明适合以下场景：

- 你想用 Docker 跑这个项目
- 你手里有完整源码
- 你愿意让 VPS 本机直接构建镜像

## 部署方式

项目自带一键脚本：

- `docker-deploy.sh`

它会自动：

- 检查 `docker` 和 `docker compose`
- 把运行所需文件复制到 `/opt/cf-dns-bot-docker/app`
- 创建数据目录和主密钥目录
- 首次启动时提示你输入 Telegram 相关信息
- 执行 `docker compose up -d --build`

## 部署前准备

你需要准备：

- 一台已安装 Docker 和 Docker Compose 的 Linux VPS
- 一个 Telegram Bot Token
- Telegram 用户 ID

## 部署步骤

1. 下载或克隆项目到服务器
2. 进入项目目录

```bash
cd cf-dns-clean
```

3. 执行部署脚本

```bash
bash docker-deploy.sh
```

4. 按提示输入

脚本会提示你输入：

- Docker 部署使用的加密主密钥
- `TG_BOT_TOKEN`
- `TG_ALLOWED_USER_ID`（必填，只允许这个 Telegram 用户操作）

## 运行目录

默认运行目录：

```bash
/opt/cf-dns-bot-docker
```

里面主要包含：

- `app/`
- `data/`
- `secrets/master.key`
- `docker.env`

## 常用命令

查看日志：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml logs -f
```

重启：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml restart
```

重新构建并启动：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml up -d --build
```

## 数据保存方式

Docker 运行后，数据保存在：

- `/opt/cf-dns-bot-docker/data/app-secrets.enc`
- `/opt/cf-dns-bot-docker/data/managed-zones.enc`
- `/opt/cf-dns-bot-docker/secrets/master.key`

## 升级方式

更新源码后，再次执行：

```bash
bash docker-deploy.sh
```

脚本会重新同步运行文件，并保留已有加密数据。
