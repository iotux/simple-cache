const BACKEND_MODULES = {
  file: "./backends/FileBackend",
};

const asPath = (key) => {
  if (Array.isArray(key)) return key;
  if (typeof key !== "string") return [];
  return key.split(".").filter(Boolean);
};

const getProperties = (obj, key) => {
  const parts = asPath(key);
  if (parts.length === 0) return undefined;
  let current = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
};

const setProperties = (obj, key, value) => {
  const parts = asPath(key);
  if (parts.length === 0) return;
  let current = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
};

const deleteProperties = (obj, key) => {
  const parts = asPath(key);
  if (parts.length === 0) return false;
  const stack = [];
  let current = obj;

  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (current === null || typeof current !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return false;
    stack.push({ parent: current, key: part });
    current = current[part];
  }

  if (current === null || typeof current !== "object") return false;
  const leaf = parts[parts.length - 1];
  if (!Object.prototype.hasOwnProperty.call(current, leaf)) return false;

  delete current[leaf];

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const { parent, key: segment } = stack[i];
    const candidate = parent[segment];
    if (
      candidate &&
      typeof candidate === "object" &&
      Object.keys(candidate).length === 0
    ) {
      delete parent[segment];
    } else {
      break;
    }
  }
  return true;
};

const cloneValue = (value) => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  return Object.entries(value).reduce((acc, [key, val]) => {
    acc[key] = cloneValue(val);
    return acc;
  }, {});
};

class UniCache {
  constructor(cacheName, options = {}) {
    if (!cacheName || typeof cacheName !== "string") {
      throw new Error("UniCache constructor requires a cacheName string.");
    }

    this.cacheName = cacheName;
    this.options = { cacheType: "memory", syncOnWrite: false, ...options };
    this.cacheType = this.options.cacheType || "memory";

    if (options.logFunction && typeof options.logFunction === "function") {
      this.log = (...args) => options.logFunction("[UniCache]", ...args);
    } else if (options.debug) {
      this.log = (...args) => console.log("[UniCache]", ...args);
    } else {
      this.log = () => {};
    }

    this.backend = null;
    this.inMemoryData = {};
    this.objectKeys = new Set();
    this.objectCache = new Map();
    this.dirty = false;
    this.dirtyObjectKeys = new Set();
    this.pendingObjectDeletes = new Set();

    this.syncIntervalId = null;
    const syncIntervalSeconds = Number(this.options.syncInterval);
    if (
      syncIntervalSeconds &&
      Number.isFinite(syncIntervalSeconds) &&
      syncIntervalSeconds > 0
    ) {
      this.syncIntervalId = setInterval(() => {
        this.sync().catch((error) =>
          this.log(`Periodic sync failed: ${error.message}`),
        );
      }, syncIntervalSeconds * 1000);
    }
  }

  async init(initialData) {
    await this._initializeBackend();
    if (initialData && this.isEmpty()) {
      await this.save(initialData, this.options.syncOnWrite);
    }
  }

  async _initializeBackend() {
    if (this.cacheType === "memory") {
      this.backend = null;
      this.log(`Cache "${this.cacheName}" running in memory mode.`);
      return;
    }

    const backendModule = BACKEND_MODULES[this.cacheType];
    if (!backendModule) {
      this.log(
        `Unknown cacheType "${this.cacheType}". Falling back to memory mode.`,
      );
      this.cacheType = "memory";
      this.backend = null;
      return;
    }

    const Backend = require(backendModule);
    const backendOptions = {
      ...this.options,
      cacheName: this.cacheName,
      logFunction: this.log,
    };
    this.backend = new Backend(backendOptions);

    if (typeof this.backend.connect === "function") {
      await this.backend.connect();
    }

    await this._loadFromBackend();
  }

  async _loadFromBackend() {
    if (!this.backend) return;

    if (typeof this.backend.fetch === "function") {
      try {
        const data = await this.backend.fetch();
        this.inMemoryData =
          data && typeof data === "object" ? cloneValue(data) : {};
      } catch (error) {
        this.log(
          `Failed to fetch existing data for "${this.cacheName}": ${error.message}`,
        );
        this.inMemoryData = {};
      }
    }

    this.objectKeys.clear();
    this.objectCache.clear();
    this.dirty = false;
    this.dirtyObjectKeys.clear();
    this.pendingObjectDeletes.clear();

    if (typeof this.backend.listObjectKeys === "function") {
      try {
        const keys = await this.backend.listObjectKeys();
        keys.forEach((key) => this.objectKeys.add(key));
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(this.inMemoryData, key)) {
            delete this.inMemoryData[key];
          }
        }
      } catch (error) {
        this.log(
          `Failed to list object keys for "${this.cacheName}": ${error.message}`,
        );
      }
    }
  }

  async existsObject() {
    return !this.isEmpty();
  }

  isEmpty() {
    return (
      Object.keys(this.inMemoryData).length === 0 && this.objectKeys.size === 0
    );
  }

  getInMemorySize() {
    return Object.keys(this.inMemoryData).length;
  }

  async fetch() {
    return cloneValue(this.inMemoryData);
  }

  async get(key) {
    const parts = asPath(key);
    if (parts.length === 0) return undefined;
    const [top, ...rest] = parts;

    if (this.objectKeys.has(top)) {
      const object = await this._ensureObjectLoaded(top);
      if (object === undefined) return undefined;
      if (rest.length === 0) return cloneValue(object);
      return cloneValue(getProperties(object, rest));
    }

    return cloneValue(getProperties(this.inMemoryData, parts));
  }

  async set(key, value, syncNow = this.options.syncOnWrite) {
    const parts = asPath(key);
    if (parts.length === 0) return;
    const [top, ...rest] = parts;
    const payload = cloneValue(value);

    if (rest.length === 0) {
      const replacedObject = this.objectKeys.has(top);
      if (replacedObject) {
        await this._scheduleObjectDeletion(top, syncNow);
      }
      this.inMemoryData[top] = payload;
      this.dirty = true;
      if (syncNow) await this.sync();
      return;
    }

    if (this.objectKeys.has(top)) {
      const object = (await this._ensureObjectLoaded(top)) || {};
      setProperties(object, rest, payload);
      await this._markObjectDirty(top, syncNow);
      return;
    }

    if (
      !Object.prototype.hasOwnProperty.call(this.inMemoryData, top) ||
      typeof this.inMemoryData[top] !== "object"
    ) {
      this.inMemoryData[top] = {};
    }
    setProperties(this.inMemoryData, parts, payload);
    this.dirty = true;
    if (syncNow) await this.sync();
  }

  async delete(key, syncNow = this.options.syncOnWrite) {
    const parts = asPath(key);
    if (parts.length === 0) return;
    const [top, ...rest] = parts;

    if (rest.length === 0) {
      if (this.objectKeys.has(top)) {
        await this._scheduleObjectDeletion(top, syncNow);
        if (syncNow) await this.sync();
      } else if (Object.prototype.hasOwnProperty.call(this.inMemoryData, top)) {
        delete this.inMemoryData[top];
        this.dirty = true;
        if (syncNow) await this.sync();
      }
      return;
    }

    if (this.objectKeys.has(top)) {
      const object = await this._ensureObjectLoaded(top);
      if (!object) return;
      const removed = deleteProperties(object, rest);
      if (removed) await this._markObjectDirty(top, syncNow);
      return;
    }

    const removed = deleteProperties(this.inMemoryData, parts);
    if (removed) {
      this.dirty = true;
      if (syncNow) await this.sync();
    }
  }

  async has(key) {
    const parts = asPath(key);
    if (parts.length === 0) return false;
    const [top, ...rest] = parts;

    if (this.objectKeys.has(top)) {
      if (rest.length === 0) return true;
      const object = await this._ensureObjectLoaded(top);
      if (!object) return false;
      return getProperties(object, rest) !== undefined;
    }

    return getProperties(this.inMemoryData, parts) !== undefined;
  }

  async clear(syncNow = this.options.syncOnWrite) {
    const objectKeys = Array.from(this.objectKeys);
    this.inMemoryData = {};
    this.objectCache.clear();
    this.objectKeys.clear();
    this.dirty = true;
    this.dirtyObjectKeys.clear();
    this.pendingObjectDeletes.clear();

    if (this.backend && typeof this.backend.deleteObject === "function") {
      objectKeys.forEach((key) => this.pendingObjectDeletes.add(key));
    }

    if (syncNow) await this.sync(true);
  }

  async keys() {
    const aggregate = new Set(Object.keys(this.inMemoryData));
    this.objectKeys.forEach((key) => aggregate.add(key));
    return Array.from(aggregate);
  }

  async count() {
    const keys = await this.keys();
    return keys.length;
  }

  async add(key, count, syncNow = this.options.syncOnWrite) {
    const current = Number(await this.get(key)) || 0;
    await this.set(key, current + Number(count), syncNow);
  }

  async subtract(key, count, syncNow = this.options.syncOnWrite) {
    const current = Number(await this.get(key)) || 0;
    await this.set(key, current - Number(count), syncNow);
  }

  async push(key, element, syncNow = this.options.syncOnWrite) {
    const current = await this.get(key);
    const arr = Array.isArray(current) ? current.slice() : [];
    arr.push(cloneValue(element));
    await this.set(key, arr, syncNow);
  }

  async save(data, syncNow = this.options.syncOnWrite) {
    if (!data || typeof data !== "object") return;

    for (const [key, value] of Object.entries(data)) {
      if (this.objectKeys.has(key)) {
        await this.createObject(key, value, syncNow);
      } else {
        this.inMemoryData[key] = cloneValue(value);
        this.dirty = true;
      }
    }

    if (syncNow) await this.sync();
  }

  async createObject(key, value, syncNow = this.options.syncOnWrite) {
    if (!key || typeof key !== "string") {
      throw new Error("createObject requires a non-empty string key.");
    }

    const payload = cloneValue(value);
    this.objectKeys.add(key);
    this.objectCache.set(key, payload);
    if (Object.prototype.hasOwnProperty.call(this.inMemoryData, key)) {
      delete this.inMemoryData[key];
      this.dirty = true;
    }
    this.dirtyObjectKeys.delete(key);
    this.pendingObjectDeletes.delete(key);

    if (!this.backend || typeof this.backend.createObject !== "function") {
      this.inMemoryData[key] = cloneValue(payload);
      this.dirty = true;
      if (syncNow) await this.sync();
      return;
    }

    if (syncNow) {
      await this.backend.createObject(key, cloneValue(payload));
    } else {
      this.dirtyObjectKeys.add(key);
    }
  }

  async retrieveObject(key) {
    if (!key || typeof key !== "string") {
      throw new Error("retrieveObject requires a non-empty string key.");
    }

    if (this.objectCache.has(key)) {
      return cloneValue(this.objectCache.get(key));
    }

    const loaded = await this._ensureObjectLoaded(key);
    return cloneValue(loaded);
  }

  async deleteObject(key, syncNow = this.options.syncOnWrite) {
    if (!key || typeof key !== "string") {
      throw new Error("deleteObject requires a non-empty string key.");
    }

    const hadCache = this.objectCache.delete(key);
    const hadKey = this.objectKeys.delete(key);
    const hadData = Object.prototype.hasOwnProperty.call(
      this.inMemoryData,
      key,
    );
    if (hadData) {
      delete this.inMemoryData[key];
      this.dirty = true;
    }
    this.dirtyObjectKeys.delete(key);
    let removed = hadCache || hadKey || hadData;

    if (this.backend && typeof this.backend.deleteObject === "function") {
      if (syncNow) {
        await this.backend.deleteObject(key);
      } else {
        this.pendingObjectDeletes.add(key);
      }
      removed = true;
    }

    if (syncNow) {
      await this.sync();
    }

    return removed;
  }

  async sync(forceSync = false) {
    if (!this.backend) return;

    const hasObjectWork =
      this.dirtyObjectKeys.size > 0 || this.pendingObjectDeletes.size > 0;
    if (!forceSync && !this.dirty && !hasObjectWork) return;

    if (this.dirty || forceSync) {
      await this.backend.save(cloneValue(this.inMemoryData));
      this.dirty = false;
    }

    if (
      this.pendingObjectDeletes.size > 0 &&
      typeof this.backend.deleteObject === "function"
    ) {
      for (const key of Array.from(this.pendingObjectDeletes)) {
        await this.backend.deleteObject(key);
        this.pendingObjectDeletes.delete(key);
      }
    }

    if (
      this.dirtyObjectKeys.size > 0 &&
      typeof this.backend.createObject === "function"
    ) {
      for (const key of Array.from(this.dirtyObjectKeys)) {
        if (this.objectCache.has(key)) {
          await this.backend.createObject(
            key,
            cloneValue(this.objectCache.get(key)),
          );
        }
        this.dirtyObjectKeys.delete(key);
      }
    }
  }

  async close() {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }

    if (this.options.syncOnClose) {
      await this.sync();
    }

    if (this.backend && typeof this.backend.close === "function") {
      await this.backend.close();
    }
  }

  async _ensureObjectLoaded(key) {
    if (this.objectCache.has(key)) {
      return this.objectCache.get(key);
    }

    let source;

    if (this.backend && typeof this.backend.retrieveObject === "function") {
      try {
        source = await this.backend.retrieveObject(key);
      } catch (error) {
        this.log(
          `Failed to retrieve object "${key}" from backend: ${error.message}`,
        );
        source = undefined;
      }
    }

    if (
      source === undefined &&
      Object.prototype.hasOwnProperty.call(this.inMemoryData, key)
    ) {
      source = this.inMemoryData[key];
      delete this.inMemoryData[key];
      this.dirty = true;
    }

    if (source === undefined) return undefined;

    const hydrated = cloneValue(source);
    this.objectKeys.add(key);
    this.objectCache.set(key, hydrated);
    return hydrated;
  }

  async _markObjectDirty(key, syncNow) {
    if (!this.backend || typeof this.backend.createObject !== "function")
      return;

    if (syncNow) {
      await this.backend.createObject(
        key,
        cloneValue(this.objectCache.get(key)),
      );
      this.dirtyObjectKeys.delete(key);
    } else {
      this.dirtyObjectKeys.add(key);
    }
  }

  async _scheduleObjectDeletion(key, syncNow) {
    const hadCache = this.objectCache.delete(key);
    const hadKey = this.objectKeys.delete(key);
    const hadData = Object.prototype.hasOwnProperty.call(
      this.inMemoryData,
      key,
    );
    if (hadData) {
      delete this.inMemoryData[key];
      this.dirty = true;
    }
    this.dirtyObjectKeys.delete(key);

    if (this.backend && typeof this.backend.deleteObject === "function") {
      if (syncNow) {
        await this.backend.deleteObject(key);
      } else if (hadCache || hadKey) {
        this.pendingObjectDeletes.add(key);
      }
    }

    return hadCache || hadKey || hadData;
  }
}

module.exports = UniCache;
