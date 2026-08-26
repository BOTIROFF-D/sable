// Единая система ошибок sable: и лексер, и парсер, и рантайм говорят одинаково.
// Каждая ошибка знает точку в исходнике и умеет напечатать себя со стрелкой.

export type Span = { line: number; col: number; file: string };

export class SableError extends Error {
  stage: 'lex' | 'parse' | 'runtime';
  span: Span | null;
  /** Стек вызовов на момент ошибки — только для runtime. */
  trace: Array<{ name: string; span: Span }>;
  /** Значение, брошенное через error(...) / throw. */
  payload: unknown;
  /** Сколько кадров не поместилось в trace: показывать «× 12» как число повторов — вранье. */
  dropped = 0;

  constructor(
    stage: 'lex' | 'parse' | 'runtime',
    message: string,
    span: Span | null = null,
    trace: Array<{ name: string; span: Span }> = [],
    payload: unknown = undefined,
  ) {
    super(message);
    this.name = 'SableError';
    this.stage = stage;
    this.span = span;
    this.trace = trace;
    this.payload = payload;
  }
}

export const lexError = (m: string, s: Span) => new SableError('lex', m, s);
export const parseError = (m: string, s: Span) => new SableError('parse', m, s);
export const runtimeError = (m: string, s: Span | null = null) => new SableError('runtime', m, s);

/**
 * Исходники всех файлов, которые успели попасть в программу.
 * Нужны, чтобы ошибка внутри подключённого модуля показывала СВОЮ строку,
 * а не строку с тем же номером из главного файла.
 */
const SOURCES = new Map<string, string>();

/**
 * Как показать путь пользователю: относительный, если файл внутри рабочей папки,
 * иначе абсолютный — «../../../tmp/...» читать невозможно.
 */
export function shortPath(full: string, rel: string): string {
  if (rel === '' || rel.startsWith('..')) return full;
  return rel;
}

export function registerSource(file: string, text: string): void {
  SOURCES.set(file, text);
}

export function forgetSources(): void {
  SOURCES.clear();
}

const STAGE_TITLE: Record<string, string> = {
  lex: 'Ошибка разбора символов',
  parse: 'Ошибка синтаксиса',
  runtime: 'Ошибка выполнения',
};

/**
 * Заголовок, путь, строка исходника и каретка под виновником.
 * Общий вид для ошибок и для замечаний статической проверки.
 */
export function formatAt(title: string, message: string, span: Span | null, source: string): string {
  const out: string[] = [`${title}: ${message}`];
  if (!span) return out.join('\n');

  const { line, col, file } = span;
  out.push(`  --> ${file}:${line}:${col}`);
  const lines = (SOURCES.get(file) ?? source).split('\n');
  const gutter = String(line).length;
  const pad = ' '.repeat(gutter);
  const src = lines[line - 1];
  if (src !== undefined) {
    out.push(`${pad} |`);
    out.push(`${String(line).padStart(gutter)} | ${src.replace(/\t/g, '    ')}`);
    // Табы в исходнике развёрнуты в 4 пробела — каретку двигаем на столько же.
    const prefix = src.slice(0, Math.max(0, col - 1)).replace(/\t/g, '    ');
    out.push(`${pad} | ${' '.repeat(prefix.length)}^`);
  }
  return out.join('\n');
}

/**
 * Список синтаксических ошибок одним текстом. Одна ошибка печатается ровно так же,
 * как печаталась бы поодиночке, — чтобы вывод не зависел от того, сколько их нашлось.
 * Показывается не больше `limit`: дальше идут ошибки-последствия, а не причины.
 */
export function formatErrors(errors: SableError[], source: string, limit = 10): string {
  const shown = errors.slice(0, limit);
  const parts = shown.map((e) => formatError(e, source));
  if (errors.length > shown.length) {
    parts.push(`… и ещё ${errors.length - shown.length}; остальные видны после починки этих`);
  } else if (errors.length > 1) {
    parts.push(`Синтаксических ошибок: ${errors.length}`);
  }
  return parts.join('\n\n');
}

/**
 * Отчёт об ошибке для терминала: то же плюс стек вызовов.
 */
export function formatError(err: SableError, source: string): string {
  const out = [formatAt(STAGE_TITLE[err.stage] ?? 'Ошибка', err.message, err.span, source)];
  // Повторы одного кадра (рекурсия) схлопываются — иначе трейс превращается в стену.
  for (let i = 0; i < err.trace.length; ) {
    const frame = err.trace[i]!;
    let count = 1;
    while (
      i + count < err.trace.length &&
      err.trace[i + count]!.name === frame.name &&
      err.trace[i + count]!.span.line === frame.span.line &&
      err.trace[i + count]!.span.col === frame.span.col
    ) count++;
    const where = `${frame.span.file}:${frame.span.line}:${frame.span.col}`;
    out.push(count > 1 ? `  в ${frame.name} (${where}) × ${count}` : `  в ${frame.name} (${where})`);
    i += count;
  }
  // Кадров может быть больше, чем мы сохранили. Молчать об этом нельзя:
  // «× 12» тогда читается как число повторов, а это всего лишь потолок.
  if (err.dropped > 0) out.push(`  … и ещё ${err.dropped} кадров глубже`);

  return out.join('\n');
}
