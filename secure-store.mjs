import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENCRYPTION_VERSION = 1;
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const SALT_BYTES = 16;
const IV_BYTES = 12;

export function resolveKeyFilePath(configuredPath = "", cwdArg) {
  const cwd =
    cwdArg ||
    (typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : ".");
  const trimmed = String(configuredPath || "").trim();
  if (trimmed) {
    return path.resolve(cwd, trimmed);
  }

  const systemPath = "/etc/cf-dns-bot/master.key";
  if (fs.existsSync(systemPath)) {
    return systemPath;
  }

  return path.join(cwd, "master.key");
}

export function readMasterSecret(options = {}) {
  const envValue = getProcessEnvValue("CF_DNS_BOT_MASTER_KEY");
  if (envValue) {
    return envValue;
  }

  const keyFilePath = resolveKeyFilePath(options.keyFilePath, options.cwd);
  if (!fs.existsSync(keyFilePath)) {
    throw new Error(`missing master key file: ${keyFilePath}`);
  }

  const secret = fs.readFileSync(keyFilePath, "utf8").trim();
  if (!secret) {
    throw new Error(`master key file is empty: ${keyFilePath}`);
  }

  return secret;
}

export function readEncryptedJsonFile(filePath, masterSecret, purpose, fallbackValue = null) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return fallbackValue;
  }

  return decryptJson(raw, masterSecret, purpose);
}

export function writeEncryptedJsonFile(filePath, value, masterSecret, purpose) {
  const payload = encryptJson(value, masterSecret, purpose);
  writeTextFileAtomic(filePath, payload);
}

export function sanitizeEnvFile(filePath, keysToRemove) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const blockedKeys = new Set((keysToRemove || []).map((key) => String(key || "").trim()).filter(Boolean));
  if (blockedKeys.size === 0) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const nextLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      nextLines.push(line);
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      nextLines.push(line);
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    if (blockedKeys.has(key)) {
      continue;
    }

    nextLines.push(line);
  }

  const normalized = trimTrailingBlankLines(nextLines).join("\n");
  writeTextFileAtomic(filePath, normalized ? `${normalized}\n` : "");
}

export function parseJsonFile(filePath, fallbackValue = null) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return fallbackValue;
  }

  return JSON.parse(raw);
}

export function createEmptyZonesPayload() {
  return { zones: [] };
}

export function writeMasterKeyFile(filePath, masterSecret) {
  const secret = String(masterSecret || "").trim();
  if (!secret) {
    throw new Error("master secret is empty");
  }

  writeTextFileAtomic(filePath, `${secret}\n`);
}

function encryptJson(value, masterSecret, purpose) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = crypto.scryptSync(masterSecret, salt, 32);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const aad = Buffer.from(String(purpose || "default"), "utf8");
  cipher.setAAD(aad);

  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${JSON.stringify(
    {
      version: ENCRYPTION_VERSION,
      algorithm: ENCRYPTION_ALGORITHM,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encrypted.toString("base64"),
    },
    null,
    2,
  )}\n`;
}

function decryptJson(raw, masterSecret, purpose) {
  const parsed = JSON.parse(raw);
  if (Number(parsed?.version) !== ENCRYPTION_VERSION) {
    throw new Error("unsupported encrypted payload version");
  }

  if (parsed?.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error("unsupported encrypted payload algorithm");
  }

  const salt = Buffer.from(String(parsed.salt || ""), "base64");
  const iv = Buffer.from(String(parsed.iv || ""), "base64");
  const tag = Buffer.from(String(parsed.tag || ""), "base64");
  const data = Buffer.from(String(parsed.data || ""), "base64");
  const key = crypto.scryptSync(masterSecret, salt, 32);
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const aad = Buffer.from(String(purpose || "default"), "utf8");
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

function writeTextFileAtomic(filePath, text) {
  const targetDir = path.dirname(filePath);
  fs.mkdirSync(targetDir, { recursive: true });

  const pid = typeof process !== "undefined" && process?.pid ? process.pid : "noproc";
  const tempPath = `${filePath}.tmp-${pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function trimTrailingBlankLines(lines) {
  const result = lines.slice();
  while (result.length > 0 && !String(result[result.length - 1] || "").trim()) {
    result.pop();
  }
  return result;
}

function requiredEnv(name) {
  const value = getProcessEnvValue(name);
  if (!value) {
    throw new Error(`missing required env: ${name}`);
  }
  return value;
}

function getProcessEnvValue(name) {
  if (typeof process === "undefined" || !process?.env) {
    return "";
  }

  return String(process.env[name] || "").trim();
}

function runCli() {
  const [command, ...args] = process.argv.slice(2);
  const cwd = process.cwd();

  if (command === "write-master-key") {
    const outputFilePath = path.resolve(cwd, args[0] || "master.key");
    const explicitSecret = String(args[1] || "").trim();
    const generatedSecret = crypto.randomBytes(32).toString("base64url");
    writeMasterKeyFile(outputFilePath, explicitSecret || generatedSecret);
    process.stdout.write(`${outputFilePath}\n`);
    return;
  }

  const keyFilePath = resolveKeyFilePath(process.env.CF_DNS_BOT_KEY_FILE, cwd);
  const masterSecret = readMasterSecret({ keyFilePath, cwd });

  if (command === "write-app-secrets") {
    const outputFilePath = path.resolve(cwd, args[0] || "app-secrets.enc");
    writeEncryptedJsonFile(
      outputFilePath,
      {
        tgToken: requiredEnv("TG_BOT_TOKEN"),
        tgAllowedUserId: requiredEnv("TG_ALLOWED_USER_ID"),
      },
      masterSecret,
      "app-secrets",
    );
    process.stdout.write(`${outputFilePath}\n`);
    return;
  }

  if (command === "write-empty-zones") {
    const outputFilePath = path.resolve(cwd, args[0] || "managed-zones.enc");
    writeEncryptedJsonFile(outputFilePath, createEmptyZonesPayload(), masterSecret, "managed-zones");
    process.stdout.write(`${outputFilePath}\n`);
    return;
  }

  if (command === "encrypt-managed-zones") {
    const inputFilePath = path.resolve(cwd, args[0] || "managed-zones.json");
    const outputFilePath = path.resolve(cwd, args[1] || "managed-zones.enc");
    const payload = parseJsonFile(inputFilePath, createEmptyZonesPayload()) || createEmptyZonesPayload();
    writeEncryptedJsonFile(outputFilePath, payload, masterSecret, "managed-zones");
    process.stdout.write(`${outputFilePath}\n`);
    return;
  }

  if (command === "validate-app-secrets") {
    const inputFilePath = path.resolve(cwd, args[0] || "app-secrets.enc");
    readEncryptedJsonFile(inputFilePath, masterSecret, "app-secrets");
    process.stdout.write("ok\n");
    return;
  }

  if (command === "validate-managed-zones") {
    const inputFilePath = path.resolve(cwd, args[0] || "managed-zones.enc");
    readEncryptedJsonFile(inputFilePath, masterSecret, "managed-zones");
    process.stdout.write("ok\n");
    return;
  }

  process.stderr.write(
    [
      "Usage:",
      "  node secure-store.mjs write-master-key [outputFile] [secret]",
      "  node secure-store.mjs write-app-secrets [outputFile]",
      "  node secure-store.mjs write-empty-zones [outputFile]",
      "  node secure-store.mjs encrypt-managed-zones [inputFile] [outputFile]",
      "  node secure-store.mjs validate-app-secrets [inputFile]",
      "  node secure-store.mjs validate-managed-zones [inputFile]",
    ].join("\n"),
  );
  process.exitCode = 1;
}

const currentFilePath = fileURLToPath(import.meta.url);
const entryFilePath =
  typeof process !== "undefined" && Array.isArray(process.argv) && process.argv[1]
    ? path.resolve(process.argv[1])
    : "";
if (entryFilePath && currentFilePath === entryFilePath) {
  runCli();
}
