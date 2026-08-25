import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { registerSource, runtimeError, shortPath, type Span } from './errors.ts';
import type { Interpreter } from './interpreter.ts';
import { tokenize } from './lexer.ts';
import { parse } from './parser.ts';
import { DbgoModule } from './values.ts';

/**
 * Загрузчик модулей. Каждый файл выполняется ровно один раз: повторный import
 * отдаёт уже посчитанный набор имён, поэтому побочные эффекты модуля не повторяются.
 */
export class ModuleLoader {
  private cache = new Map<string, Map<string, unknown>>();
  /** Файлы, которые прямо сейчас выполняются — по ним ловится циклический import. */
  private loading: string[] = [];

  load(interp: Interpreter, rawPath: string, fromFile: string, alias: string, span: Span): DbgoModule {
    const full = isAbsolute(rawPath) ? rawPath : resolve(dirname(fromFile), rawPath);
    const shown = shortPath(full, relative(process.cwd(), full));

    const cached = this.cache.get(full);
    if (cached) return new DbgoModule(alias, shown, cached as Map<string, never>);

    const cycleAt = this.loading.indexOf(full);
    if (cycleAt !== -1) {
      const chain = [...this.loading.slice(cycleAt), full].map((p) => shortPath(p, relative(process.cwd(), p)));
      throw runtimeError(`циклический import: ${chain.join(' → ')}`, span);
    }

    let source: string;
    try {
      source = readFileSync(full, 'utf8');
    } catch {
      throw runtimeError(
        `не удалось прочитать модуль «${rawPath}» — искали по пути ${shown}`,
        span,
      );
    }

    // Исходник модуля нужен, чтобы ошибка внутри него показала свою строку, а не чужую.
    registerSource(shown, source);

    this.loading.push(full);
    try {
      const program = parse(tokenize(source, shown), shown);
      const exports = interp.runModule(program, full);
      this.cache.set(full, exports as Map<string, unknown>);
      return new DbgoModule(alias, shown, exports);
    } finally {
      this.loading.pop();
    }
  }
}
