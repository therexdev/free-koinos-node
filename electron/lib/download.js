"use strict";

// Dependency-free HTTPS helpers shared by the node manager (chain backup) and
// the setup service (Docker installer). Support redirects, HEAD metadata,
// small text bodies, and resumable large-file downloads with progress.

const https = require("https");
const fs = require("fs");

function requestWithRedirects(url, options, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const go = (target, redirectsLeft) => {
      const req = https.request(target, options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          return go(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
        }
        resolve(res);
      });
      req.on("error", reject);
      if (options.signal) {
        options.signal.addEventListener("abort", () => req.destroy(new Error("Cancelled")), { once: true });
      }
      req.end();
    };
    go(url, maxRedirects);
  });
}

async function httpHead(url) {
  const res = await requestWithRedirects(url, { method: "HEAD", timeout: 30000 });
  res.resume();
  if (res.statusCode !== 200) throw new Error(`Server returned HTTP ${res.statusCode}`);
  return {
    size: Number(res.headers["content-length"] ?? 0),
    lastModified: res.headers["last-modified"] ?? null,
    etag: res.headers.etag ?? null,
    acceptRanges: /bytes/.test(res.headers["accept-ranges"] ?? ""),
  };
}

async function httpGetText(url) {
  const res = await requestWithRedirects(url, { method: "GET", timeout: 30000 });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} fetching ${url}`);
  }
  let data = "";
  res.setEncoding("utf8");
  for await (const chunk of res) {
    data += chunk;
    if (data.length > 1024 * 1024) break;
  }
  return data;
}

async function httpDownload(url, dest, { resumeFrom = 0, onProgress, signal } = {}) {
  const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
  const res = await requestWithRedirects(url, { method: "GET", headers, signal });
  if (resumeFrom > 0 && res.statusCode !== 206) {
    // Server ignored the range; start over.
    res.resume();
    if (res.statusCode === 200) {
      fs.rmSync(dest, { force: true });
      return httpDownload(url, dest, { resumeFrom: 0, onProgress, signal });
    }
    throw new Error(`Server returned HTTP ${res.statusCode}`);
  }
  if (resumeFrom === 0 && res.statusCode !== 200) {
    res.resume();
    throw new Error(`Server returned HTTP ${res.statusCode}`);
  }
  const total = resumeFrom + Number(res.headers["content-length"] ?? 0);
  let done = resumeFrom;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: resumeFrom > 0 ? "a" : "w" });
    let lastTick = 0;
    res.on("data", (chunk) => {
      done += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 500) {
        lastTick = now;
        onProgress(done, total);
      }
    });
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    res.pipe(out);
  });
  onProgress?.(done, total);
  return { size: done };
}

module.exports = { requestWithRedirects, httpHead, httpGetText, httpDownload };
