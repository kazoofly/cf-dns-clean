#!/usr/bin/env bash
set -euo pipefail

APP_NAME="cf-dns-bot"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR_DEFAULT="/opt/${APP_NAME}-docker"
CONTAINER_NAME_DEFAULT="${CF_DNS_BOT_CONTAINER_NAME:-cf-dns-bot}"
IMAGE_NAME_DEFAULT="${CF_DNS_BOT_IMAGE:-cf-dns-bot:local}"

log() {
  printf '[docker-deploy] %s\n' "$1"
}

fail() {
  printf '[docker-deploy] 错误: %s\n' "$1" >&2
  exit 1
}

require_root() {
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    exec sudo bash "$0" "$@"
  fi

  fail "请使用 root 身份运行此脚本。"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

generate_secret() {
  if command_exists openssl; then
    openssl rand -base64 32 | tr -d '\n'
    return
  fi

  head -c 32 /dev/urandom | base64 | tr -d '\n'
}

ensure_docker() {
  command_exists docker || fail "未检测到 Docker。请先安装 Docker。"
  docker compose version >/dev/null 2>&1 || fail "未检测到 docker compose。请先安装 Compose 插件。"
}

sync_project_files() {
  local app_dir="$1"

  mkdir -p "${app_dir}"
  cp -f "${SCRIPT_DIR}/Dockerfile" "${app_dir}/"
  cp -f "${SCRIPT_DIR}/docker-compose.yml" "${app_dir}/"
  cp -f "${SCRIPT_DIR}/docker-entrypoint.sh" "${app_dir}/"
  cp -f "${SCRIPT_DIR}/package.json" "${app_dir}/"
  cp -f "${SCRIPT_DIR}/secure-store.mjs" "${app_dir}/"
  cp -f "${SCRIPT_DIR}/tg-cf-dns-bot.mjs" "${app_dir}/"

  if [ -f "${SCRIPT_DIR}/.dockerignore" ]; then
    cp -f "${SCRIPT_DIR}/.dockerignore" "${app_dir}/"
  fi
}

ensure_key_file() {
  local key_file="$1"
  local key_dir=""
  local master_key=""

  key_dir="$(dirname "${key_file}")"
  mkdir -p "${key_dir}"
  chmod 700 "${key_dir}"

  if [ -f "${key_file}" ]; then
    chmod 600 "${key_file}"
    log "保留现有主密钥文件。"
    return
  fi

  printf '请输入 Docker 部署使用的加密主密钥（可留空，留空则自动生成）: '
  read -r -s master_key
  printf '\n'

  if [ -z "${master_key}" ]; then
    master_key="$(generate_secret)"
    log "已自动生成加密主密钥。"
  fi

  printf '%s\n' "${master_key}" > "${key_file}"
  chmod 600 "${key_file}"
}

prompt_telegram_secrets() {
  local data_dir="$1"
  local target_token_var="$2"
  local target_user_var="$3"
  local tg_token=""
  local tg_allowed_user_id=""

  if [ -f "${data_dir}/app-secrets.enc" ]; then
    printf -v "${target_token_var}" '%s' ""
    printf -v "${target_user_var}" '%s' ""
    log "检测到现有加密 Telegram 密钥文件，本次无需重新输入 TG_BOT_TOKEN。"
    return
  fi

  printf '请输入 TG_BOT_TOKEN: '
  read -r -s tg_token
  printf '\n'
  [ -n "${tg_token}" ] || fail "TG_BOT_TOKEN 不能为空。"

  printf '请输入 TG_ALLOWED_USER_ID（必填）: '
  read -r tg_allowed_user_id
  [ -n "${tg_allowed_user_id}" ] || fail "TG_ALLOWED_USER_ID 不能为空。"

  printf -v "${target_token_var}" '%s' "${tg_token}"
  printf -v "${target_user_var}" '%s' "${tg_allowed_user_id}"
}

write_env_file() {
  local env_file="$1"
  local container_name="$2"
  local image_name="$3"
  local data_dir="$4"
  local key_file="$5"
  local tg_token="$6"
  local tg_allowed_user_id="$7"

  cat > "${env_file}" <<EOF
CF_DNS_BOT_CONTAINER_NAME=${container_name}
CF_DNS_BOT_IMAGE=${image_name}
CF_DNS_BOT_DOCKER_DATA_DIR=${data_dir}
CF_DNS_BOT_DOCKER_KEY_FILE=${key_file}
POLL_TIMEOUT_SECONDS=30
RECORDS_PER_PAGE=5
RECORDS_CACHE_TTL_MS=15000
EOF

  if [ -n "${tg_token}" ]; then
    printf 'TG_BOT_TOKEN=%s\n' "${tg_token}" >> "${env_file}"
    printf 'TG_ALLOWED_USER_ID=%s\n' "${tg_allowed_user_id}" >> "${env_file}"
  fi

  chmod 600 "${env_file}"
}

strip_bootstrap_secrets() {
  local env_file="$1"
  local temp_file="${env_file}.tmp"

  grep -v '^TG_BOT_TOKEN=' "${env_file}" | grep -v '^TG_ALLOWED_USER_ID=' > "${temp_file}" || true
  mv "${temp_file}" "${env_file}"
  chmod 600 "${env_file}"
}

wait_for_bootstrap_files() {
  local data_dir="$1"
  local retries=20

  while [ "${retries}" -gt 0 ]; do
    if [ -f "${data_dir}/app-secrets.enc" ] && [ -f "${data_dir}/managed-zones.enc" ]; then
      return 0
    fi
    sleep 1
    retries=$((retries - 1))
  done

  return 1
}

show_summary() {
  local env_file="$1"
  local compose_file="$2"
  local state_dir="$3"

  log "Docker 部署完成。"
  log "运行目录: ${state_dir}"
  log "常用命令:"
  printf '  docker compose --env-file %s -f %s logs -f\n' "${env_file}" "${compose_file}"
  printf '  docker compose --env-file %s -f %s restart\n' "${env_file}" "${compose_file}"
  printf '  docker compose --env-file %s -f %s up -d --build\n' "${env_file}" "${compose_file}"
}

main() {
  local state_dir=""
  local app_dir=""
  local data_dir=""
  local env_file=""
  local key_file=""
  local compose_file=""
  local tg_token=""
  local tg_allowed_user_id=""
  local container_name="${CONTAINER_NAME_DEFAULT}"
  local image_name="${IMAGE_NAME_DEFAULT}"

  require_root "$@"
  ensure_docker

  state_dir="${1:-${STATE_DIR_DEFAULT}}"
  app_dir="${state_dir}/app"
  data_dir="${state_dir}/data"
  env_file="${state_dir}/docker.env"
  key_file="${state_dir}/secrets/master.key"
  compose_file="${app_dir}/docker-compose.yml"

  mkdir -p "${state_dir}" "${data_dir}"
  chmod 700 "${state_dir}" "${data_dir}"

  sync_project_files "${app_dir}"
  ensure_key_file "${key_file}"
  prompt_telegram_secrets "${data_dir}" tg_token tg_allowed_user_id
  write_env_file "${env_file}" "${container_name}" "${image_name}" "${data_dir}" "${key_file}" "${tg_token}" "${tg_allowed_user_id}"

  if ! docker compose --env-file "${env_file}" -f "${compose_file}" up -d --build; then
    if [ -n "${tg_token}" ]; then
      strip_bootstrap_secrets "${env_file}"
    fi
    docker compose --env-file "${env_file}" -f "${compose_file}" down --remove-orphans || true
    fail "Docker 启动失败，已从 docker.env 移除明文 Telegram 启动信息。"
  fi

  if [ -n "${tg_token}" ]; then
    strip_bootstrap_secrets "${env_file}"
    if wait_for_bootstrap_files "${data_dir}"; then
      strip_bootstrap_secrets "${env_file}"
      docker compose --env-file "${env_file}" -f "${compose_file}" up -d --force-recreate --no-build
      log "已从 Docker 环境文件移除明文 Telegram 启动信息。"
    else
      log "警告: 启动后未及时检测到加密文件，已移除 docker.env 里的 Telegram 启动信息。"
    fi
    if [ ! -f "${data_dir}/app-secrets.enc" ] || [ ! -f "${data_dir}/managed-zones.enc" ]; then
      docker compose --env-file "${env_file}" -f "${compose_file}" down --remove-orphans || true
      fail "启动后未及时生成加密密钥文件，已移除明文 Telegram 启动信息。请检查容器日志后重新执行脚本。"
    fi
  fi
  show_summary "${env_file}" "${compose_file}" "${state_dir}"
}

main "$@"
