#!/usr/bin/env node
const fs = require("fs");
const { pipeline } = require("stream/promises");
const axios = require("axios");
const { SocksProxyAgent } = require("socks-proxy-agent");

function envBool(name) {
  return ["1", "true", "yes", "y", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

async function main() {
  const url = process.env.BACKUP_AGENT_UPDATE_URL;
  const output = process.env.BACKUP_AGENT_UPDATE_OUTPUT;
  const useProxy = envBool("BACKUP_AGENT_UPDATE_USE_PROXY");
  const proxyUrl = process.env.BACKUP_AGENT_PROXY_URL || "";

  if (!url) {
    throw new Error("BACKUP_AGENT_UPDATE_URL is required.");
  }
  if (!output) {
    throw new Error("BACKUP_AGENT_UPDATE_OUTPUT is required.");
  }
  if (useProxy && !proxyUrl) {
    throw new Error("BACKUP_AGENT_PROXY_URL is required when BACKUP_AGENT_UPDATE_USE_PROXY=true.");
  }

  const requestConfig = {
    responseType: "stream",
    timeout: 120000,
    maxRedirects: 10,
    validateStatus: (status) => status >= 200 && status < 300
  };
  if (useProxy) {
    const agent = new SocksProxyAgent(proxyUrl);
    requestConfig.httpAgent = agent;
    requestConfig.httpsAgent = agent;
    requestConfig.proxy = false;
  }

  try {
    const response = await axios.get(url, requestConfig);
    await pipeline(response.data, fs.createWriteStream(output));
  } catch (error) {
    fs.rmSync(output, { force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
