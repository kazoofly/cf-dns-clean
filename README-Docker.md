# Docker 部署说明

这个项目现在提供 2 种 Docker 部署方式，已经不再推荐手工改 `docker-compose.yml` 或手动导出一堆环境变量。

## 方式一：本地源码一键 Docker 部署

适合下载源码后在 VPS 本机直接构建镜像并运行。

执行：

```bash
bash docker-deploy.sh
```

脚本会自动做这些事：

- 检查 `docker` 和 `docker compose`
- 把 Docker 运行所需文件复制到 `/opt/cf-dns-bot-docker/app`
- 创建数据目录 `/opt/cf-dns-bot-docker/data`
- 创建主密钥文件 `/opt/cf-dns-bot-docker/secrets/master.key`
- 首次启动时提示你输入 `TG_BOT_TOKEN` 和必填的 `TG_ALLOWED_USER_ID`
- 自动执行 `docker compose up -d --build`
- 生成加密后的 `app-secrets.enc`、`managed-zones.enc`
- 启动成功后，把 `docker.env` 里的明文 Telegram 启动信息清掉

## 方式二：使用 GitHub 自动构建的 GHCR 镜像部署

项目已内置 GitHub Actions 工作流：

- `.github/workflows/docker-image.yml`

仓库会在这些场景自动构建并发布镜像到 `GHCR`：

- 推送到 `main`
- 推送到 `master`
- 推送 `v*` 标签
- 在 GitHub Actions 页面手动触发

默认镜像名就是：

```bash
ghcr.io/kazoofly/cf-dns-clean:latest
```

仓库地址：

```bash
https://github.com/kazoofly/cf-dns-clean
```

镜像发布好以后，在 VPS 上执行：

```bash
bash docker-image-deploy.sh ghcr.io/kazoofly/cf-dns-clean:latest
```

它会自动：

- 创建 `/opt/cf-dns-bot-docker` 运行目录
- 创建主密钥文件和数据目录
- 首次启动时提示你输入 `TG_BOT_TOKEN` 和必填的 `TG_ALLOWED_USER_ID`
- 自动 `pull` 镜像并启动

发布版本标签时，例如：

```bash
git tag v1.0.0
git push origin v1.0.0
```

那也会自动生成对应的版本镜像标签。

## 运行目录

Docker 运行目录默认是：

```bash
/opt/cf-dns-bot-docker
```

里面主要会有：

- `app/`：Docker 运行用的 compose 文件
- `data/`：加密后的 `app-secrets.enc`、`managed-zones.enc`
- `secrets/master.key`：主密钥文件
- `docker.env`：Docker Compose 使用的运行参数

## 常用命令

源码构建方式：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml logs -f
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml restart
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.yml up -d --build
```

镜像方式：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml logs -f
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml pull
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml up -d
```
