#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DbgoError, formatError, registerSource, shortPath } from './errors.ts';
import { Interpreter } from './interpreter.ts';
import { tokenize } from './lexer.ts';
import { parse } from './parser.ts';
import { repr, type Value } from './values.ts';

export const LANG = 'dbgo';
export const VERSION = '0.1.0';
export const EXT = '.dbgo';

/** Разбор + выполнение одного исходника. Ошибки уходят наверх как DbgoError. */
export function runSource(source: string, file: string, interp: Interpreter): Value {
  const program = parse(tokenize(source, file), file);
  return interp.runInteractive(program);
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
  const interp = new Interpreter(undefined, full);
  try {
    runSource(source, file, interp);
    return 0;
  } catch (e) {
    if (e instanceof DbgoError) {
      process.stderr.write(formatError(e, source) + '\n');
      return e.stage === 'runtime' ? 70 : 65;
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

const HELP = `${LANG} ${VERSION} — язык программирования

  dbgo <файл${EXT}>    выполнить файл
  dbgo               интерактивный режим (REPL)
  dbgo -e "<код>"    выполнить строку кода
  dbgo --version     версия
  dbgo --help        эта справка

  Примеры: examples/*${EXT}   Справочник: docs/LANGUAGE.md
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.length === 0) return repl();
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(HELP); return 0; }
  if (args[0] === '--version' || args[0] === '-v') { process.stdout.write(`${LANG} ${VERSION}\n`); return 0; }

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
