#!/usr/bin/env node
// Compatibility entry point: rebuild every book and the catalog.
import { rebuildAll } from './import-book.mjs';

rebuildAll();
