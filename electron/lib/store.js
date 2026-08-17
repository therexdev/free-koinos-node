"use strict";

const fs = require("fs");
const path = require("path");

// Minimal JSON-file store with atomic writes.
class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.data = { ...defaults };
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      this.data = deepMerge({ ...defaults }, JSON.parse(raw));
    } catch {
      // Missing or corrupt file: start from defaults.
    }
  }

  get(key, fallback) {
    const v = key.split(".").reduce((o, k) => (o == null ? o : o[k]), this.data);
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    const parts = key.split(".");
    let obj = this.data;
    for (const part of parts.slice(0, -1)) {
      if (typeof obj[part] !== "object" || obj[part] === null) obj[part] = {};
      obj = obj[part];
    }
    obj[parts[parts.length - 1]] = value;
    this.save();
  }

  all() {
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

function deepMerge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
      base[k] = deepMerge({ ...base[k] }, v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

module.exports = { JsonStore, deepMerge };
