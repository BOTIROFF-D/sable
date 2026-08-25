// Рабочий поток песочницы: здесь выполняется, форматируется и проверяется код.
//
// Выполнение вынесено из главного потока намеренно. Программа на Sable вправе
// зациклиться — `while true {}` пишут первым делом, — и в главном потоке это
// повесило бы вкладку намертво. Поток можно оборвать снаружи, вкладка выживает.

import { check } from '../src/checker.ts';
import { SableError, forgetSources, formatAt, formatError, formatErrors, registerSource } from '../src/errors.ts';
import { format } from '../src/format.ts';
import { Interpreter } from '../src/interpreter.ts';
import { tokenize } from '../src/lexer.ts';
import { parseAll } from '../src/parser.ts';

const FILE = 'песочница.sable';

/** Сколько строк вывода принимаем, прежде чем счесть программу бесконечной. */
const MAX_LINES = 5000;

type Request = { kind: 'run' | 'format' | 'check'; source: string };
type Reply = { ok: boolean; text: string; replaceSource?: string };

/** Разбор с сообщением обо всех синтаксических ошибках сразу, как в CLI. */
function parse(source: string) {
  forgetSources();
  registerSource(FILE, source);
  const parsed = parseAll(tokenize(source, FILE), FILE);
  if (parsed.errors.length > 0) {
    return { program: null, text: formatErrors(parsed.errors, source) };
  }
  return { program: parsed.program, text: '' };
}

function run(source: string): Reply {
  let out = '';
  let lines = 0;
  let flooded = false;

  const interp = new Interpreter({
    write: (text) => {
      if (flooded) return;
      lines += (text.match(/\n/g) ?? []).length;
      if (lines > MAX_LINES) {
        flooded = true;
        out += `\n[вывод оборван на ${MAX_LINES} строках — похоже на бесконечный цикл]\n`;
        // Дальше писать бессмысленно: строку всё равно никто не прочитает,
        // а память кончится раньше, чем программа.
        throw new SableError('runtime', `программа напечатала больше ${MAX_LINES} строк`);
      }
      out += text;
    },
  }, `/${FILE}`);

  try {
    const parsed = parse(source);
    if (parsed.program === null) return { ok: false, text: parsed.text };
    interp.run(parsed.program);
    return { ok: true, text: out === '' ? '[программа ничего не напечатала]' : out };
  } catch (e) {
    if (e instanceof SableError) return { ok: false, text: out + formatError(e, source) };
    return { ok: false, text: `${out}\nвнутренняя ошибка: ${(e as Error).message}` };
  }
}

function formatSource(source: string): Reply {
  try {
    return { ok: true, text: 'Отформатировано.', replaceSource: format(source, FILE) };
  } catch (e) {
    if (e instanceof SableError) {
      return { ok: false, text: formatError(e, source) + '\n\nСначала почините синтаксис.' };
    }
    throw e;
  }
}

function checkSource(source: string): Reply {
  const parsed = parse(source);
  if (parsed.program === null) return { ok: false, text: parsed.text };

  // Интерпретатор создаётся только ради списка встроенных имён.
  const names = new Interpreter({ write: () => {} }, `/${FILE}`).builtins.ownEntries().keys();
  const diags = check(parsed.program, names);
  if (diags.length === 0) return { ok: true, text: 'Замечаний нет.' };

  const parts = diags.map((d) =>
    formatAt(d.severity === 'error' ? 'Ошибка' : 'Замечание', d.message, d.span, source));
  const errors = diags.filter((d) => d.severity === 'error').length;
  parts.push(`Ошибок — ${errors}, замечаний — ${diags.length - errors}.`);
  return { ok: errors === 0, text: parts.join('\n\n') };
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { kind, source } = event.data;
  const reply =
    kind === 'run' ? run(source)
    : kind === 'format' ? formatSource(source)
    : checkSource(source);
  (self as unknown as Worker).postMessage(reply);
};
