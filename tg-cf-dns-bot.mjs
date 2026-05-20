import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import {
  createEmptyZonesPayload,
  parseJsonFile,
  readEncryptedJsonFile,
  readMasterSecret,
  resolveKeyFilePath,
  sanitizeEnvFile,
  writeEncryptedJsonFile,
} from "./secure-store.mjs";

const SUPPORTED_RECORD_TYPES = ["A", "AAAA", "CNAME"];
const ZONES_PER_PAGE = 8;
const CF_ZONES_API_PAGE_SIZE = 50;
const CF_RECORDS_API_PAGE_SIZE = 100;
const PANEL_WIDTH = 42;
const DNS_LABEL_WIDTH = 8;
const DETAIL_LABEL_WIDTH = 4;

const cwd = process.cwd();
const envFilePath = path.join(cwd, ".env");
const appSecretsFilePath = path.join(cwd, "app-secrets.enc");
const legacyManagedZonesFilePath = path.join(cwd, "managed-zones.json");
const managedZonesFilePath = path.join(cwd, "managed-zones.enc");

loadEnv(envFilePath);
const keyFilePath = resolveKeyFilePath(process.env.CF_DNS_BOT_KEY_FILE, cwd);
const masterSecret = loadMasterSecretIfNeeded();

migrateLegacySensitiveFiles();
hydrateSensitiveEnv();

const config = {
  tgToken: required("TG_BOT_TOKEN"),
  tgAllowedUserId: process.env.TG_ALLOWED_USER_ID?.trim() || "",
  pollTimeoutSeconds: clampInt(process.env.POLL_TIMEOUT_SECONDS, 30, 5, 50),
  recordsPerPage: clampInt(process.env.RECORDS_PER_PAGE, 5, 5, 5),
  recordsCacheTtlMs: clampInt(process.env.RECORDS_CACHE_TTL_MS, 15000, 3000, 60000),
};

const managedZonesStore = createManagedZonesStore(managedZonesFilePath, masterSecret);
const sessions = new Map();
const recordListCache = new Map();
const recordListInflight = new Map();
let updateOffset = 0;

main().catch((error) => {
  log(`fatal: ${formatError(error)}`);
  process.exitCode = 1;
});

async function main() {
  log("Telegram Cloudflare DNS bot starting...");

  if (!config.tgAllowedUserId) {
    throw new Error("TG_ALLOWED_USER_ID is required; refusing to start without an authorized Telegram user ID");
  }

  await verifySetup();

  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset: updateOffset,
        timeout: config.pollTimeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        updateOffset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          log(`update error: ${formatError(error)}`);
          await notifyUpdateError(update, error);
        }
      }
    } catch (error) {
      log(`poll error: ${formatError(error)}`);
      await sleep(3000);
    }
  }
}

async function verifySetup() {
  const me = await tg("getMe", {});
  log(`telegram bot: @${me.username}`);
  log(`managed zones loaded: ${managedZonesStore.count()}`);
}

async function handleUpdate(update) {
  if (update.message) {
    await handleMessage(update.message);
    return;
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query);
  }
}

async function handleMessage(message) {
  const userId = String(message.from?.id ?? "");
  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  const isCommandMessage = text.startsWith("/");

  if (!chatId || !text) {
    return;
  }

  if (!isPrivateChat(message.chat)) {
    if (isCommandMessage || sessions.get(userId)?.pending) {
      await safeDeleteMessage(chatId, message.message_id);
    }
    return;
  }

  if (!isAllowedUser(userId)) {
    await sendText(
      chatId,
      `这个机器人没有授权给你的账号。\n你的 Telegram 用户 ID: <code>${escapeHtml(userId)}</code>`,
      { replyToMessageId: message.message_id },
    );
    return;
  }

  const session = getSession(userId);

  if (text === "/cancel") {
    const pendingPromptMessageId = session.pendingPromptMessageId;
    clearPendingState(session);
    session.pageSelection = createPageSelectionState();
    await safeDeleteMessage(chatId, pendingPromptMessageId);
    await sendText(chatId, buildWelcomeText(), {
      replyMarkup: mainMenu(),
    });
    await safeDeleteMessage(chatId, message.message_id);
    return;
  }

  if (text === "/start") {
    clearPendingState(session);
    session.pageSelection = createPageSelectionState();
    await sendText(chatId, buildWelcomeText(), {
      replyMarkup: mainMenu(),
    });
    await safeDeleteMessage(chatId, message.message_id);
    return;
  }

  if (text === "/domains") {
    await sendDomainList(chatId, userId, session.domainPage || 1, message.message_id);
    await safeDeleteMessage(chatId, message.message_id);
    return;
  }

  if (text === "/dns") {
    if (!session.currentZoneId) {
      await sendDomainList(chatId, userId, session.domainPage || 1, message.message_id);
      await safeDeleteMessage(chatId, message.message_id);
      return;
    }

    await sendRecords(chatId, userId, session.recordPage || 1, message.message_id);
    await safeDeleteMessage(chatId, message.message_id);
    return;
  }

  if (session.pending) {
    try {
      await handlePendingText({
        session,
        userId,
        chatId,
        text,
        replyToMessageId: undefined,
      });
    } catch (error) {
      log(`pending input error: ${formatError(error)}`);
      await sendText(chatId, `执行失败：<code>${escapeHtml(formatError(error))}</code>`).catch(() => null);
    } finally {
      await safeDeleteMessage(chatId, message.message_id);
    }
    return;
  }

  await sendText(
    chatId,
    "可以点“域名列表”，进入域名后再用 1-5 按钮选择记录。可用命令：/start、/domains",
    {
      replyMarkup: mainMenu(),
      replyToMessageId: message.message_id,
    },
  );
  if (isCommandMessage) {
    await safeDeleteMessage(chatId, message.message_id);
  }
}

async function handleCallback(query) {
  const userId = String(query.from?.id ?? "");
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data || "";

  if (!chatId || !messageId) {
    await answerCallback(query.id, "这个按钮当前不可用");
    return;
  }

  if (!isAllowedUser(userId)) {
    await answerCallback(query.id, "未授权");
    return;
  }

  const session = getSession(userId);
  if (!isPrivateChat(query.message?.chat)) {
    await answerCallback(query.id, "请在私聊中使用");
    return;
  }

  let callbackAnswered = false;

  async function acknowledge(text = "") {
    try {
      await answerCallback(query.id, text);
      callbackAnswered = true;
    } catch (error) {
      log(`callback ack warning: data=${data} detail=${formatError(error)}`);
    }
  }

  try {
    if (data === "menu") {
      clearPendingState(session);
      session.pageSelection = createPageSelectionState();
      await acknowledge();
      await editText(chatId, messageId, buildWelcomeText(), mainMenu());
      return;
    }

    if (data.startsWith("domains:")) {
      const page = Number(data.split(":")[1] || "1");
      await acknowledge();
      await editDomainList(chatId, messageId, userId, page);
      return;
    }

    if (data === "pcancel") {
      clearPendingState(session);
      session.pageSelection = createPageSelectionState();
      await acknowledge("已取消");
      await safeDeleteMessage(chatId, messageId);
      return;
    }

    if (data === "zoneadd") {
      session.pending = {
        type: "add-zone-token",
      };
      await acknowledge("请发送 Cloudflare API Token");
      const promptMessage = await sendText(chatId, buildAddZoneTokenPrompt(), {
        replyMarkup: pendingCancelMenu(),
      });
      rememberPendingPrompt(session, promptMessage);
      return;
    }

    if (data.startsWith("zone:")) {
      const zoneId = data.slice(5);
      const zone = getManagedZone(zoneId);

      session.currentZoneId = zone.zoneId;
      session.currentZoneName = zone.name;
      session.recordFilter = "";
      session.recordPage = 1;
      session.recordPageCount = 1;
      session.pageSelection = createPageSelectionState();

      await acknowledge("已打开域名记录");
      await editRecords(chatId, messageId, userId, 1);
      return;
    }

    if (data.startsWith("rtype:")) {
      const recordType = data.slice(6);
      ensureSupportedType(recordType);
      session.recordFilter = recordType;
      session.recordPage = 1;
      await acknowledge(`已筛选 ${recordType}`);
      await editRecords(chatId, messageId, userId, 1);
      return;
    }

    if (data === "rclr") {
      session.recordFilter = "";
      session.recordPage = 1;
      await acknowledge("已清除筛选");
      await editRecords(chatId, messageId, userId, 1);
      return;
    }

    if (data.startsWith("rpage:")) {
      const page = Number(data.split(":")[1] || "1");
      await acknowledge();
      await editRecords(chatId, messageId, userId, page);
      return;
    }

    if (data.startsWith("pick:")) {
      const displayNumber = Number(data.slice(5));
      const item = session.pageSelection.items.find((entry) => entry.displayNumber === displayNumber);

      if (!item) {
        await acknowledge("这个序号当前没有记录");
        return;
      }

      session.lastView = {
        kind: "records",
        page: session.recordPage || 1,
      };
      await acknowledge();
      await editRecordDetails(chatId, messageId, userId, item.recordId, {
        zoneId: item.zoneId,
        record: item.record,
      });
      return;
    }

    if (data === "zdel") {
      const zone = requireSelectedZone(session);
      await acknowledge("请确认删除域名");
      await editText(
        chatId,
        messageId,
        buildDeleteManagedZoneText(zone),
        deleteManagedZoneMenu(zone.zoneId, session.domainPage || 1),
      );
      return;
    }

    if (data.startsWith("zdelok:")) {
      const zoneId = data.slice(7);
      const removed = managedZonesStore.remove(zoneId);
      if (!removed) {
        throw new Error("这个域名已经不在机器人管理列表里了");
      }

      invalidateZoneRecordCache(zoneId);
      clearZoneFromSessions(zoneId);

      await acknowledge("已移除域名");
      await editDomainList(chatId, messageId, userId, session.domainPage || 1);
      return;
    }

    if (data.startsWith("rec:")) {
      const recordId = data.slice(4);
      session.lastView = {
        kind: "records",
        page: session.recordPage || 1,
      };
      await acknowledge();
      await editRecordDetails(chatId, messageId, userId, recordId, {
        zoneId: session.currentZoneId,
      });
      return;
    }

    if (data.startsWith("val:")) {
      const recordId = data.slice(4);
      const zoneId = requireZone(session);
      await acknowledge("请发送新的地址");
      const record = await getRecord(zoneId, recordId);

      session.pending = {
        type: "edit-content",
        zoneId,
        recordId,
        recordType: record.type,
      };

      const promptMessage = await sendText(
        chatId,
        [
          "<b>修改地址</b>",
          "",
          buildPanelBlock([
            `准备修改这条 ${record.type} 记录的地址`,
            "",
            formatDetailLine("名称", record.name),
            formatDetailLine("地址", record.content),
            "",
            stripHtml(buildValuePrompt(record.type)),
          ]),
        ].join("\n"),
        {
          replyMarkup: pendingCancelMenu(),
        },
      );
      rememberPendingPrompt(session, promptMessage);
      return;
    }

    if (data.startsWith("name:")) {
      const recordId = data.slice(5);
      const zoneId = requireZone(session);
      await acknowledge("请发送新的名称");
      const record = await getRecord(zoneId, recordId);

      session.pending = {
        type: "edit-name",
        zoneId,
        recordId,
      };

      const promptMessage = await sendText(
        chatId,
        [
          "<b>修改名称</b>",
          "",
          buildPanelBlock([
            "请直接发送新的名称",
            "",
            formatDetailLine("名称", record.name),
            "",
            "可发送完整域名，或发送 @ / 子域前缀",
          ]),
        ].join("\n"),
        {
          replyMarkup: pendingCancelMenu(),
        },
      );
      rememberPendingPrompt(session, promptMessage);
      return;
    }

    if (data.startsWith("cmt:")) {
      const recordId = data.slice(4);
      const zoneId = requireZone(session);
      await acknowledge("请发送新的备注");
      const record = await getRecord(zoneId, recordId);

      session.pending = {
        type: "edit-comment",
        zoneId,
        recordId,
      };

      const promptMessage = await sendText(
        chatId,
        [
          "<b>修改备注</b>",
          "",
          buildPanelBlock([
            "请直接发送新的备注",
            "",
            formatDetailLine("名称", record.name),
            formatDetailLine("备注", record.comment || "(空)"),
            "",
            "发送 /skip 可清空备注",
          ]),
        ].join("\n"),
        {
          replyMarkup: pendingCancelMenu(),
        },
      );
      rememberPendingPrompt(session, promptMessage);
      return;
    }

    if (data.startsWith("pxy:")) {
      const recordId = data.slice(4);
      const zoneId = requireZone(session);
      await acknowledge();
      const record = await getRecord(zoneId, recordId);
      await updateRecord(zoneId, record, {
        proxied: !record.proxied,
      });

      await editRecordDetails(chatId, messageId, userId, recordId, { zoneId });
      return;
    }

    if (data.startsWith("del:")) {
      const recordId = data.slice(4);
      const zoneId = requireZone(session);
      await acknowledge("请确认删除");
      const record = await getRecord(zoneId, recordId);
      const zone = getManagedZone(zoneId);

      await editText(
        chatId,
        messageId,
        buildDeleteConfirmText(record, { zoneName: zone.name }),
        deleteConfirmMenu(recordId, session.lastView),
      );
      return;
    }

    if (data.startsWith("delok:")) {
      const recordId = data.slice(6);
      const zoneId = requireZone(session);
      await acknowledge();
      await deleteRecord(zoneId, recordId);

      await refreshLastView(chatId, messageId, userId);
      return;
    }

    await acknowledge("未知操作");
  } catch (error) {
    log(`callback error: data=${data} detail=${formatError(error)}`);
    if (!callbackAnswered) {
      try {
        await answerCallback(query.id, "操作失败");
      } catch {
        // Ignore callback response failures in error handling.
      }
    }
    await sendText(chatId, `执行失败：<code>${escapeHtml(formatError(error))}</code>`);
  }
}

async function handlePendingText({ session, userId, chatId, text, replyToMessageId }) {
  const pending = session.pending;

  if (!pending) {
    return;
  }

  if (pending.type === "add-zone-token") {
    const result = await registerManagedZone(text);
    const pendingPromptMessageId = session.pendingPromptMessageId;

    clearPendingState(session);
    session.currentZoneId = result.zone.zoneId;
    session.currentZoneName = result.zone.name;
    session.recordFilter = "";
    session.recordPage = 1;
    session.recordPageCount = 1;
    session.pageSelection = createPageSelectionState();

    await sendText(
      chatId,
      result.existed
        ? `已更新域名 <code>${escapeHtml(result.zone.name)}</code> 的 token，下面直接打开这个域名的 DNS 记录。`
        : `已接入域名 <code>${escapeHtml(result.zone.name)}</code>，下面直接打开这个域名的 DNS 记录。`,
      { replyToMessageId },
    );
    await safeDeleteMessage(chatId, pendingPromptMessageId);
    await sendRecords(chatId, userId, 1, replyToMessageId);
    return;
  }

  if (pending.type === "edit-content") {
    const normalizedContent = normalizeRecordContent(pending.recordType, text);
    if (!normalizedContent) {
      await sendText(chatId, buildInvalidValueText(pending.recordType), {
        replyToMessageId,
      });
      return;
    }

    const record = await getRecord(pending.zoneId, pending.recordId);
    const updated = await updateRecord(pending.zoneId, record, {
      content: normalizedContent,
    });
    const zone = getManagedZone(pending.zoneId);
    const pendingPromptMessageId = session.pendingPromptMessageId;

    clearPendingState(session);

    await sendText(
      chatId,
      buildRecordDetailsText(updated, {
        title: "记录已更新",
        zoneName: zone.name,
      }),
      {
        replyMarkup: detailMenu(updated.id, session.lastView),
        replyToMessageId,
      },
    );
    await safeDeleteMessage(chatId, pendingPromptMessageId);
    return;
  }

  if (pending.type === "edit-name") {
    const zone = getManagedZone(pending.zoneId);
    const normalizedName = normalizeRecordName(zone.name, text);
    if (!normalizedName) {
      await sendText(
        chatId,
        "名称无效，请发送完整域名，或发送 @ / 子域前缀，例如：<code>www</code>、<code>@</code>、<code>api.example.com</code>",
        {
          replyToMessageId,
        },
      );
      return;
    }

    const record = await getRecord(pending.zoneId, pending.recordId);
    const updated = await updateRecord(pending.zoneId, record, {
      name: normalizedName,
    });
    const zoneName = zone.name;
    const pendingPromptMessageId = session.pendingPromptMessageId;

    clearPendingState(session);

    await sendText(
      chatId,
      buildRecordDetailsText(updated, {
        title: "名称已更新",
        zoneName,
      }),
      {
        replyMarkup: detailMenu(updated.id, session.lastView),
        replyToMessageId,
      },
    );
    await safeDeleteMessage(chatId, pendingPromptMessageId);
    return;
  }

  if (pending.type === "edit-comment") {
    const record = await getRecord(pending.zoneId, pending.recordId);
    const updated = await updateRecord(pending.zoneId, record, {
      comment: text === "/skip" ? "" : text,
    });
    const zone = getManagedZone(pending.zoneId);
    const pendingPromptMessageId = session.pendingPromptMessageId;

    clearPendingState(session);

    await sendText(
      chatId,
      buildRecordDetailsText(updated, {
        title: "备注已更新",
        zoneName: zone.name,
      }),
      {
        replyMarkup: detailMenu(updated.id, session.lastView),
        replyToMessageId,
      },
    );
    await safeDeleteMessage(chatId, pendingPromptMessageId);
  }
}

function getSession(userId) {
  let session = sessions.get(userId);

  if (!session) {
    session = createSession();
    sessions.set(userId, session);
  }

  return session;
}

function createSession() {
  return {
    currentZoneId: "",
    currentZoneName: "",
    recordFilter: "",
    domainPage: 1,
    recordPage: 1,
    recordPageCount: 1,
    pending: null,
    pendingPromptMessageId: 0,
    pageSelection: createPageSelectionState(),
    lastView: {
      kind: "records",
      page: 1,
    },
  };
}

function createPageSelectionState() {
  return {
    items: [],
  };
}

function clearPendingState(session) {
  session.pending = null;
  session.pendingPromptMessageId = 0;
}

function rememberPendingPrompt(session, message) {
  session.pendingPromptMessageId = message?.message_id || 0;
}

function isAllowedUser(userId) {
  return Boolean(config.tgAllowedUserId) && config.tgAllowedUserId === userId;
}

function isPrivateChat(chat) {
  return String(chat?.type || "") === "private";
}

function requireZone(session) {
  if (!session.currentZoneId) {
    throw new Error("请先从域名列表里选择一个域名");
  }

  return session.currentZoneId;
}

function requireSelectedZone(session) {
  return getManagedZone(requireZone(session));
}

function clearZoneFromSessions(zoneId) {
  for (const session of sessions.values()) {
    if (session.currentZoneId === zoneId) {
      session.currentZoneId = "";
      session.currentZoneName = "";
      session.recordFilter = "";
      session.recordPage = 1;
      session.recordPageCount = 1;
      clearPendingState(session);
      session.pageSelection = createPageSelectionState();
    }

    if (session.pending?.zoneId === zoneId) {
      clearPendingState(session);
    }
  }
}

async function refreshLastView(chatId, messageId, userId) {
  const session = getSession(userId);

  if (!session.currentZoneId) {
    await editDomainList(chatId, messageId, userId, session.domainPage || 1);
    return;
  }

  await editRecords(chatId, messageId, userId, session.lastView.page || 1);
}

async function sendDomainList(chatId, userId, page, replyToMessageId) {
  const payload = await buildDomainListPayload(userId, page);
  await sendText(chatId, payload.text, {
    replyMarkup: payload.replyMarkup,
    replyToMessageId,
  });
}

async function editDomainList(chatId, messageId, userId, page) {
  const payload = await buildDomainListPayload(userId, page);
  await editText(chatId, messageId, payload.text, payload.replyMarkup);
}

async function buildDomainListPayload(userId, page) {
  const session = getSession(userId);
  session.pageSelection = createPageSelectionState();

  const zones = await listZones();
  const pageCount = Math.max(1, Math.ceil(zones.length / ZONES_PER_PAGE));
  const safePage = clampPage(page, pageCount);
  const start = (safePage - 1) * ZONES_PER_PAGE;
  const items = zones.slice(start, start + ZONES_PER_PAGE);

  session.domainPage = safePage;

  const lines = [
    "<b>域名列表</b>",
    "",
    buildPanelBlock([
      "请选择需要修改DNS的域名。",
      "",
      formatSummaryLine("域名", `${zones.length} 个`),
      formatSummaryLine("页码", `${safePage}/${pageCount}`),
    ]),
  ];

  if (zones.length === 0) {
    lines.push("", "当前还没有已接入的域名，请先点“新增域名”。");
  }

  return {
    text: lines.join("\n"),
    replyMarkup: domainListMenu(items, safePage, pageCount),
  };
}

async function sendRecords(chatId, userId, page, replyToMessageId) {
  const payload = await buildRecordsPayload(userId, page);
  await sendText(chatId, payload.text, {
    replyMarkup: payload.replyMarkup,
    replyToMessageId,
  });
}

async function editRecords(chatId, messageId, userId, page) {
  const payload = await buildRecordsPayload(userId, page);
  await editText(chatId, messageId, payload.text, payload.replyMarkup);
}

async function buildRecordsPayload(userId, page) {
  const session = getSession(userId);
  const zoneId = requireZone(session);
  const zone = getManagedZone(zoneId);
  const records = await listRecords(zoneId, session.recordFilter);
  const pageCount = Math.max(1, Math.ceil(records.length / config.recordsPerPage));
  const safePage = clampPage(page, pageCount);
  const start = (safePage - 1) * config.recordsPerPage;
  const items = records.slice(start, start + config.recordsPerPage);

  session.currentZoneId = zoneId;
  session.currentZoneName = zone.name;
  session.recordPage = safePage;
  session.recordPageCount = pageCount;
  session.lastView = {
    kind: "records",
    page: safePage,
  };
  session.pageSelection = {
    items: items.map((record, index) => ({
      displayNumber: index + 1,
      zoneId,
      recordId: record.id,
      record,
    })),
  };

  const lines = [
    `<b>${escapeHtml(zone.name)}</b>`,
    "",
    buildPanelBlock([
      formatSummaryLine("筛选", session.recordFilter || "全部"),
      formatSummaryLine("条数", `${records.length} 条`),
      formatSummaryLine("页码", `${safePage}/${pageCount}`),
      "点击下面的 1-5 打开详情",
    ]),
    "",
  ];

  if (items.length === 0) {
    lines.push(buildPanelBlock(["当前没有匹配记录。"]));
  } else {
    items.forEach((record, index) => {
      lines.push(buildRecordListEntry(record, index));
    });
  }

  return {
    text: lines.join("\n"),
    replyMarkup: recordsMenu(session),
  };
}

async function editRecordDetails(chatId, messageId, userId, recordId, options = {}) {
  const session = getSession(userId);
  const zoneId = options.zoneId || requireZone(session);
  const zone = await getZone(zoneId);
  const record =
    options.record ||
    session.pageSelection.items.find((entry) => entry.recordId === recordId)?.record ||
    (await getRecord(zoneId, recordId));

  session.currentZoneId = zone.zoneId;
  session.currentZoneName = zone.name;

  await editText(
    chatId,
    messageId,
    buildRecordDetailsText(record, { zoneName: zone.name }),
    detailMenu(record.id, session.lastView),
  );
}

async function sendRecordDetails(chatId, userId, recordId, options = {}) {
  const session = getSession(userId);
  const zoneId = options.zoneId || requireZone(session);
  const zone = await getZone(zoneId);
  const record =
    options.record ||
    session.pageSelection.items.find((entry) => entry.recordId === recordId)?.record ||
    (await getRecord(zoneId, recordId));

  session.currentZoneId = zone.zoneId;
  session.currentZoneName = zone.name;

  await sendText(
    chatId,
    buildRecordDetailsText(record, { zoneName: zone.name }),
    {
      replyMarkup: detailMenu(record.id, session.lastView),
      replyToMessageId: options.replyToMessageId,
    },
  );
}

function mainMenu() {
  return {
    inline_keyboard: [[{ text: "域名列表", callback_data: "domains:1" }]],
  };
}

function domainListMenu(zones, page, pageCount) {
  const rows = zones.map((zone) => [{ text: zone.name, callback_data: `zone:${zone.zoneId}` }]);

  if (pageCount > 1) {
    rows.push([{ text: "下一页", callback_data: `domains:${nextPage(page, pageCount)}` }]);
  }

  rows.push([
    { text: "新增域名", callback_data: "zoneadd" },
    { text: "返回主菜单", callback_data: "menu" },
  ]);
  return { inline_keyboard: rows };
}

function recordsMenu(session) {
  const next = nextRecordPage(session.recordPage, session.recordPageCount);
  const selectButtons = Array.from({ length: 5 }, (_, index) => ({
    text: String(index + 1),
    callback_data: `pick:${index + 1}`,
  }));

  return {
    inline_keyboard: [
      selectButtons,
      [
        { text: session.recordFilter === "A" ? "[A]" : "A", callback_data: "rtype:A" },
        { text: session.recordFilter === "AAAA" ? "[AAAA]" : "AAAA", callback_data: "rtype:AAAA" },
        { text: session.recordFilter === "CNAME" ? "[CNAME]" : "CNAME", callback_data: "rtype:CNAME" },
      ],
      ...(session.recordPageCount > 1
        ? [[{ text: session.recordPage >= session.recordPageCount ? "上一页" : "下一页", callback_data: `rpage:${next}` }]]
        : []),
      [
        { text: "清除筛选", callback_data: "rclr" },
        { text: "删除此域", callback_data: "zdel" },
      ],
      [
        { text: "返回上一级", callback_data: `domains:${session.domainPage || 1}` },
        { text: "返回主菜单", callback_data: "menu" },
      ],
    ],
  };
}

function detailMenu(recordId, context) {
  return {
    inline_keyboard: [
      [
        { text: "改地址", callback_data: `val:${recordId}` },
        { text: "改名称", callback_data: `name:${recordId}` },
        { text: "改备注", callback_data: `cmt:${recordId}` },
      ],
      [
        { text: "切换代理", callback_data: `pxy:${recordId}` },
        { text: "删除记录", callback_data: `del:${recordId}` },
      ],
      [
        { text: "返回上一级", callback_data: buildBackCallback(context) },
        { text: "返回主菜单", callback_data: "menu" },
      ],
    ],
  };
}

function deleteConfirmMenu(recordId, context) {
  return {
    inline_keyboard: [
      [
        { text: "确认删除记录", callback_data: `delok:${recordId}` },
        { text: "返回详情", callback_data: `rec:${recordId}` },
      ],
      [
        { text: "返回上一级", callback_data: buildBackCallback(context) },
        { text: "返回主菜单", callback_data: "menu" },
      ],
    ],
  };
}

function deleteManagedZoneMenu(zoneId, domainPage) {
  return {
    inline_keyboard: [
      [{ text: "确认删除此域", callback_data: `zdelok:${zoneId}` }],
      [{ text: "返回记录列表", callback_data: `zone:${zoneId}` }],
      [
        { text: "返回上一级", callback_data: `domains:${domainPage || 1}` },
        { text: "返回主菜单", callback_data: "menu" },
      ],
    ],
  };
}

function pendingCancelMenu() {
  return {
    inline_keyboard: [[{ text: "取消", callback_data: "pcancel" }]],
  };
}

function nextPage(currentPage, pageCount) {
  if (pageCount <= 1) {
    return 1;
  }

  return currentPage >= pageCount ? 1 : currentPage + 1;
}

function nextRecordPage(currentPage, pageCount) {
  if (pageCount <= 1) {
    return 1;
  }

  if (currentPage >= pageCount) {
    return Math.max(1, pageCount - 1);
  }

  return currentPage + 1;
}

function buildBackCallback(context) {
  return `rpage:${context?.page || 1}`;
}

async function listZones() {
  return managedZonesStore.list();
}

async function getZone(zoneId) {
  return getManagedZone(zoneId);
}

function getManagedZone(zoneId) {
  const zone = managedZonesStore.get(zoneId);
  if (!zone) {
    throw new Error("这个域名已经不在机器人管理列表里了，请重新从域名列表进入");
  }

  return zone;
}

function buildRecordCacheKey(zoneId, recordType) {
  return `${zoneId}:${recordType}`;
}

function cloneRecord(record) {
  return record ? { ...record } : record;
}

function cloneRecords(records) {
  return (records || []).map((record) => cloneRecord(record));
}

function getCachedRecordList(zoneId, recordType) {
  const cacheKey = buildRecordCacheKey(zoneId, recordType);
  const entry = recordListCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.cachedAt > config.recordsCacheTtlMs) {
    recordListCache.delete(cacheKey);
    return null;
  }

  return cloneRecords(entry.records);
}

function setCachedRecordList(zoneId, recordType, records) {
  recordListCache.set(buildRecordCacheKey(zoneId, recordType), {
    cachedAt: Date.now(),
    records: cloneRecords(records).sort(compareRecords),
  });
}

function invalidateZoneRecordCache(zoneId) {
  for (const recordType of SUPPORTED_RECORD_TYPES) {
    const cacheKey = buildRecordCacheKey(zoneId, recordType);
    recordListCache.delete(cacheKey);
    recordListInflight.delete(cacheKey);
  }
}

function upsertCachedRecord(zoneId, record) {
  if (!record?.id || !record?.type) {
    return;
  }

  const cacheKey = buildRecordCacheKey(zoneId, record.type);
  const entry = recordListCache.get(cacheKey);
  if (!entry) {
    return;
  }

  const records = cloneRecords(entry.records);
  const index = records.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    records[index] = cloneRecord(record);
  } else {
    records.push(cloneRecord(record));
  }

  setCachedRecordList(zoneId, record.type, records);
}

function removeCachedRecord(zoneId, recordId) {
  for (const recordType of SUPPORTED_RECORD_TYPES) {
    const cacheKey = buildRecordCacheKey(zoneId, recordType);
    const entry = recordListCache.get(cacheKey);
    if (!entry) {
      continue;
    }

    const records = entry.records.filter((record) => record.id !== recordId);
    setCachedRecordList(zoneId, recordType, records);
  }
}

function findCachedRecord(zoneId, recordId) {
  for (const recordType of SUPPORTED_RECORD_TYPES) {
    const records = getCachedRecordList(zoneId, recordType);
    if (!records) {
      continue;
    }

    const record = records.find((item) => item.id === recordId);
    if (record) {
      return cloneRecord(record);
    }
  }

  return null;
}

async function registerManagedZone(token) {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    throw new Error("收到的 token 为空，请重新发送");
  }

  const zones = await listAllPagesWithToken(
    trimmedToken,
    (page) => `/zones?per_page=${CF_ZONES_API_PAGE_SIZE}&page=${page}`,
  );

  if (zones.length !== 1) {
    throw new Error("这枚 token 必须只授权 1 个域名，请在 Cloudflare 里创建只包含 1 个 Zone 的 API Token");
  }

  const zone = zones[0];
  await cfWithToken(trimmedToken, `/zones/${zone.id}/dns_records?per_page=1&page=1`);

  const result = managedZonesStore.upsert({
    zoneId: zone.id,
    name: zone.name,
    token: trimmedToken,
  });
  invalidateZoneRecordCache(zone.id);

  return result;
}

async function listRecords(zoneId, filterType) {
  if (filterType) {
    return listRecordsByType(zoneId, filterType);
  }

  const groups = await Promise.all(
    SUPPORTED_RECORD_TYPES.map((type) => listRecordsByType(zoneId, type)),
  );

  return groups.flat().sort(compareRecords);
}

async function listRecordsByType(zoneId, recordType) {
  ensureSupportedType(recordType);

  const cached = getCachedRecordList(zoneId, recordType);
  if (cached) {
    return cached;
  }

  const cacheKey = buildRecordCacheKey(zoneId, recordType);
  const inflight = recordListInflight.get(cacheKey);
  if (inflight) {
    return cloneRecords(await inflight);
  }

  const token = getManagedZone(zoneId).token;
  const request = (async () => {
    const records = await listAllPagesWithToken(
      token,
      (page) =>
        `/zones/${zoneId}/dns_records?type=${encodeURIComponent(recordType)}&per_page=${CF_RECORDS_API_PAGE_SIZE}&page=${page}`,
    );

    const sorted = records.sort(compareRecords);
    setCachedRecordList(zoneId, recordType, sorted);
    return sorted;
  })();

  recordListInflight.set(cacheKey, request);

  try {
    return cloneRecords(await request);
  } finally {
    recordListInflight.delete(cacheKey);
  }
}

function compareRecords(left, right) {
  if (left.type !== right.type) {
    return left.type.localeCompare(right.type);
  }

  if (left.name !== right.name) {
    return left.name.localeCompare(right.name);
  }

  return left.content.localeCompare(right.content);
}

async function listAllPagesWithToken(token, makePath) {
  const items = [];
  let page = 1;
  let totalPages = 1;

  do {
    const response = await cfWithToken(token, makePath(page));
    items.push(...(response.result || []));
    totalPages = Number(response.result_info?.total_pages || 1);
    page += 1;
  } while (page <= totalPages);

  return items;
}

async function getRecord(zoneId, recordId) {
  const cached = findCachedRecord(zoneId, recordId);
  if (cached) {
    return cached;
  }

  const response = await cfForZone(zoneId, `/zones/${zoneId}/dns_records/${recordId}`);
  const record = response.result;
  upsertCachedRecord(zoneId, record);
  return record;
}

async function updateRecord(zoneId, record, patch) {
  const body = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl,
    proxied: record.proxied,
    comment: record.comment ?? "",
    ...patch,
  };

  const response = await cfForZone(zoneId, `/zones/${zoneId}/dns_records/${record.id}`, {
    method: "PATCH",
    body,
  });
  const updated = response.result;
  upsertCachedRecord(zoneId, updated);
  return updated;
}

async function deleteRecord(zoneId, recordId) {
  await cfForZone(zoneId, `/zones/${zoneId}/dns_records/${recordId}`, {
    method: "DELETE",
  });
  removeCachedRecord(zoneId, recordId);
}

async function cfForZone(zoneId, pathname, options = {}) {
  const zone = getManagedZone(zoneId);
  return cfWithToken(zone.token, pathname, options);
}

async function cfWithToken(token, pathname, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  return apiRequest(`https://api.cloudflare.com/client/v4${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }, {
    retryCount: method === "GET" ? 2 : 0,
    retryDelayMs: 500,
  });
}

async function tg(method, payload) {
  const result = await apiRequest(`https://api.telegram.org/bot${config.tgToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return result.result;
}

async function sendText(chatId, text, options = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: options.replyMarkup,
    reply_to_message_id: options.replyToMessageId,
    disable_web_page_preview: true,
  });
}

async function editText(chatId, messageId, text, replyMarkup) {
  try {
    return await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    });
  } catch (error) {
    if (formatError(error).includes("message is not modified")) {
      return null;
    }
    throw error;
  }
}

async function answerCallback(callbackQueryId, text = "") {
  return tg("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || undefined,
    show_alert: false,
  });
}

async function deleteMessage(chatId, messageId) {
  return tg("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

async function safeDeleteMessage(chatId, messageId) {
  if (!chatId || !messageId) {
    return;
  }

  try {
    await deleteMessage(chatId, messageId);
  } catch {
    // Ignore cleanup failures; they should not block the main action.
  }
}

async function apiRequest(url, init, options = {}) {
  const retryCount = Number(options.retryCount || 0);
  const retryDelayMs = Number(options.retryDelayMs || 500);

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    let response;

    try {
      response = await fetch(url, init);
    } catch (error) {
      if (attempt < retryCount && isRetryableNetworkError(error)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw error;
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const detail =
        data?.description ||
        data?.error ||
        data?.errors?.[0]?.message ||
        data?.messages?.[0]?.message ||
        `${response.status} ${response.statusText}`;

      if (attempt < retryCount && response.status >= 500) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      throw new Error(detail);
    }

    if (data && data.ok === false) {
      throw new Error(data.description || "Telegram API request failed");
    }

    if (data && data.success === false) {
      const message =
        data.errors?.[0]?.message ||
        data.messages?.[0]?.message ||
        "Cloudflare API request failed";
      throw new Error(message);
    }

    return data;
  }

  throw new Error("Request failed after retries");
}

function createManagedZonesStore(filePath, encryptionSecret) {
  let zones = loadManagedZones(filePath, encryptionSecret);

  return {
    count() {
      return zones.length;
    },
    list() {
      return zones
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    get(zoneId) {
      return zones.find((zone) => zone.zoneId === zoneId) || null;
    },
    upsert(zone) {
      const normalized = normalizeManagedZone(zone);
      if (!normalized) {
        throw new Error("invalid managed zone payload");
      }

      const existingIndex = zones.findIndex((entry) => entry.zoneId === normalized.zoneId);
      const existed = existingIndex >= 0;

      if (existed) {
        zones[existingIndex] = normalized;
      } else {
        zones.push(normalized);
      }

      saveManagedZones(filePath, zones, encryptionSecret);
      return { zone: normalized, existed };
    },
    remove(zoneId) {
      const existingIndex = zones.findIndex((entry) => entry.zoneId === zoneId);
      if (existingIndex === -1) {
        return null;
      }

      const [removed] = zones.splice(existingIndex, 1);
      saveManagedZones(filePath, zones, encryptionSecret);
      return removed;
    },
  };
}

function loadManagedZones(filePath, encryptionSecret) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const parsed = readEncryptedJsonFile(filePath, encryptionSecret, "managed-zones", createEmptyZonesPayload());
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.zones) ? parsed.zones : [];

  return entries
    .map((entry) => normalizeManagedZone(entry))
    .filter(Boolean);
}

function saveManagedZones(filePath, zones, encryptionSecret) {
  const payload = {
    zones: zones
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((zone) => ({
        zoneId: zone.zoneId,
        name: zone.name,
        token: zone.token,
      })),
  };

  writeEncryptedJsonFile(filePath, payload, encryptionSecret, "managed-zones");
}

function normalizeManagedZone(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const zoneId = String(entry.zoneId || entry.id || "").trim();
  const name = normalizeDnsName(String(entry.name || "").trim());
  const token = String(entry.token || "").trim();

  if (!zoneId || !name || !token) {
    return null;
  }

  return {
    zoneId,
    name,
    token,
  };
}

function loadMasterSecretIfNeeded() {
  const needsEncryptedSecrets =
    fs.existsSync(appSecretsFilePath) ||
    fs.existsSync(managedZonesFilePath) ||
    Boolean(String(process.env.TG_BOT_TOKEN || "").trim()) ||
    Boolean(String(process.env.TG_ALLOWED_USER_ID || "").trim()) ||
    fs.existsSync(legacyManagedZonesFilePath);

  if (!needsEncryptedSecrets) {
    return "";
  }

  return readMasterSecret({ keyFilePath, cwd });
}

function migrateLegacySensitiveFiles() {
  if (!masterSecret) {
    return;
  }

  const tgToken = String(process.env.TG_BOT_TOKEN || "").trim();
  const tgAllowedUserId = String(process.env.TG_ALLOWED_USER_ID || "").trim();

  if (!fs.existsSync(appSecretsFilePath) && (tgToken || tgAllowedUserId)) {
    writeEncryptedJsonFile(
      appSecretsFilePath,
      {
        tgToken,
        tgAllowedUserId,
      },
      masterSecret,
      "app-secrets",
    );
    log("migrated plaintext Telegram secrets to encrypted storage");
  }

  if (tgToken || tgAllowedUserId) {
    sanitizeEnvFile(envFilePath, ["TG_BOT_TOKEN", "TG_ALLOWED_USER_ID"]);
    delete process.env.TG_BOT_TOKEN;
    delete process.env.TG_ALLOWED_USER_ID;
  }

  if (!fs.existsSync(managedZonesFilePath) && fs.existsSync(legacyManagedZonesFilePath)) {
    const payload = parseJsonFile(legacyManagedZonesFilePath, createEmptyZonesPayload()) || createEmptyZonesPayload();
    writeEncryptedJsonFile(managedZonesFilePath, payload, masterSecret, "managed-zones");
    fs.rmSync(legacyManagedZonesFilePath, { force: true });
    log("migrated plaintext Cloudflare tokens to encrypted storage");
  }
}

function hydrateSensitiveEnv() {
  if (!masterSecret || !fs.existsSync(appSecretsFilePath)) {
    return;
  }

  const payload = readEncryptedJsonFile(appSecretsFilePath, masterSecret, "app-secrets", {});
  if (payload?.tgToken) {
    process.env.TG_BOT_TOKEN = String(payload.tgToken).trim();
  }

  process.env.TG_ALLOWED_USER_ID = String(payload?.tgAllowedUserId || "").trim();
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim().replace(/^"(.*)"$/, "$1");

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required env: ${name}`);
  }
  return value;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value || "", 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function clampPage(page, pageCount) {
  if (!Number.isFinite(page) || page < 1) {
    return 1;
  }

  if (page > pageCount) {
    return pageCount;
  }

  return page;
}

function ensureSupportedType(recordType) {
  if (!SUPPORTED_RECORD_TYPES.includes(recordType)) {
    throw new Error(`unsupported record type: ${recordType}`);
  }
}

function normalizeDnsName(value) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeRecordName(zoneName, value) {
  const normalizedZone = normalizeDnsName(zoneName);
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed === "@") {
    return normalizedZone;
  }

  let candidate = normalizeDnsName(trimmed);
  if (!candidate) {
    return "";
  }

  if (!candidate.includes(".")) {
    candidate = `${candidate}.${normalizedZone}`;
  }

  if (candidate !== normalizedZone && !candidate.endsWith(`.${normalizedZone}`)) {
    return "";
  }

  return isValidDnsName(candidate, true) ? candidate : "";
}

function normalizeRecordContent(recordType, value) {
  const trimmed = value.trim();

  if (recordType === "A") {
    return isIP(trimmed) === 4 ? trimmed : "";
  }

  if (recordType === "AAAA") {
    return isIP(trimmed) === 6 ? trimmed : "";
  }

  if (recordType === "CNAME") {
    const hostname = normalizeDnsName(trimmed);
    return isValidCnameTarget(hostname) ? hostname : "";
  }

  return "";
}

function isValidCnameTarget(value) {
  return isValidDnsName(normalizeDnsName(value), false);
}

function isValidDnsName(value, allowWildcard) {
  if (!value) {
    return false;
  }

  const labels = value.split(".");
  if (labels.length < 2) {
    return false;
  }

  return labels.every((label, index) => {
    if (allowWildcard && index === 0 && label === "*") {
      return true;
    }

    return isValidDnsLabel(label);
  });
}

function isValidDnsLabel(label) {
  if (!label || label.length > 63) {
    return false;
  }

  return /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label);
}

function buildAddZoneTokenPrompt() {
  return [
    "<b>新增域名</b>",
    "",
    buildPanelBlock([
      "请直接发送这一个域名专用的",
      "Cloudflare API Token。",
      "",
      "建议权限：",
      "1. Zone.Zone Read",
      "2. Zone.DNS Write",
    ]),
  ].join("\n");
}

function buildValuePrompt(recordType) {
  if (recordType === "A") {
    return "请发送这条 A 记录要指向的 IPv4 地址，例如：<code>1.2.3.4</code>";
  }

  if (recordType === "AAAA") {
    return "请发送这条 AAAA 记录要指向的 IPv6 地址，例如：<code>2408:4001:abcd::1</code>";
  }

  return "请发送这条 CNAME 记录要指向的目标主机名，例如：<code>target.example.com</code>";
}

function buildInvalidValueText(recordType) {
  if (recordType === "A") {
    return "这不是有效的 IPv4 地址，请重新发送，例如：<code>1.2.3.4</code>";
  }

  if (recordType === "AAAA") {
    return "这不是有效的 IPv6 地址，请重新发送，例如：<code>2408:4001:abcd::1</code>";
  }

  return "这不是有效的 CNAME 目标主机名，请重新发送完整域名，例如：<code>target.example.com</code>";
}

function buildWelcomeText() {
  return [
    "<b>Cloudflare DNS 机器人</b>",
    "",
    "点击域名列表开始吧！",
  ].join("\n");
}

function buildRecordDetailsText(record, options = {}) {
  return [
    `<b>${escapeHtml(options.title || "记录详情")}</b>`,
    "",
    buildPanelBlock([
      formatDetailLine("域名", options.zoneName || ""),
      formatDetailLine("ID", record.id),
      formatDetailLine("名称", record.name),
      formatDetailLine("类型", record.type),
      formatDetailLine("地址", record.content),
      formatDetailLine("TTL", String(record.ttl)),
      formatDetailLine("代理", formatProxyState(record)),
      formatDetailLine("备注", record.comment || ""),
    ]),
  ].join("\n");
}

function buildDeleteConfirmText(record, options = {}) {
  return [
    "<b>确认删除这条记录？</b>",
    "",
    buildPanelBlock([
      formatDetailLine("域名", options.zoneName || ""),
      formatDetailLine("名称", record.name),
      formatDetailLine("类型", record.type),
      formatDetailLine("地址", record.content),
      formatDetailLine("备注", record.comment || ""),
    ]),
    "",
    "删除后只会影响这一条 record ID，不会删除同名的其他记录。",
  ].join("\n");
}

function buildDeleteManagedZoneText(zone) {
  return [
    "<b>确认删除这个域名？</b>",
    "",
    buildPanelBlock([formatDetailLine("域名", zone.name)]),
    "",
    "这不会删除 Cloudflare 里的域名本身。",
    "它只会把这个域名和对应 token 从机器人里移除。",
    "删除后，这个域名将无法再通过机器人控制，除非你重新点“新增域名”并再次发送 token。",
  ].join("\n");
}

function formatProxyState(record) {
  return record.proxied ? "黄云" : "灰云";
}

function buildRecordListEntry(record, index) {
  return buildPanelBlock([
    `${index + 1}. ${formatDnsLabel(`【${record.type}】`)}${record.name}`,
    `   ${formatDnsLabel(`【${formatProxyState(record)}】`)}${record.content}`,
  ]);
}

function formatDnsLabel(label) {
  return padDisplayWidth(String(label), DNS_LABEL_WIDTH);
}

function formatSummaryLine(label, value) {
  return `${padDisplayWidth(String(label), DETAIL_LABEL_WIDTH)}: ${value}`;
}

function formatDetailLine(label, value) {
  return `${padDisplayWidth(String(label), DETAIL_LABEL_WIDTH)}: ${value}`;
}

function buildPanelBlock(lines) {
  return `<pre>${lines.map((line) => escapeHtml(padDisplayWidth(String(line), PANEL_WIDTH))).join("\n")}</pre>`;
}

function padDisplayWidth(value, targetWidth) {
  const width = getDisplayWidth(value);
  if (width >= targetWidth) {
    return value;
  }

  return value + " ".repeat(targetWidth - width);
}

function getDisplayWidth(value) {
  let width = 0;
  for (const char of String(value)) {
    width += isWideChar(char) ? 2 : 1;
  }
  return width;
}

function isWideChar(char) {
  const code = char.codePointAt(0) || 0;

  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

function stripHtml(value) {
  return String(value).replace(/<[^>]+>/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function log(message) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${message}`);
}

function formatError(error) {
  if (error instanceof Error) {
    const message = error.message || String(error);
    const cause = error.cause;
    const causeMessage =
      cause instanceof Error ? cause.message : cause ? String(cause) : "";
    return causeMessage ? `${message} (${causeMessage})` : message;
  }

  return String(error);
}

function isRetryableNetworkError(error) {
  const message = formatError(error).toLowerCase();

  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("socket hang up") ||
    message.includes("und_err")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyUpdateError(update, error) {
  const text = `执行失败：<code>${escapeHtml(formatError(error))}</code>`;

  if (update.message?.chat?.id) {
    await sendText(update.message.chat.id, text, {
      replyToMessageId: update.message.message_id,
    }).catch(() => null);
    return;
  }

  if (update.callback_query?.message?.chat?.id) {
    await sendText(update.callback_query.message.chat.id, text).catch(() => null);
  }
}
