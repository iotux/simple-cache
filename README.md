# Simple-Cache

Simple-Cache is zero dependency simple caching library for Node.js applications. It is a slimmed down version of **@iotux/uni-cache**.
This module is preferred in small systems where memory size is a concern or when database storage is not needed.
It presents a single API across in-memory and file  backends, making it straightforward to switch storage engines without rewriting business logic.

## Table of Contents
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [API](#api)
- [Backend Guides](#backend-guides)
- [Troubleshooting](#troubleshooting)
- [License](#license)
- [Contributing](#contributing)

## Features
- Multiple backends: memory, filesystem.
- Consistent CRUD helpers for both nested keys and entire objects.
- Configurable persistence: sync eagerly on every write, on demand, or on a fixed interval.
- Optional logging hook for integrating with your existing observability tools.

## Installation

```bash
npm install @iotux/simple-cache
```

## Quick Start

```javascript
const SimpleCache = require('@iotux/simple-cache');

async function demo() {
  const cache = new SimpleCache('demo-cache', { cacheType: 'memory' });
  await cache.init({ counter: 0 }); // Seeds the cache on first run.

  await cache.add('counter', 5);
  await cache.set('user.name', 'Ada Lovelace');

  console.log(await cache.get('counter')); // 5
  console.log(await cache.get('user.name')); // "Ada Lovelace"
}

demo().catch(console.error);
```

## Usage

### Choosing a backend
- `memory`: Fastest option when persistence is not required.
- `file`: Stores aggregate data in a single JSON file; per-object data is written to separate files.

### Aggregate keys vs. object storage
- Use `set`, `get`, and `delete` for scalar values or nested properties (`await cache.set('user.profile.email', 'ada@example.com')`).
- Use `createObject`, `retrieveObject`, and `deleteObject` to persist full JSON documents by top-level key (for example one file or SQLite row per customer record).
- The module tracks object-backed keys separately so that nested updates (`await cache.set('customer-42.balance', 100)`) operate directly on objects stored via `createObject`.

### Sync strategies
- `syncOnWrite: true` writes through to the backend on every mutation.
- `syncOnWrite: false` batches writes until `await cache.sync()` is called.
- `syncInterval` (seconds) enables periodic flushes.

## API

### Lifecycle
- `new SimpleCache(name, options)` – create an instance.
- `init(initialData)` – prepare the backend and optionally seed data.
- `sync(force)` – persist dirty aggregate data and pending object work.
- `close()` – flush remaining work (if `syncOnClose` is set) and tear down backend connections.

### Aggregate operations
- `get(path)` – retrieve a value (supports dot notation).
- `set(path, value, syncNow)` – store a value.
- `delete(path, syncNow)` – remove a value.
- `add(path, count, syncNow)` / `subtract(path, count, syncNow)` – numeric adjustments.
- `push(path, element, syncNow)` – append to an array.

### Whole-object helpers
- `createObject(key, payload, syncNow)` – persist a top-level object.
- `retrieveObject(key)` – fetch an object created with `createObject`.
- `deleteObject(key, syncNow)` – remove a stored object.

### Introspection
- `has(path)` – determine if a value exists.
- `keys()` – list top-level keys (aggregate and object-backed).
- `count()` – count top-level keys.
- `clear(syncNow)` – remove all data.
- `existsObject()` / `getInMemorySize()` – simple state queries.

## Backend Guides

### In-memory
```javascript
const cache = new SimpleCache('session-cache', { cacheType: 'memory', debug: true });
await cache.init();
await cache.set('activeUsers', 10);
```

### File
```javascript
const cache = new SimpleCache('settings', {
  cacheType: 'file',
  savePath: './data/settings',
  syncOnWrite: false,
});

await cache.init();
await cache.set('ui.theme', 'dark');
await cache.sync(); // Flush batched changes to disk.
```

## Troubleshooting
- **File backend:** Keep object keys free of path separators; each object is written to `<savePath>/<key>.json`.

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.

## Contributing

Issues and pull requests are welcome. Please describe the backend(s) involved and any reproduction steps when reporting bugs.
