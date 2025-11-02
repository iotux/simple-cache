const fs = require('fs').promises;
const path = require('path');
const CacheBackend = require('./CacheBackend');

class FileBackend extends CacheBackend {
  constructor(config) {
    super();
    this.cacheName = config.cacheName;
    this.savePath = config.savePath || './data';
    this.fileExtension = config.fileExtension || '.json';
    this.filePath = path.join(this.savePath, `${this.cacheName}${this.fileExtension}`);
    this.keyFileBuilder =
      typeof config.keyFileBuilder === 'function'
        ? config.keyFileBuilder
        : (key) => `${key}${this.fileExtension}`;
    this.filenameToKey =
      typeof config.filenameToKey === 'function'
        ? config.filenameToKey
        : (filename) => {
            if (!filename.endsWith(this.fileExtension)) return null;
            const key = filename.slice(0, -this.fileExtension.length);
            if (key === this.cacheName) return null;
            return key;
          };
    this.debug = config.debug || false;
    this.log = config.logFunction || (() => {});
    this.objectKeys = new Set();
  }

  async _ensureDirectoryExists() {
    try {
      await fs.access(this.savePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (this.debug) this.log(`[FileBackend] Directory ${this.savePath} does not exist. Creating...`);
        await fs.mkdir(this.savePath, { recursive: true });
        if (this.debug) this.log(`[FileBackend] Directory created: ${this.savePath}`);
      } else {
        this.log(`[FileBackend] Error accessing directory ${this.savePath}:`, error.message);
        throw error;
      }
    }
  }

  _assertKeySafe(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('[FileBackend] object operations require string keys.');
    }
    if (key.includes('/') || key.includes('\\')) {
      throw new Error(`[FileBackend] object operations do not support keys containing path separators: "${key}"`);
    }
  }

  _keyToFilePath(key) {
    this._assertKeySafe(key);
    const fileName = this.keyFileBuilder(key);
    return path.join(this.savePath, fileName);
  }

  async _listObjectFiles() {
    const files = new Map();
    try {
      const entries = await fs.readdir(this.savePath);
      for (const entry of entries) {
        if (entry === path.basename(this.filePath)) continue;
        const key = this.filenameToKey(entry);
        if (key === null || key === undefined) continue;
        files.set(key, path.join(this.savePath, entry));
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this._ensureDirectoryExists();
        return files;
      }
      this.log(`[FileBackend] Error listing files in ${this.savePath}: ${error.message}`);
      throw error;
    }
    return files;
  }

  async connect() {
    await this._ensureDirectoryExists();
    if (this.debug) {
      this.log(`[FileBackend] Initialized for ${this.cacheName} at ${this.filePath}`);
    }
  }

  async _loadData() {
    try {
      const jsonData = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(jsonData);
    } catch (err) {
      if (err.code === 'ENOENT') {
        if (this.debug) this.log(`[FileBackend] Cache file ${this.filePath} not found. Returning empty object.`);
        return {};
      } else if (err instanceof SyntaxError) {
        this.log(`[FileBackend] Error parsing JSON from ${this.filePath}: ${err.message}. Returning empty object.`);
        return {};
      }
      this.log(`[FileBackend] Error reading cache file ${this.filePath}: ${err.message}`);
      throw err;
    }
  }

  async _saveData(data) {
    try {
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      if (this.debug) this.log(`[FileBackend] Data saved to ${this.filePath}`);
    } catch (err) {
      this.log(`[FileBackend] Error writing cache file ${this.filePath}: ${err.message}`);
      throw err;
    }
  }

  async _refreshObjectKeys() {
    await this._ensureDirectoryExists();
    const files = await this._listObjectFiles();
    const newKeys = new Set(files.keys());
    this.objectKeys = newKeys;
    return files;
  }

  async save(data) {
    await this._ensureDirectoryExists();
    const objectFiles = await this._refreshObjectKeys();
    const aggregateData = {};

    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        if (this.objectKeys.has(key) || objectFiles.has(key)) {
          await this.createObject(key, value);
          objectFiles.delete(key);
        } else {
          aggregateData[key] = value;
        }
      }
    }

    for (const [staleKey, stalePath] of objectFiles.entries()) {
      try {
        await fs.unlink(stalePath);
        this.objectKeys.delete(staleKey);
        if (this.debug) this.log(`[FileBackend] Removed stale object cache file ${stalePath}`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          this.log(`[FileBackend] Error deleting stale file ${stalePath}: ${err.message}`);
          throw err;
        }
      }
    }

    await this._saveData(aggregateData);
  }

  async fetch() {
    const aggregate = await this._loadData();
    await this._refreshObjectKeys();
    return aggregate;
  }

  async delete(key) {
    const data = await this._loadData();
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      delete data[key];
      await this._saveData(data);
      if (this.debug) this.log(`[FileBackend] Key "${key}" deleted from ${this.filePath}`);
      return true;
    }
    if (this.debug) this.log(`[FileBackend] Key "${key}" not found in ${this.filePath}. No deletion.`);
    return false;
  }

  async has(key) {
    if (this.objectKeys.has(key)) {
      try {
        await fs.access(this._keyToFilePath(key));
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        this.log(`[FileBackend] Error checking existence of key "${key}": ${err.message}`);
        throw err;
      }
    }

    const data = await this._loadData();
    return Object.prototype.hasOwnProperty.call(data, key);
  }

  async clear() {
    await this._saveData({});
    const files = await this._listObjectFiles();
    for (const [, filePath] of files.entries()) {
      try {
        await fs.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          this.log(`[FileBackend] Error clearing file ${filePath}: ${err.message}`);
          throw err;
        }
      }
    }
    this.objectKeys.clear();
    if (this.debug) this.log(`[FileBackend] Cache ${this.cacheName} cleared.`);
  }

  async keys() {
    const aggregateKeys = Object.keys(await this._loadData());
    await this._refreshObjectKeys();
    const allKeys = new Set([...aggregateKeys, ...this.objectKeys]);
    return Array.from(allKeys);
  }

  async count() {
    const aggregateKeys = Object.keys(await this._loadData());
    await this._refreshObjectKeys();
    return aggregateKeys.length + this.objectKeys.size;
  }

  async add(key, count) {
    const data = await this._loadData();
    data[key] = (Number(data[key]) || 0) + Number(count);
    await this.save(data);
  }

  async subtract(key, count) {
    const data = await this._loadData();
    data[key] = (Number(data[key]) || 0) - Number(count);
    await this.save(data);
  }

  async push(key, element) {
    const data = await this._loadData();
    if (!Array.isArray(data[key])) {
      data[key] = [];
    }
    data[key].push(element);
    await this.save(data);
  }

  async retrieveObject(key) {
    const filePath = this._keyToFilePath(key);
    try {
      const data = await fs.readFile(filePath, 'utf8');
      this.objectKeys.add(key);
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        if (this.debug) this.log(`[FileBackend] retrieveObject: Key "${key}" not found.`);
        return undefined;
      } else if (err instanceof SyntaxError) {
        this.log(`[FileBackend] retrieveObject: Failed to parse JSON for key "${key}": ${err.message}`);
        return undefined;
      }
      this.log(`[FileBackend] retrieveObject: Error reading key "${key}": ${err.message}`);
      throw err;
    }
  }

  async createObject(key, value) {
    const filePath = this._keyToFilePath(key);
    await this._ensureDirectoryExists();
    const aggregate = await this._loadData();
    if (Object.prototype.hasOwnProperty.call(aggregate, key)) {
      delete aggregate[key];
      await this._saveData(aggregate);
    }
    try {
      await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
      this.objectKeys.add(key);
      if (this.debug) this.log(`[FileBackend] createObject wrote ${filePath}`);
    } catch (err) {
      this.log(`[FileBackend] Error writing object ${key} to ${filePath}: ${err.message}`);
      throw err;
    }
  }

  async deleteObject(key) {
    const aggregate = await this._loadData();
    if (Object.prototype.hasOwnProperty.call(aggregate, key)) {
      delete aggregate[key];
      await this._saveData(aggregate);
    }

    const filePath = this._keyToFilePath(key);
    try {
      await fs.unlink(filePath);
      this.objectKeys.delete(key);
      if (this.debug) this.log(`[FileBackend] deleteObject removed ${filePath}`);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        if (this.debug) this.log(`[FileBackend] deleteObject: Key "${key}" not found.`);
        return false;
      }
      this.log(`[FileBackend] deleteObject: Error removing key "${key}": ${err.message}`);
      throw err;
    }
  }

  async close() {
    if (this.debug) this.log(`[FileBackend] Close called for ${this.cacheName}. No action needed.`);
  }

  async listObjectKeys() {
    await this._refreshObjectKeys();
    return Array.from(this.objectKeys);
  }
}

module.exports = FileBackend;
