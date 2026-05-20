#!/usr/bin/env bash
set -euo pipefail

APP_NAME="cf-dns-bot"
APP_USER="cfbot"
APP_GROUP="cfbot"
APP_DIR="/opt/${APP_NAME}"
SERVICE_NAME="${APP_NAME}"
KEY_DIR="/etc/${APP_NAME}"
KEY_FILE="${KEY_DIR}/master.key"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
  printf '[deploy] %s\n' "$1"
}

fail() {
  printf '[deploy] 错误: %s\n' "$1" >&2
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

get_nologin_shell() {
  if command_exists nologin; then
    command -v nologin
    return
  fi

  if [ -x /usr/sbin/nologin ]; then
    printf '/usr/sbin/nologin\n'
    return
  fi

  if [ -x /sbin/nologin ]; then
    printf '/sbin/nologin\n'
    return
  fi

  printf '/bin/false\n'
}

install_packages_apt() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y curl ca-certificates
}

install_packages_dnf() {
  dnf install -y curl ca-certificates
}

install_packages_yum() {
  yum install -y curl ca-certificates
}

install_base_packages() {
  if command_exists apt-get; then
    install_packages_apt
    return
  fi

  if command_exists dnf; then
    install_packages_dnf
    return
  fi

  if command_exists yum; then
    install_packages_yum
    return
  fi

  fail "不支持当前系统的包管理器，请手动安装 curl、ca-certificates 和 Node.js 18+。"
}

install_nodejs() {
  log "正在安装 Node.js 20..."
  install_base_packages

  if command_exists apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    return
  fi

  if command_exists dnf; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
    return
  fi

  if command_exists yum; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
    return
  fi

  fail "无法自动安装 Node.js。"
}

ensure_nodejs() {
  local major

  if command_exists node; then
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "${major}" -ge 18 ]; then
      log "检测到 Node.js $(node -v)。"
      return
    fi
  fi

  install_nodejs
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "${major}" -lt 18 ]; then
    fail "需要 Node.js 18 或更高版本。"
  fi
}

ensure_service_user() {
  if getent group "${APP_GROUP}" >/dev/null 2>&1; then
    :
  else
    groupadd --system "${APP_GROUP}"
  fi

  if id -u "${APP_USER}" >/dev/null 2>&1; then
    return
  fi

  useradd \
    --system \
    --gid "${APP_GROUP}" \
    --home-dir "${APP_DIR}" \
    --shell "$(get_nologin_shell)" \
    "${APP_USER}"
}

copy_project_files() {
  mkdir -p "${APP_DIR}"

  cp -f "${SCRIPT_DIR}/tg-cf-dns-bot.mjs" "${APP_DIR}/"
  cp -f "${SCRIPT_DIR}/secure-store.mjs" "${APP_DIR}/"
  cp -f "${SCRIPT_DIR}/package.json" "${APP_DIR}/"
  cp -f "${SCRIPT_DIR}/README.md" "${APP_DIR}/"
  cp -f "${SCRIPT_DIR}/README-VPS.md" "${APP_DIR}/"
  cp -f "${SCRIPT_DIR}/.env.example" "${APP_DIR}/"

  if [ -f "${SCRIPT_DIR}/app-secrets.enc" ]; then
    cp -f "${SCRIPT_DIR}/app-secrets.enc" "${APP_DIR}/"
  fi

  if [ -f "${SCRIPT_DIR}/managed-zones.enc" ]; then
    cp -f "${SCRIPT_DIR}/managed-zones.enc" "${APP_DIR}/"
  fi
}

upsert_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"

  if [ -f "${env_file}" ] && grep -q "^${key}=" "${env_file}"; then
    sed -i "s#^${key}=.*#${key}=${value}#" "${env_file}"
    return
  fi

  printf '%s=%s\n' "${key}" "${value}" >> "${env_file}"
}

write_env_file() {
  local env_file="${APP_DIR}/.env"

  if [ ! -f "${env_file}" ]; then
    cat > "${env_file}" <<EOF
CF_DNS_BOT_KEY_FILE=${KEY_FILE}
POLL_TIMEOUT_SECONDS=30
RECORDS_PER_PAGE=5
RECORDS_CACHE_TTL_MS=15000
EOF
    log "已创建 ${env_file}。"
  fi

  upsert_env_value "${env_file}" "CF_DNS_BOT_KEY_FILE" "${KEY_FILE}"
  upsert_env_value "${env_file}" "POLL_TIMEOUT_SECONDS" "30"
  upsert_env_value "${env_file}" "RECORDS_PER_PAGE" "5"
  upsert_env_value "${env_file}" "RECORDS_CACHE_TTL_MS" "15000"
}

ensure_key_file() {
  local master_key=""
  local has_packaged_encrypted_secrets="0"

  if [ -f "${SCRIPT_DIR}/app-secrets.enc" ] || [ -f "${SCRIPT_DIR}/managed-zones.enc" ]; then
    has_packaged_encrypted_secrets="1"
  fi

  mkdir -p "${KEY_DIR}"
  chown root:"${APP_GROUP}" "${KEY_DIR}"
  chmod 750 "${KEY_DIR}"

  if [ -f "${KEY_FILE}" ]; then
    chown root:"${APP_GROUP}" "${KEY_FILE}"
    chmod 640 "${KEY_FILE}"
    log "保留现有加密主密钥文件。"
    return
  fi

  if [ "${has_packaged_encrypted_secrets}" = "1" ]; then
    printf '\n请输入原来的加密主密钥（当前压缩包已包含加密数据）: '
  else
    printf '\n请输入加密主密钥（可留空，留空则自动生成）: '
  fi
  read -r master_key

  if [ -z "${master_key}" ]; then
    if [ "${has_packaged_encrypted_secrets}" = "1" ]; then
      fail "当前压缩包已包含加密数据，必须输入原来的加密主密钥。"
    fi
    master_key="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
    log "已自动生成加密主密钥。"
  fi

  printf '%s\n' "${master_key}" > "${KEY_FILE}"
  chown root:"${APP_GROUP}" "${KEY_FILE}"
  chmod 640 "${KEY_FILE}"
}

validate_packaged_encrypted_files() {
  if [ -f "${APP_DIR}/app-secrets.enc" ]; then
    CF_DNS_BOT_KEY_FILE="${KEY_FILE}" \
    node "${APP_DIR}/secure-store.mjs" validate-app-secrets "${APP_DIR}/app-secrets.enc" >/dev/null
  fi

  if [ -f "${APP_DIR}/managed-zones.enc" ]; then
    CF_DNS_BOT_KEY_FILE="${KEY_FILE}" \
    node "${APP_DIR}/secure-store.mjs" validate-managed-zones "${APP_DIR}/managed-zones.enc" >/dev/null
  fi

  log "已验证现有加密文件可被当前主密钥解密。"
}

write_app_secrets() {
  local tg_token=""
  local tg_allowed_user_id=""
  local target_file="${APP_DIR}/app-secrets.enc"

  if [ -f "${target_file}" ]; then
    log "保留现有加密 Telegram 密钥文件。"
    return
  fi

  printf '请输入 TG_BOT_TOKEN: '
  read -r tg_token
  [ -n "${tg_token}" ] || fail "TG_BOT_TOKEN 不能为空。"

  printf '请输入 TG_ALLOWED_USER_ID（可留空）: '
  read -r tg_allowed_user_id

  CF_DNS_BOT_KEY_FILE="${KEY_FILE}" \
  TG_BOT_TOKEN="${tg_token}" \
  TG_ALLOWED_USER_ID="${tg_allowed_user_id}" \
  node "${APP_DIR}/secure-store.mjs" write-app-secrets "${target_file}" >/dev/null

  log "已写入加密后的 Telegram 密钥文件。"
}

ensure_managed_zones_file() {
  local encrypted_file="${APP_DIR}/managed-zones.enc"
  local legacy_file="${APP_DIR}/managed-zones.json"

  if [ -f "${encrypted_file}" ]; then
    log "保留现有加密域名数据文件。"
    return
  fi

  if [ -f "${legacy_file}" ]; then
    CF_DNS_BOT_KEY_FILE="${KEY_FILE}" \
    node "${APP_DIR}/secure-store.mjs" encrypt-managed-zones "${legacy_file}" "${encrypted_file}" >/dev/null
    rm -f "${legacy_file}"
    log "已把旧版明文域名数据迁移为加密文件。"
    return
  fi

  CF_DNS_BOT_KEY_FILE="${KEY_FILE}" \
  node "${APP_DIR}/secure-store.mjs" write-empty-zones "${encrypted_file}" >/dev/null

  log "已创建空的加密域名数据文件。"
}

write_service_file() {
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Telegram Cloudflare DNS Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/env node ${APP_DIR}/tg-cf-dns-bot.mjs
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
}

set_permissions() {
  chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
  chmod 750 "${APP_DIR}"
  chmod 640 "${APP_DIR}/.env"

  if [ -f "${APP_DIR}/app-secrets.enc" ]; then
    chmod 640 "${APP_DIR}/app-secrets.enc"
  fi

  if [ -f "${APP_DIR}/managed-zones.enc" ]; then
    chmod 640 "${APP_DIR}/managed-zones.enc"
  fi

  chown root:"${APP_GROUP}" "${KEY_DIR}" "${KEY_FILE}"
  chmod 750 "${KEY_DIR}"
  chmod 640 "${KEY_FILE}"
}

start_service() {
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"
}

show_summary() {
  log "部署完成。"
  log "项目目录: ${APP_DIR}"
  log "服务名称: ${SERVICE_NAME}"
  log "加密主密钥文件: ${KEY_FILE}"
  log "常用命令:"
  printf '  systemctl status %s\n' "${SERVICE_NAME}"
  printf '  journalctl -u %s -f\n' "${SERVICE_NAME}"
  printf '  systemctl restart %s\n' "${SERVICE_NAME}"
}

main() {
  require_root "$@"
  ensure_nodejs
  ensure_service_user
  copy_project_files
  write_env_file
  ensure_key_file
  validate_packaged_encrypted_files
  write_app_secrets
  ensure_managed_zones_file
  write_service_file
  set_permissions
  start_service
  show_summary
}

main "$@"
