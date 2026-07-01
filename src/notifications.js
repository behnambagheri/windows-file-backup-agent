const os = require("os");
const dns = require("dns").promises;
const axios = require("axios");
const nodemailer = require("nodemailer");
const socks = require("socks");
const { SocksProxyAgent } = require("socks-proxy-agent");

function shouldSend(mode, success) {
  if (mode === "off") return false;
  if (mode === "all") return true;
  if (mode === "success") return success;
  if (mode === "failures") return !success;
  return false;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sourceIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        ips.push(entry.address);
      }
    }
  }
  return ips;
}

async function resolveDestinationIp(host) {
  try {
    const result = await dns.lookup(host);
    return result.address;
  } catch {
    return host;
  }
}

async function buildEvent(config, result) {
  const destinationIp = await resolveDestinationIp(config.destination.host);
  return {
    success: result.success,
    eventTime: new Date().toISOString(),
    sourceHost: config.app.hostname || os.hostname(),
    sourceIps: sourceIps(),
    sourceName: result.sourceName || (result.file ? result.file.sourceName : "") || "",
    sourceFileName: result.file ? result.file.name : "",
    sourceFilePath: result.file ? result.file.path : "",
    destinationHost: config.destination.host,
    destinationIp,
    destinationPath: result.remotePath || config.destination.remoteDir,
    compressed: !!result.compressed,
    compressionFormat: result.compressionFormat || "",
    originalSize: result.file ? result.file.size : 0,
    uploadSize: result.uploadSize || (result.file ? result.file.size : 0),
    error: result.error ? String(result.error.stack || result.error.message || result.error) : ""
  };
}

async function buildNotificationTestEvent(config, channel) {
  const destinationHost = config.destination.host || "not configured";
  const destinationIp = config.destination.host
    ? await resolveDestinationIp(config.destination.host)
    : "not configured";
  return {
    success: true,
    test: true,
    testChannel: channel,
    testNote: `This confirms that backup-agent can deliver ${channel} notifications. No backup file was transferred.`,
    eventTime: new Date().toISOString(),
    sourceHost: config.app.hostname || os.hostname(),
    sourceIps: sourceIps(),
    sourceName: "diagnostic",
    sourceFileName: "not applicable",
    sourceFilePath: "not applicable",
    destinationHost,
    destinationIp,
    destinationPath: config.destination.remoteDir || "not configured",
    compressed: false,
    compressionFormat: "",
    originalSize: 0,
    uploadSize: 0,
    error: ""
  };
}

function telegramMessage(event) {
  const status = event.success ? "SUCCESS" : "FAILED";
  const lines = [
    event.test
      ? `<b>backup-agent ${htmlEscape(event.testChannel)} notification test ${status}</b>`
      : `<b>SSH backup transfer ${status}</b>`,
    "",
    ...(event.test ? [`<b>Test:</b> ${htmlEscape(event.testNote)}`, ""] : []),
    ...(event.notificationFallback ? [
      `<b>Notification fallback:</b> ${htmlEscape(event.notificationFallback.from)} -&gt; ${htmlEscape(event.notificationFallback.to)}`,
      `<b>Primary notification error:</b> <code>${htmlEscape(event.notificationFallback.error)}</code>`,
      ""
    ] : []),
    `<b>Source host:</b> ${htmlEscape(event.sourceHost)}`,
    `<b>Source IPs:</b> ${htmlEscape(event.sourceIps.join(", ") || "unknown")}`,
    `<b>Source name:</b> ${htmlEscape(event.sourceName || "default")}`,
    `<b>Source file:</b> ${htmlEscape(event.sourceFileName || "none")}`,
    `<b>Source path:</b> <code>${htmlEscape(event.sourceFilePath || "none")}</code>`,
    `<b>Compression:</b> ${event.compressed ? `enabled (${htmlEscape(event.compressionFormat)})` : "disabled"}`,
    `<b>Original size:</b> ${htmlEscape(event.originalSize)} bytes`,
    `<b>Upload size:</b> ${htmlEscape(event.uploadSize)} bytes`,
    "",
    `<b>Destination IP:</b> ${htmlEscape(event.destinationIp)}`,
    `<b>Destination path:</b> <code>${htmlEscape(event.destinationPath || "none")}</code>`,
    `<b>Event time:</b> ${htmlEscape(event.eventTime)}`
  ];
  if (!event.success) {
    lines.splice(lines.length - 1, 0, `<b>Error:</b> <code>${htmlEscape(event.error || "unknown error")}</code>`);
  }
  return lines.join("\n");
}

function emailText(event) {
  const status = event.success ? "SUCCESS" : "FAILED";
  return [
    event.test
      ? `backup-agent ${event.testChannel} notification test ${status}`
      : `SSH backup transfer ${status}`,
    "",
    ...(event.test ? [`Test: ${event.testNote}`, ""] : []),
    ...(event.notificationFallback ? [
      `Notification fallback: ${event.notificationFallback.from} -> ${event.notificationFallback.to}`,
      `Primary notification error: ${event.notificationFallback.error}`,
      ""
    ] : []),
    `Source host: ${event.sourceHost}`,
    `Source IPs: ${event.sourceIps.join(", ") || "unknown"}`,
    `Source name: ${event.sourceName || "default"}`,
    `Source file: ${event.sourceFileName || "none"}`,
    `Source path: ${event.sourceFilePath || "none"}`,
    `Compression: ${event.compressed ? `enabled (${event.compressionFormat})` : "disabled"}`,
    `Original size: ${event.originalSize} bytes`,
    `Upload size: ${event.uploadSize} bytes`,
    "",
    `Destination host: ${event.destinationHost}`,
    `Destination IP: ${event.destinationIp}`,
    `Destination path: ${event.destinationPath || "none"}`,
    event.success ? "" : `Error: ${event.error || "unknown error"}`,
    `Event time: ${event.eventTime}`
  ].filter((line) => line !== "").join("\n");
}

function emailHtml(event) {
  const status = event.success ? "SUCCESS" : "FAILED";
  const rows = [
    ...(event.test ? [["Test", event.testNote]] : []),
    ...(event.notificationFallback ? [
      ["Notification fallback", `${event.notificationFallback.from} -> ${event.notificationFallback.to}`],
      ["Primary notification error", event.notificationFallback.error]
    ] : []),
    ["Source host", event.sourceHost],
    ["Source IPs", event.sourceIps.join(", ") || "unknown"],
    ["Source name", event.sourceName || "default"],
    ["Source file", event.sourceFileName || "none"],
    ["Source path", event.sourceFilePath || "none"],
    ["Compression", event.compressed ? `enabled (${event.compressionFormat})` : "disabled"],
    ["Original size", `${event.originalSize} bytes`],
    ["Upload size", `${event.uploadSize} bytes`],
    ["Destination host", event.destinationHost],
    ["Destination IP", event.destinationIp],
    ["Destination path", event.destinationPath || "none"],
    ...(event.success ? [] : [["Error", event.error || "unknown error"]]),
    ["Event time", event.eventTime]
  ];
  const rowHtml = rows.map(([label, value]) => (
    `<tr><th style="text-align:left;padding:6px 10px;border-bottom:1px solid #ddd;background:#f7f7f7;">${htmlEscape(label)}</th>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #ddd;font-family:Consolas,monospace;">${htmlEscape(value)}</td></tr>`
  )).join("");
  return [
    `<h2 style="font-family:Arial,sans-serif;">${event.test
      ? `backup-agent ${htmlEscape(event.testChannel)} notification test ${htmlEscape(status)}`
      : `SSH backup transfer ${htmlEscape(status)}`}</h2>`,
    `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Arial,sans-serif;border:1px solid #ddd;">${rowHtml}</table>`
  ].join("");
}

async function sendTelegram(config, event, logger, force = false) {
  if (!force && !shouldSend(config.telegram.mode, event.success)) {
    return;
  }

  const base = config.telegram.apiUrl.replace(/\/+$/, "");
  const url = `${base}/bot${config.telegram.token}/sendMessage`;
  const body = {
    chat_id: config.telegram.chatId,
    text: telegramMessage(event),
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (config.telegram.topicId) {
    body.message_thread_id = config.telegram.topicId;
  }

  const requestConfig = { timeout: 30000 };
  if (config.telegram.useProxy && config.telegram.proxy) {
    const agent = new SocksProxyAgent(config.telegram.proxy);
    requestConfig.httpAgent = agent;
    requestConfig.httpsAgent = agent;
    requestConfig.proxy = false;
  }

  await axios.post(url, body, requestConfig);
  logger.info("Telegram notification sent", { mode: config.telegram.mode, success: event.success });
}

async function sendEmail(config, event, logger, force = false) {
  if (!force && !shouldSend(config.email.mode, event.success)) {
    return;
  }

  const auth = config.email.user
    ? { user: config.email.user, pass: config.email.password }
    : undefined;
  const transportOptions = {
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth
  };
  if (config.email.useProxy && config.email.proxy) {
    transportOptions.proxy = config.email.proxy;
  }
  const transport = nodemailer.createTransport(transportOptions);
  if (config.email.useProxy && config.email.proxy && typeof transport.set === "function") {
    transport.set("proxy_socks_module", socks);
  }
  const status = event.success ? "SUCCESS" : "FAILED";
  await transport.sendMail({
    from: config.email.from,
    to: config.email.to,
    cc: config.email.cc.length ? config.email.cc : undefined,
    bcc: config.email.bcc.length ? config.email.bcc : undefined,
    subject: event.test
      ? `${config.email.subjectPrefix} email notification test ${status}`
      : event.notificationFallback
        ? `${config.email.subjectPrefix} notification fallback: ${event.notificationFallback.from} failed - transfer ${status}`
        : `${config.email.subjectPrefix} transfer ${status}: ${event.sourceFileName || "no file"}`,
    text: emailText(event),
    html: emailHtml(event)
  });
  logger.info("Email notification sent", { mode: config.email.mode, success: event.success });
}

async function notify(config, result, logger) {
  const event = await buildEvent(config, result);
  const errors = [];
  const channels = {
    telegram: {
      label: "Telegram",
      fallback: config.telegram.fallback || "off",
      enabled: shouldSend(config.telegram.mode, event.success),
      send: (notificationEvent, force) => sendTelegram(config, notificationEvent, logger, force)
    },
    email: {
      label: "Email",
      fallback: config.email.fallback || "off",
      enabled: shouldSend(config.email.mode, event.success),
      send: (notificationEvent, force) => sendEmail(config, notificationEvent, logger, force)
    }
  };
  const delivery = {
    telegram: { status: "skipped", role: "primary" },
    email: { status: "skipped", role: "primary" }
  };

  for (const name of ["telegram", "email"]) {
    const channel = channels[name];
    if (!channel.enabled) {
      continue;
    }
    try {
      await channel.send(event, false);
      delivery[name] = { status: "success", role: "primary" };
    } catch (error) {
      delivery[name] = { status: "failed", role: "primary", error };
      errors.push(`${channel.label}: ${error.message}`);
      logger.error(`${channel.label} notification failed`, { error: error.message });
    }
  }

  for (const sourceName of ["telegram", "email"]) {
    const source = channels[sourceName];
    const sourceDelivery = delivery[sourceName];
    const targetName = source.fallback;
    if (sourceDelivery.status !== "failed" || sourceDelivery.role !== "primary" || targetName === "off") {
      continue;
    }

    const target = channels[targetName];
    const targetDelivery = delivery[targetName];
    if (targetDelivery.status === "success") {
      logger.warn("Notification fallback was already delivered by the target channel", {
        from: source.label,
        to: target.label
      });
      continue;
    }
    if (targetDelivery.status === "failed") {
      logger.error("Notification fallback target also failed", {
        from: source.label,
        to: target.label,
        error: targetDelivery.error.message
      });
      continue;
    }

    const fallbackEvent = {
      ...event,
      notificationFallback: {
        from: source.label,
        to: target.label,
        error: sourceDelivery.error.message
      }
    };
    try {
      await target.send(fallbackEvent, true);
      delivery[targetName] = { status: "success", role: "fallback", from: sourceName };
      logger.warn("Notification fallback delivered", {
        from: source.label,
        to: target.label
      });
    } catch (error) {
      delivery[targetName] = { status: "failed", role: "fallback", from: sourceName, error };
      errors.push(`${target.label} fallback for ${source.label}: ${error.message}`);
      logger.error("Notification fallback failed", {
        from: source.label,
        to: target.label,
        error: error.message
      });
    }
  }

  return { event, errors, delivery };
}

async function testTelegram(config, logger) {
  const event = await buildNotificationTestEvent(config, "Telegram");
  await sendTelegram(config, event, logger, true);
  return event;
}

async function testEmail(config, logger) {
  const event = await buildNotificationTestEvent(config, "email");
  await sendEmail(config, event, logger, true);
  return event;
}

module.exports = {
  notify,
  buildEvent,
  testTelegram,
  testEmail
};
