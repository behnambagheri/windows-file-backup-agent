const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const test = require("node:test");
const axios = require("axios");
const nodemailer = require("nodemailer");
const { notify, testTelegram, testEmail } = require("../src/notifications");
const { testDestination } = require("../src/transfer");

function config() {
  return {
    app: { hostname: "source-host" },
    destination: {
      host: "destination.example",
      port: 22,
      username: "backup-user",
      remoteDir: "/backups",
      authMethod: "password",
      password: "secret",
      socks5Enabled: false
    },
    telegram: {
      mode: "off",
      fallback: "off",
      apiUrl: "https://telegram.example",
      useProxy: false,
      proxy: "",
      token: "test-token",
      chatId: "1234",
      topicId: "55"
    },
    email: {
      mode: "off",
      fallback: "off",
      host: "smtp.example",
      port: 465,
      secure: true,
      user: "sender",
      password: "secret",
      from: "sender@example.com",
      to: ["receiver@example.com"],
      cc: [],
      bcc: [],
      useProxy: false,
      proxy: "",
      subjectPrefix: "[backup-agent]"
    }
  };
}

function logger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {}
  };
}

test("Telegram diagnostic sends a real test message when mode is off", async () => {
  const originalPost = axios.post;
  let request;
  axios.post = async (...args) => {
    request = args;
    return { status: 200 };
  };

  try {
    await testTelegram(config(), logger());
  } finally {
    axios.post = originalPost;
  }

  assert.equal(request[0], "https://telegram.example/bottest-token/sendMessage");
  assert.equal(request[1].chat_id, "1234");
  assert.equal(request[1].message_thread_id, "55");
  assert.match(request[1].text, /Telegram notification test SUCCESS/);
  assert.match(request[1].text, /No backup file was transferred/);
});

test("Email diagnostic sends a real test message when mode is off", async () => {
  const originalCreateTransport = nodemailer.createTransport;
  let transportOptions;
  let message;
  nodemailer.createTransport = (options) => {
    transportOptions = options;
    return {
      sendMail: async (mail) => {
        message = mail;
      }
    };
  };

  try {
    await testEmail(config(), logger());
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }

  assert.equal(transportOptions.host, "smtp.example");
  assert.deepEqual(message.to, ["receiver@example.com"]);
  assert.match(message.subject, /email notification test SUCCESS/);
  assert.match(message.text, /No backup file was transferred/);
});

test("Email diagnostic uses the shared proxy when enabled", async () => {
  const originalCreateTransport = nodemailer.createTransport;
  const testConfig = config();
  testConfig.email.useProxy = true;
  testConfig.email.proxy = "socks5://proxy.example:1080";
  let transportOptions;
  let registeredSocksModule;
  nodemailer.createTransport = (options) => {
    transportOptions = options;
    return {
      set: (key, value) => {
        if (key === "proxy_socks_module") {
          registeredSocksModule = value;
        }
      },
      sendMail: async () => {}
    };
  };

  try {
    await testEmail(testConfig, logger());
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }

  assert.equal(transportOptions.proxy, "socks5://proxy.example:1080");
  assert.equal(typeof registeredSocksModule.SocksClient.createConnection, "function");
});

test("Telegram failure falls back to email even when email mode is off", async () => {
  const originalPost = axios.post;
  const originalCreateTransport = nodemailer.createTransport;
  const testConfig = config();
  testConfig.destination.host = "127.0.0.1";
  testConfig.telegram.mode = "all";
  testConfig.telegram.fallback = "email";
  let message;

  axios.post = async () => {
    throw new Error("Telegram unavailable");
  };
  nodemailer.createTransport = () => ({
    sendMail: async (mail) => {
      message = mail;
    }
  });

  let result;
  try {
    result = await notify(testConfig, { success: true }, logger());
  } finally {
    axios.post = originalPost;
    nodemailer.createTransport = originalCreateTransport;
  }

  assert.equal(result.delivery.telegram.status, "failed");
  assert.deepEqual(result.delivery.email, {
    status: "success",
    role: "fallback",
    from: "telegram"
  });
  assert.match(message.subject, /notification fallback: Telegram failed/);
  assert.match(message.text, /Telegram -> Email/);
  assert.match(message.text, /Telegram unavailable/);
});

test("Email failure falls back to Telegram even when Telegram mode is off", async () => {
  const originalPost = axios.post;
  const originalCreateTransport = nodemailer.createTransport;
  const testConfig = config();
  testConfig.destination.host = "127.0.0.1";
  testConfig.email.mode = "all";
  testConfig.email.fallback = "telegram";
  let telegramBody;

  axios.post = async (url, body) => {
    telegramBody = body;
    return { status: 200 };
  };
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      throw new Error("SMTP unavailable");
    }
  });

  let result;
  try {
    result = await notify(testConfig, { success: false, error: new Error("Backup failed") }, logger());
  } finally {
    axios.post = originalPost;
    nodemailer.createTransport = originalCreateTransport;
  }

  assert.equal(result.delivery.email.status, "failed");
  assert.deepEqual(result.delivery.telegram, {
    status: "success",
    role: "fallback",
    from: "email"
  });
  assert.match(telegramBody.text, /Email -&gt; Telegram/);
  assert.match(telegramBody.text, /SMTP unavailable/);
});

test("Fallback does not duplicate a target channel that already succeeded", async () => {
  const originalPost = axios.post;
  const originalCreateTransport = nodemailer.createTransport;
  const testConfig = config();
  testConfig.destination.host = "127.0.0.1";
  testConfig.telegram.mode = "all";
  testConfig.telegram.fallback = "email";
  testConfig.email.mode = "all";
  let emailCount = 0;

  axios.post = async () => {
    throw new Error("Telegram unavailable");
  };
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      emailCount += 1;
    }
  });

  try {
    await notify(testConfig, { success: true }, logger());
  } finally {
    axios.post = originalPost;
    nodemailer.createTransport = originalCreateTransport;
  }

  assert.equal(emailCount, 1);
});

test("Destination diagnostic writes, verifies, and removes its remote marker", async () => {
  const files = new Map();
  let connectionEnded = false;
  let sftpEnded = false;
  const sftp = {
    stat(target, callback) {
      if (target === "/backups") {
        callback(null, { size: 0 });
        return;
      }
      const content = files.get(target);
      if (content) {
        callback(null, { size: content.length });
        return;
      }
      const error = new Error("No such file");
      error.code = 2;
      callback(error);
    },
    createWriteStream(target) {
      const chunks = [];
      return new Writable({
        write(chunk, encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          files.set(target, Buffer.concat(chunks));
          callback();
        }
      });
    },
    unlink(target, callback) {
      files.delete(target);
      callback(null);
    },
    end() {
      sftpEnded = true;
    }
  };
  const connection = {
    sftp(callback) {
      callback(null, sftp);
    },
    end() {
      connectionEnded = true;
    }
  };

  const result = await testDestination(config(), logger(), async () => connection);

  assert.equal(result.remoteDir, "/backups");
  assert.equal(files.size, 0);
  assert.equal(sftpEnded, true);
  assert.equal(connectionEnded, true);
});
