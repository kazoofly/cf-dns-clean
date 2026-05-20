# GitHub 自动构建 GHCR 镜像部署说明

这份说明适合以下场景：

- 项目已经托管在 GitHub
- 使用 GitHub Actions 自动构建 Docker 镜像
- VPS 只负责拉镜像和运行

## 自动构建镜像

项目已内置 GitHub Actions 工作流：

- `.github/workflows/docker-image.yml`

仓库会在这些场景自动构建并发布镜像到 `GHCR`：

- 推送到 `main`
- 推送到 `master`
- 推送 `v*` 标签
- 手动触发工作流

## 默认镜像名

默认镜像名格式：

```bash
ghcr.io/kazoofly/cf-dns-clean:latest
```

仓库地址：

```bash
https://github.com/kazoofly/cf-dns-clean
```

## 第一次发布镜像

1. 确保仓库 Actions 已启用
2. 推送到 `main` 或 `master`

例如：

```bash
git add .
git commit -m "Initial release"
git push origin main
```

推送完成后，GitHub 会自动开始构建并推送镜像。

## 发布版本标签

如果你想生成版本镜像，可以打标签：

```bash
git tag v1.0.0
git push origin v1.0.0
```

这样会额外生成对应的版本标签镜像。

## VPS 部署步骤

当镜像已经发布到 GHCR 后，在 VPS 上执行：

```bash
bash docker-image-deploy.sh ghcr.io/kazoofly/cf-dns-clean:latest
```

脚本会自动：

- 创建 `/opt/cf-dns-bot-docker` 运行目录
- 创建数据目录和主密钥目录
- 首次启动时提示你输入 `TG_BOT_TOKEN`
- 自动拉取镜像并启动

## 如果仓库或镜像是私有的

如果你的 GitHub 仓库是私有的，或者 GHCR 镜像没有公开，需要先在 VPS 上登录：

```bash
docker login ghcr.io
```

然后再执行部署脚本。

## 常用命令

拉取新镜像：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml pull
```

更新并启动：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml up -d
```

查看日志：

```bash
docker compose --env-file /opt/cf-dns-bot-docker/docker.env -f /opt/cf-dns-bot-docker/app/docker-compose.image.yml logs -f
```
