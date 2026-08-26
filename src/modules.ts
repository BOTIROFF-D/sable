import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { registerSource, runtimeError, shortPath, type Span } from './errors.ts';
import type { Interpreter } from './interpreter.ts';
import { tokenize } from './lexer.ts';
import { parse } from './parser.ts';
import { SableModule, type Value } from './values.ts';

/**
 * Загрузчик модулей. Каждый файл выполняется ровно один раз: повторный import
 * отдаёт уже посчитанный набор имён, поэтому побочные эффекты модуля не повторяются.
 */
export class ModuleLoader {
  private cache = new Map<string, Map<string, Value>>();
  /** Файлы, которые прямо сейчас выполняются — по ним ловится циклический import. */
  private loading: string[] = [];

  /** Весь модуль одним пространством имён: `import "..." as имя`. */
  load(interp: Interpreter, rawPath: string, fromFile: string, alias: string, span: Span): SableModule {
    const { shown, exports } = this.read(interp, rawPath, fromFile, span);
    return new SableModule(alias, shown, exports);
  }

  /**
   * Только набор имён модуля: выборочному импорту пространство имён не нужно,
   * а вот кэш — тот же самый, иначе файл выполнился бы дважды.
   */
  loadExports(interp: Interpreter, rawPath: string, fromFile: string, span: Span): Map<string, Value> {
    return this.read(interp, rawPath, fromFile, span).exports;
  }

  private read(
    interp: Interpreter, rawPath: string, fromFile: string, span: Span,
  ): { shown: string; exports: Map<string, Value> } {
    const full = isAbsolute(rawPath) ? rawPath : resolve(dirname(fromFile), rawPath);
    const shown = shortPath(full, relative(process.cwd(), full));

    const cached = this.cache.get(full);
    if (cached) return { shown, exports: cached };

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
      this.cache.set(full, exports);
      return { shown, exports };
    } finally {
      this.loading.pop();
    }
  }
}
