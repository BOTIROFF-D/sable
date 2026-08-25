#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { check } from './checker.ts';
import { format } from './format.ts';
import { SableError, formatAt, formatError, formatErrors, registerSource, shortPath } from './errors.ts';
import { Interpreter } from './interpreter.ts';
import { tokenize } from './lexer.ts';
import { parse, parseAll } from './parser.ts';
import { repr, type Value } from './values.ts';

export const LANG = 'Sable';
export const VERSION = '0.2.0';
export const EXT = '.sable';

/** Разбор + выполнение одного исходника. Ошибки уходят наверх как SableError. */
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
    if (e instanceof SableError) {
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

/**
 * Форматирование. Три режима: печать в вывод, запись на место (-w) и проверка (-c),
 * последняя нужна в сборке — она ничего не меняет, но краснеет на неотформатированном.
 */
function formatFiles(args: string[]): number {
  const write = args.includes('-w') || args.includes('--write');
  const verify = args.includes('-c') || args.includes('--check');
  const paths = args.filter((a) => !a.startsWith('-'));

  if (paths.length === 0) {
    process.stderr.write(`после «fmt» нужен путь к файлу${EXT}\n`);
    return 64;
  }
  if (write && verify) {
    process.stderr.write('«-w» и «-c» вместе не имеют смысла: одно пишет, другое только проверяет\n');
    return 64;
  }

  let changed = 0;
  for (const path of paths) {
    const loaded = loadProgram(path);
    if (typeof loaded === 'number') return loaded;
    const { source, file, full } = loaded;

    let result: string;
    try {
      result = format(source, file);
    } catch (e) {
      if (e instanceof SableError) {
        process.stderr.write(formatError(e, source) + '\n');
        process.stderr.write(`${file}: не отформатирован — сначала почините синтаксис\n`);
        return 65;
      }
      throw e;
    }

    if (verify) {
      if (result !== source) {
        changed++;
        process.stdout.write(`${file}: не отформатирован\n`);
      }
      continue;
    }
    if (write) {
      if (result !== source) {
        writeFileSync(full, result, 'utf8');
        changed++;
        process.stdout.write(`${file}: отформатирован\n`);
      }
      continue;
    }
    process.stdout.write(result);
  }

  if (verify) {
    if (changed === 0) process.stdout.write(`отформатировано: все ${paths.length}\n`);
    return changed === 0 ? 0 : 1;
  }
  if (write && changed === 0) process.stdout.write('всё уже отформатировано\n');
  return 0;
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
    if (e instanceof SableError) {
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
    if (e instanceof SableError) {
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
    if (!(e instanceof SableError)) return false;
    const atEnd = /конец файла|не закрыт|оборвалось/.test(e.message);
    return atEnd;
  }
}

const HISTORY_FILE = join(homedir(), '.sable_history');
const HISTORY_LIMIT = 500;

/**
 * История между запусками: без неё интерактивный режим забывает всё при выходе.
 * Файл хранится в порядке ввода, readline ждёт обратный — новыми записями вперёд.
 *
 * Что набрано за сессию, считается здесь самостоятельно: readline наполняет свою
 * историю только в терминале, и при перенаправлении ввода она осталась бы пустой.
 */
function loadHistory(): string[] {
  try {
    return readFileSync(HISTORY_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

function saveHistory(older: string[], typed: string[]): void {
  const all: string[] = [];
  for (const line of [...older, ...typed]) {
    // Подряд идущие повторы засоряют историю и мешают листать.
    if (all[all.length - 1] !== line) all.push(line);
  }
  try {
    writeFileSync(HISTORY_FILE, all.slice(-HISTORY_LIMIT).join('\n') + '\n', 'utf8');
  } catch {
    // Нет доступа к домашней папке — не повод ронять сессию.
  }
}

/** Дополнение по Tab: встроенные имена, объявленные имена и команды режима. */
function makeCompleter(interp: Interpreter, commands: string[]) {
  return (line: string): [string[], string] => {
    const match = /[A-Za-z_À-ɏЀ-ӿ][A-Za-z_0-9À-ɏЀ-ӿ\u02BB\u02BC]*$|:[а-яa-z]*$/.exec(line);
    const prefix = match ? match[0] : '';
    const names = [
      ...interp.builtins.ownEntries().keys(),
      ...interp.globals.ownEntries().keys(),
      ...commands,
    ];
    const hits = names.filter((n) => n.startsWith(prefix)).sort();
    return [hits.length ? hits : prefix ? [] : names.sort(), prefix];
  };
}

const REPL_COMMANDS = [':помощь', ':имена', ':время', ':очистить', ':выход'];

async function repl(): Promise<number> {
  const interp = new Interpreter();
  const older = loadHistory();
  const typed: string[] = [];
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    history: [...older].reverse(),
    historySize: HISTORY_LIMIT,
    completer: makeCompleter(interp, REPL_COMMANDS),
  });

  process.stdout.write(
    `${LANG} ${VERSION} — введите выражение, «:помощь» для справки, Ctrl+D для выхода\n`,
  );

  let buffer = '';
  const prompt = () => {
    rl.setPrompt(buffer ? '  ... ' : `${LANG.toLowerCase()}> `);
    rl.prompt();
  };
  prompt();

  /** Выполнить и напечатать результат; ошибка не роняет сессию. */
  const evaluate = (code: string, showTime: boolean): void => {
    const started = performance.now();
    try {
      const value = runSource(code, '<repl>', interp);
      if (value !== null && value !== undefined) process.stdout.write(repr(value) + '\n');
      if (showTime) process.stdout.write(`  за ${(performance.now() - started).toFixed(3)} мс\n`);
    } catch (e) {
      if (e instanceof SableError) process.stdout.write(formatError(e, code) + '\n');
      else throw e;
    }
  };

  for await (const line of rl) {
    if (line.trim() !== '') typed.push(line);
    const whole = buffer ? buffer + '\n' + line : line;
    const trimmed = whole.trim();

    if (!buffer && trimmed.startsWith(':')) {
      const [cmd] = trimmed.split(/\s+/);
      const arg = trimmed.slice(cmd!.length).trim();

      // Команды без аргументов не гадают, что значит хвост: «:выход и хвост» —
      // скорее опечатка, чем просьба выйти, и молча выходить из-за неё нельзя.
      const noArgs = [':выход', ':quit', ':q', ':помощь', ':help', ':очистить', ':имена'];
      if (noArgs.includes(cmd!) && arg !== '') {
        process.stdout.write(`  у команды «${cmd}» нет аргументов, а после неё стоит «${arg}»\n`);
        buffer = '';
        prompt();
        continue;
      }

      if (cmd === ':выход' || cmd === ':quit' || cmd === ':q') break;

      if (cmd === ':помощь' || cmd === ':help') {
        process.stdout.write(HELP_REPL);
      } else if (cmd === ':очистить') {
        process.stdout.write('\x1b[2J\x1b[H');
      } else if (cmd === ':имена') {
        const own = [...interp.globals.ownEntries().keys()].sort();
        process.stdout.write(
          own.length
            ? `  объявлено: ${own.join(', ')}\n`
            : '  пока ничего не объявлено; встроенные имена дополняются по Tab\n',
        );
      } else if (cmd === ':время') {
        if (arg === '') process.stdout.write('  после «:время» нужно выражение\n');
        else evaluate(arg, true);
      } else {
        process.stdout.write(`  неизвестная команда «${cmd}»; список — «:помощь»\n`);
      }

      buffer = '';
      prompt();
      continue;
    }

    if (trimmed === '') { buffer = ''; prompt(); continue; }

    if (isIncomplete(whole)) {
      buffer = whole;
      prompt();
      continue;
    }

    buffer = '';
    evaluate(whole, false);
    prompt();
  }

  saveHistory(older, typed);
  rl.close();
  process.stdout.write('\n');
  return 0;
}

const HELP_REPL = `
  :помощь              эта справка
  :имена               что объявлено в этой сессии
  :время <выражение>   выполнить и показать, сколько заняло
  :очистить            очистить экран
  :выход               выйти (или Ctrl+D)

  Tab                  дополнить имя
  ↑ / ↓                история; она сохраняется между запусками
                       в ~/.sable_history

  Незавершённая строка продолжается автоматически — например, после «{».
`;

const HELP_ROWS: Array<[string, string]> = [
  [`sable <файл${EXT}>`, 'выполнить файл'],
  ['sable', 'интерактивный режим (REPL)'],
  ['sable -e "<код>"', 'выполнить строку кода'],
  [`sable --check <файл${EXT}>`, 'проверить, не запуская'],
  [`sable fmt <файл${EXT}>`, 'привести к каноническому виду'],
  ['sable fmt -w <файлы>', 'то же, записав на место'],
  ['sable fmt -c <файлы>', 'только проверить оформление (для сборки)'],
  ['sable --version', 'версия'],
  ['sable --help', 'эта справка'],
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

  if (args[0] === 'fmt') return formatFiles(args.slice(1));

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
      if (e instanceof SableError) { process.stderr.write(formatError(e, source) + '\n'); return 70; }
      throw e;
    }
  }

  return runFile(args[0]!);
}

main().then((code) => { process.exitCode = code; });
