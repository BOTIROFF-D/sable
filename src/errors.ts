// Единая система ошибок dbgo: и лексер, и парсер, и рантайм говорят одинаково.
// Каждая ошибка знает точку в исходнике и умеет напечатать себя со стрелкой.

export type Span = { line: number; col: number; file: string };

export class DbgoError extends Error {
  stage: 'lex' | 'parse' | 'runtime';
  span: Span | null;
  /** Стек вызовов на момент ошибки — только для runtime. */
  trace: Array<{ name: string; span: Span }>;
  /** Значение, брошенное через error(...) / throw. */
  payload: unknown;

  constructor(
    stage: 'lex' | 'parse' | 'runtime',
    message: string,
    span: Span | null = null,
    trace: Array<{ name: string; span: Span }> = [],
    payload: unknown = undefined,
  ) {
    super(message);
    this.name = 'DbgoError';
    this.stage = stage;
    this.span = span;
    this.trace = trace;
    this.payload = payload;
  }
}

export const lexError = (m: string, s: Span) => new DbgoError('lex', m, s);
export const parseError = (m: string, s: Span) => new DbgoError('parse', m, s);
export const runtimeError = (m: string, s: Span | null = null) => new DbgoError('runtime', m, s);

const STAGE_TITLE: Record<string, string> = {
  lex: 'Ошибка разбора символов',
  parse: 'Ошибка синтаксиса',
  runtime: 'Ошибка выполнения',
};

/**
 * Отчёт об ошибке для терминала: заголовок, путь, строка исходника и каретка.
 * Ширина колонки номеров считается от самого большого номера, чтобы не съезжало.
 */
export function formatError(err: DbgoError, source: string): string {
  const title = STAGE_TITLE[err.stage] ?? 'Ошибка';
  const out: string[] = [`${title}: ${err.message}`];

  if (err.span) {
    const { line, col, file } = err.span;
    out.push(`  --> ${file}:${line}:${col}`);
    const lines = source.split('\n');
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
  }

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

  return out.join('\n');
}
