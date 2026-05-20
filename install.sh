#!/usr/bin/env bash
set -euo pipefail

PACKAGE_URL="${1:-${CF_DNS_BOT_PACKAGE_URL:-}}"
PACKAGE_TYPE="${CF_DNS_BOT_PACKAGE_TYPE:-}"
WORK_DIR=""

log() {
  printf '[install] %s\n' "$1"
}

fail() {
  printf '[install] 错误: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "${WORK_DIR}" ] && [ -d "${WORK_DIR}" ]; then
    rm -rf "${WORK_DIR}"
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

infer_package_type() {
  case "$1" in
    *.tar.gz|*.tgz)
      printf 'tar.gz\n'
      ;;
    *.zip)
      printf 'zip\n'
      ;;
    *)
      printf '\n'
      ;;
  esac
}

extract_package() {
  local archive_file="$1"
  local target_dir="$2"
  local package_type="$3"

  mkdir -p "${target_dir}"

  case "${package_type}" in
    tar.gz)
      tar -xzf "${archive_file}" -C "${target_dir}"
      ;;
    zip)
      if ! command_exists unzip; then
        fail "当前压缩包是 zip，但系统没有 unzip。请先安装 unzip，或者改用 .tar.gz 压缩包。"
      fi
      unzip -q "${archive_file}" -d "${target_dir}"
      ;;
    *)
      fail "不支持的压缩包类型。请使用 .tar.gz、.tgz 或 .zip。"
      ;;
  esac
}

find_project_dir() {
  local search_dir="$1"

  if [ -f "${search_dir}/deploy.sh" ]; then
    printf '%s\n' "${search_dir}"
    return
  fi

  local deploy_file
  deploy_file="$(find "${search_dir}" -maxdepth 3 -type f -name deploy.sh | head -n 1 || true)"
  if [ -z "${deploy_file}" ]; then
    fail "解压后没有找到 deploy.sh。"
  fi

  dirname "${deploy_file}"
}

main() {
  [ -n "${PACKAGE_URL}" ] || fail "请传入项目压缩包地址，例如：bash install.sh https://example.com/cf-dns-clean.tar.gz"

  if ! command_exists curl; then
    fail "当前系统没有 curl，无法下载项目压缩包。"
  fi

  if ! command_exists tar; then
    fail "当前系统没有 tar，无法解压项目压缩包。"
  fi

  if [ -z "${PACKAGE_TYPE}" ]; then
    PACKAGE_TYPE="$(infer_package_type "${PACKAGE_URL}")"
  fi

  [ -n "${PACKAGE_TYPE}" ] || fail "无法从地址判断压缩包类型。请设置 CF_DNS_BOT_PACKAGE_TYPE=tar.gz 或 zip。"

  WORK_DIR="$(mktemp -d)"
  trap cleanup EXIT

  local archive_file="${WORK_DIR}/package"
  local extract_dir="${WORK_DIR}/extract"
  local project_dir=""

  log "正在下载项目压缩包..."
  curl -fsSL "${PACKAGE_URL}" -o "${archive_file}"

  log "正在解压项目压缩包..."
  extract_package "${archive_file}" "${extract_dir}" "${PACKAGE_TYPE}"

  project_dir="$(find_project_dir "${extract_dir}")"

  chmod +x "${project_dir}/deploy.sh"
  log "开始执行 deploy.sh..."
  bash "${project_dir}/deploy.sh"
}

main "$@"
