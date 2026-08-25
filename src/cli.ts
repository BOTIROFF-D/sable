#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { check } from './checker.ts';
import { DbgoError, formatAt, formatError, formatErrors, registerSource, shortPath } from './errors.ts';
import { Interpreter } from './interpreter.ts';
import { tokenize } from './lexer.ts';
import { parse, parseAll } from './parser.ts';
import { repr, type Value } from './values.ts';

export const LANG = 'dbgo';
export const VERSION = '0.2.0';
export const EXT = '.dbgo';

/** Разбор + выполнение одного исходника. Ошибки уходят наверх как DbgoError. */
export function runSource(source: string, file: string, interp: Interpreter): Value {
  const program = parse(tokenize(source, file), file);
  return interp.runInteractive(program);
}

/** Прочитать файл и разобрать его, ничего не выполняя. */
function loadProgram(path: string): { source: string; file: string; full: string } | number {
  const full = resolve(path);
  let source: string;
  try {
    source = readFileSync(full, 'utf8');
  } catch {
    process.stderr.write(`${LANG}: не удалось открыть файл «${path}»\n`);
    return 66;
  }
  const file = shortPath(full, relative(process.cwd(), full));
  registerSource(file, source);
  return { source, file, full };
}

/**
 * Статическая проверка без запуска.
 *
 * Намеренно отдельной командой, а не частью обычного запуска: проверка судит
 * о программе по одному лишь тексту и может ошибиться там, где программа
 * рабочая (например, имя, до которого дело доходит только внутри try/catch).
 * Ломать из-за этого запуск рабочего кода нельзя.
 */
function checkFile(path: string): number {
  const loaded = loadProgram(path);
  if (typeof loaded === 'number') return loaded;
  const { source, file, full } = loaded;

  let program;
  try {
    const parsed = parseAll(tokenize(source, file), file);
    if (parsed.errors.length > 0) {
      process.stderr.write(formatErrors(parsed.errors, source) + '\n');
      return 65;
    }
    program = parsed.program;
  } catch (e) {
    if (e instanceof DbgoError) {
      process.stderr.write(formatError(e, source) + '\n');
      return 65;
    }
    throw e;
  }

  // Интерпретатор создаётся только ради списка встроенных имён — программа не выполняется.
  const interp = new Interpreter({ write: () => {} }, full);
  const diags = check(program, interp.builtins.ownEntries().keys());

  const errors = diags.filter((d) => d.severity === 'error').length;
  const warnings = diags.length - errors;

  for (const d of diags) {
    const title = d.severity === 'error' ? 'Ошибка' : 'Замечание';
    process.stdout.write(formatAt(title, d.message, d.span, source) + '\n\n');
  }

  if (diags.length === 0) {
    process.stdout.write(`${file}: замечаний нет\n`);
    return 0;
  }
  process.stdout.write(`${file}: ошибок — ${errors}, замечаний — ${warnings}\n`);
  return errors > 0 ? 65 : 0;
}

function runFile(path: string): number {
  const full = resolve(path);
  let source: string;
  try {
    source = readFileSync(full, 'utf8');
  } catch {
    process.stderr.write(`${LANG}: не удалось открыть файл «${path}»\n`);
    return 66;
  }
  const file = shortPath(full, relative(process.cwd(), full));
  registerSource(file, source);

  let program;
  try {
    const parsed = parseAll(tokenize(source, file), file);
    if (parsed.errors.length > 0) {
      process.stderr.write(formatErrors(parsed.errors, source) + '\n');
      return 65;
    }
    program = parsed.program;
  } catch (e) {
    // Лексер до разбора не доходит: сломанный символ или незакрытая строка — одна ошибка.
    if (e instanceof DbgoError) {
      process.stderr.write(formatError(e, source) + '\n');
      return 65;
    }
    throw e;
  }

  const interp = new Interpreter(undefined, full);
  try {
    interp.run(program);
    return 0;
  } catch (e) {
    if (e instanceof DbgoError) {
      process.stderr.write(formatError(e, source) + '\n');
      return 70;
    }
    throw e;
  }
}

/** Незакрытые скобки означают, что пользователь ещё печатает — ждём продолжения. */
function isIncomplete(source: string): boolean {
  try {
    parse(tokenize(source, '<repl>'), '<repl>');
    return false;
  } catch (e) {
    if (!(e instanceof DbgoError)) return false;
    const atEnd = /конец файла|не закрыт|оборвалось/.test(e.message);
    return atEnd;
  }
}

async function repl(): Promise<number> {
  const interp = new Interpreter();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(`${LANG} ${VERSION} — введите выражение, «:помощь» для справки, Ctrl+D для выхода\n`);

  let buffer = '';
  const prompt = () => rl.setPrompt(buffer ? '  ... ' : `${LANG.toLowerCase()}> `);
  prompt();
  rl.prompt();

  for await (const line of rl) {
    const whole = buffer ? buffer + '\n' + line : line;
    const trimmed = whole.trim();

    if (!buffer && (trimmed === ':выход' || trimmed === ':quit' || trimmed === ':q')) break;
    if (!buffer && (trimmed === ':помощь' || trimmed === ':help')) {
      process.stdout.write(HELP_REPL);
      prompt(); rl.prompt(); continue;
    }
    if (trimmed === '') { buffer = ''; prompt(); rl.prompt(); continue; }

    if (isIncomplete(whole)) {
      buffer = whole;
      prompt(); rl.prompt(); continue;
    }

    buffer = '';
    try {
      const value = runSource(whole, '<repl>', interp);
      if (value !== null && value !== undefined) process.stdout.write(repr(value) + '\n');
    } catch (e) {
      if (e instanceof DbgoError) process.stdout.write(formatError(e, whole) + '\n');
      else throw e;
    }
    prompt();
    rl.prompt();
  }

  rl.close();
  process.stdout.write('\n');
  return 0;
}

const HELP_REPL = `
  :помощь   эта справка
  :выход    выйти (или Ctrl+D)

  Незавершённая строка продолжается автоматически — например, после «{».
`;

const HELP_ROWS: Array<[string, string]> = [
  [`dbgo <файл${EXT}>`, 'выполнить файл'],
  ['dbgo', 'интерактивный режим (REPL)'],
  ['dbgo -e "<код>"', 'выполнить строку кода'],
  [`dbgo --check <файл${EXT}>`, 'проверить, не запуская'],
  ['dbgo --version', 'версия'],
  ['dbgo --help', 'эта справка'],
];

// Ширина первой колонки считается по самой длинной строке — тогда справка
// не съедет, если поменять расширение или добавить команду.
const HELP = [
  `${LANG} ${VERSION} — язык программирования`,
  '',
  ...HELP_ROWS.map(([cmd, about]) =>
    `  ${cmd.padEnd(Math.max(...HELP_ROWS.map(([c]) => c.length)) + 3)}${about}`),
  '',
  `  Примеры: examples/*${EXT}   Справочник: docs/LANGUAGE.md`,
  '',
].join('\n');

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.length === 0) return repl();
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(HELP); return 0; }
  if (args[0] === '--version' || args[0] === '-v') { process.stdout.write(`${LANG} ${VERSION}\n`); return 0; }

  if (args[0] === '--check' || args[0] === '-c') {
    const target = args[1];
    if (target === undefined) { process.stderr.write('после --check нужен путь к файлу\n'); return 64; }
    return checkFile(target);
  }

  if (args[0] === '-e') {
    const source = args[1];
    if (source === undefined) { process.stderr.write('после -e нужен код\n'); return 64; }
    const interp = new Interpreter();
    try {
      runSource(source, '<-e>', interp);
      return 0;
    } catch (e) {
      if (e instanceof DbgoError) { process.stderr.write(formatError(e, source) + '\n'); return 70; }
      throw e;
    }
  }

  return runFile(args[0]!);
}

main().then((code) => { process.exitCode = code; });
