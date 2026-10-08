#!/usr/bin/env node
// Compatibility entry point: rebuild every book and the catalog.
process.argv = [process.argv[0], process.argv[1], '--all'];
await import('./import-book.mjs');
