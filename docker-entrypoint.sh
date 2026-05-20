#!/bin/sh
set -eu

APP_DATA_DIR="${CF_DNS_BOT_DATA_DIR:-/app/data}"
RUNTIME_KEY_FILE="/run/cf-dns-bot/master.key"

mkdir -p "$APP_DATA_DIR" /run/cf-dns-bot
cd "$APP_DATA_DIR"

if [ -n "${CF_DNS_BOT_MASTER_KEY:-}" ]; then
  umask 077
  printf '%s\n' "$CF_DNS_BOT_MASTER_KEY" > "$RUNTIME_KEY_FILE"
  export CF_DNS_BOT_KEY_FILE="$RUNTIME_KEY_FILE"
  unset CF_DNS_BOT_MASTER_KEY
fi

if [ -n "${CF_DNS_BOT_KEY_FILE:-}" ] && [ ! -f "$CF_DNS_BOT_KEY_FILE" ]; then
  echo "CF_DNS_BOT_KEY_FILE does not exist: $CF_DNS_BOT_KEY_FILE" >&2
  exit 1
fi

if [ -z "${CF_DNS_BOT_KEY_FILE:-}" ] && [ ! -f "$RUNTIME_KEY_FILE" ]; then
  echo "Missing master key. Set CF_DNS_BOT_MASTER_KEY or mount a key file and set CF_DNS_BOT_KEY_FILE." >&2
  exit 1
fi

if [ ! -f app-secrets.enc ]; then
  if [ -z "${TG_BOT_TOKEN:-}" ]; then
    echo "Missing TG_BOT_TOKEN for first startup." >&2
    exit 1
  fi

  node /app/runtime/secure-store.mjs write-app-secrets app-secrets.enc >/dev/null
fi

if [ ! -f managed-zones.enc ]; then
  if [ -f managed-zones.json ]; then
    node /app/runtime/secure-store.mjs encrypt-managed-zones managed-zones.json managed-zones.enc >/dev/null
    rm -f managed-zones.json
  else
    node /app/runtime/secure-store.mjs write-empty-zones managed-zones.enc >/dev/null
  fi
fi

unset TG_BOT_TOKEN
unset TG_ALLOWED_USER_ID

exec "$@"
