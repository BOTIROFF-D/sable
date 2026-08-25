// Подсветка кода в песочнице настоящим лексером языка.
//
// Отдельный подсветчик неизбежно расходится с языком: добавили ключевое слово —
// он о нём не знает. Здесь размечает тот же `tokenize`, что и интерпретатор,
// поэтому разойтись им негде.

import { SableError } from '../src/errors.ts';
import { tokenize } from '../src/lexer.ts';
import type { TokenType } from '../src/token.ts';

const KEYWORD = new Set<TokenType>([
  'LET', 'CONST', 'FN', 'RETURN', 'IF', 'ELSE', 'WHILE', 'FOR', 'IN',
  'BREAK', 'CONTINUE', 'STRUCT', 'IMPORT', 'AS', 'TRY', 'CATCH',
]);
const LITERAL = new Set<TokenType>(['TRUE', 'FALSE', 'NIL']);

/** Класс подсветки для лексемы; пустая строка — обычный текст. */
function classOf(type: TokenType): string {
  if (KEYWORD.has(type)) return 'k';
  if (LITERAL.has(type)) return 'l';
  if (type === 'NUMBER') return 'n';
  if (type === 'STRING') return 's';
  return '';
}

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Смещение в тексте по строке и колонке из позиции лексемы. */
function offsets(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

/**
 * Размеченный HTML для текста программы. Незакрытая строка или неизвестный
 * символ — обычное дело, пока человек печатает: до места ошибки размечаем,
 * дальше отдаём как есть.
 */
export function highlight(source: string): string {
  const starts = offsets(source);
  const at = (line: number, col: number): number => (starts[line - 1] ?? 0) + col - 1;

  let tokens;
  try {
    tokens = tokenize(source, 'песочница');
  } catch (e) {
    if (e instanceof SableError) return escape(source);
    throw e;
  }

  let out = '';
  let pos = 0;

  for (const token of tokens) {
    if (token.type === 'EOF' || token.type === 'NEWLINE') continue;
    const start = at(token.span.line, token.span.col);
    if (start < pos || start > source.length) continue;

    // Пробелы и комментарии между лексемами лексер выбрасывает — забираем сами.
    const between = source.slice(pos, start);
    out += paintGaps(between);

    // Длину берём по исходнику: у строк lexeme — это «"..."», а не сам текст.
    const end = lengthOf(source, start, token.type);
    const cls = classOf(token.type);
    const text = escape(source.slice(start, end));
    out += cls ? `<span class="${cls}">${text}</span>` : text;
    pos = end;
  }

  return out + paintGaps(source.slice(pos));
}

/**
 * Промежутки между лексемами: пробелы и комментарии. Разбираем сканером,
 * а не регуляркой: блочные комментарии в языке вкладываются друг в друга,
 * и `/* a /* b *\/ *\/` регулярка закрыла бы на первом же `*\/`.
 */
function paintGaps(text: string): string {
  let out = '';
  let plain = 0;
  let i = 0;

  const flush = (upto: number): void => { out += escape(text.slice(plain, upto)); };

  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '/') {
      flush(i);
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += `<span class="c">${escape(text.slice(i, stop))}</span>`;
      i = plain = stop;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      flush(i);
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; continue; }
        if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; continue; }
        j++;
      }
      out += `<span class="c">${escape(text.slice(i, j))}</span>`;
      i = plain = j;
      continue;
    }
    i++;
  }

  flush(text.length);
  return out;
}

/** Где кончается лексема в исходнике. */
function lengthOf(source: string, start: number, type: TokenType): number {
  if (type !== 'STRING') {
    const rest = source.slice(start);
    const m = /^(0[xX][0-9A-Fa-f_]+|[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9]+)?|[A-Za-z_À-ɏЀ-ӿ][A-Za-z0-9_À-ɏЀ-ӿʻʼ]*|\+=|-=|\*=|\/=|==|!=|<=|>=|&&|\|\||\?\?|->|\.\.|.)/.exec(rest);
    return start + (m ? m[0].length : 1);
  }
  // Строка: ищем закрывающую кавычку того же вида, пропуская экранированное.
  const quote = source[start]!;
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return source.length;
}
