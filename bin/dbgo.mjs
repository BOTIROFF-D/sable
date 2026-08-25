#!/usr/bin/env node
// Тонкая обёртка, чтобы `nur` работал как установленная команда.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts'));
