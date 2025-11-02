// src/backends/CacheBackend.js
/**
 * @interface CacheBackend
 * @description Interface for cache backend implementations.
 * All methods are expected to be asynchronous.
 */
class CacheBackend {
  /**
   * Initializes the backend connection if necessary.
   * @returns {Promise<void>}
   * @throws {Error} If connection fails.
   */
  async connect() {
    // Optional: specific backends can implement this if they need an explicit connection step.
  }

  /**
   * Save the entire cache data object to the backend.
   * @param {Object} data - Data object to save.
   * @returns {Promise<void>}
   * @throws {Error} If saving fails.
   */
  async save(data) {
    throw new Error('save(data) not implemented.');
  }

  /**
   * Fetch the entire cache data object from the backend.
   * @returns {Promise<Object>} The cached data object, or an empty object if not found/empty.
   * @throws {Error} If fetching fails.
   */
  async fetch() {
    throw new Error('fetch() not implemented.');
  }

  // ... other methods (delete, has, clear, keys, count, add, subtract, push, retrieveObject, close) remain ...
  async delete(key) {
    throw new Error('delete(key) not implemented.');
  }
  async has(key) {
    throw new Error('has(key) not implemented.');
  }
  async clear() {
    throw new Error('clear() not implemented.');
  }
  async keys() {
    throw new Error('keys() not implemented.');
  }
  async count() {
    throw new Error('count() not implemented.');
  }
  async add(key, count) {
    throw new Error('add(key, count) not implemented.');
  }
  async subtract(key, count) {
    throw new Error('subtract(key, count) not implemented.');
  }
  async push(key, element) {
    throw new Error('push(key, element) not implemented.');
  }
  async retrieveObject(key) {
    throw new Error('retrieveObject(key) not implemented.');
  }
  async createObject(key, value) {
    throw new Error('createObject(key, value) not implemented.');
  }
  async deleteObject(key) {
    throw new Error('deleteObject(key) not implemented.');
  }
  async close() {
    /* Optional */
  }
}

module.exports = CacheBackend;
