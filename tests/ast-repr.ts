// Каноническая текстовая запись AST — общий язык для двух парсеров.
//
// Этот же формат печатает парсер, написанный на самом Sable, и записи
// сравниваются посимвольно. Отсюда все ограничения: ни одной вольности,
// ни одного «для красоты» пробела, никакого JSON.stringify (он экранирует
// не так, как умеет Sable). Позиции не печатаются никогда: два парсера
// вправе расходиться в колонках, но не в форме дерева.
//
// Отладка: node tests/ast-repr.ts путь/к/файлу.sable
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Expr, Param, Program, Stmt } from '../src/ast.ts';
import { SableError, formatError, registerSource } from '../src/errors.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';

/**
 * Экранирование строкового атома. Порядок замен важен: обратная косая идёт
 * первой, иначе она удвоила бы косые, которые сама же и вставила.
 */
function quote(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/**
 * Сборщик строк. Уровень вложенности хранится снаружи узла, а не передаётся
 * в каждую функцию: обход остаётся плоским, а отступ невозможно потерять
 * на одной забытой рекурсивной ветке.
 */
class Out {
  private readonly lines: string[] = [];
  private depth = 0;

  /** Голова со своими атомами; атомы уже подготовлены вызывающим. */
  line(head: string, ...atoms: string[]): void {
    this.lines.push('  '.repeat(this.depth) + [head, ...atoms].join(' '));
  }

  /** Дети узла — ровно на один уровень глубже. */
  nest(body: () => void): void {
    this.depth++;
    body();
    this.depth--;
  }

  /** Узел с детьми одним вызовом — самая частая форма. */
  node(head: string, atoms: string[], body: () => void): void {
    this.line(head, ...atoms);
    this.nest(body);
  }

  text(): string {
    return this.lines.join('\n');
  }
}

/** Параметр функции и поле структуры пишутся одинаково — отсюда общая функция. */
function reprParam(out: Out, p: Param): void {
  out.node('Param', [p.name], () => {
    if (p.def !== null) reprExpr(out, p.def);
  });
}

function reprParams(out: Out, params: Param[]): void {
  out.node('Params', [], () => {
    for (const p of params) reprParam(out, p);
  });
}

function reprBody(out: Out, body: Stmt[]): void {
  out.node('Body', [], () => {
    for (const s of body) reprStmt(out, s);
  });
}

function reprExpr(out: Out, e: Expr): void {
  switch (e.kind) {
    case 'Number':
      out.line('Number', String(e.value));
      return;
    case 'Str':
      out.line('Str', quote(e.value));
      return;
    case 'Template':
      out.node('Template', [], () => {
        for (const part of e.parts) {
          if ('text' in part) out.line('Text', quote(part.text));
          else reprExpr(out, part.expr);
        }
      });
      return;
    case 'Bool':
      out.line('Bool', e.value ? 'true' : 'false');
      return;
    case 'Nil':
      out.line('Nil');
      return;
    case 'List':
      out.node('List', [], () => {
        for (const item of e.items) reprExpr(out, item);
      });
      return;
    case 'Map':
      out.node('Map', [], () => {
        for (const entry of e.entries) {
          out.node('Entry', [], () => {
            reprExpr(out, entry.key);
            reprExpr(out, entry.value);
          });
        }
      });
      return;
    case 'Ident':
      out.line('Ident', e.name);
      return;
    case 'Unary':
      out.node('Unary', [e.op], () => reprExpr(out, e.right));
      return;
    case 'Binary':
      out.node('Binary', [e.op], () => {
        reprExpr(out, e.left);
        reprExpr(out, e.right);
      });
      return;
    case 'Logical':
      out.node('Logical', [e.op], () => {
        reprExpr(out, e.left);
        reprExpr(out, e.right);
      });
      return;
    case 'Ternary':
      out.node('Ternary', [], () => {
        reprExpr(out, e.cond);
        reprExpr(out, e.then);
        reprExpr(out, e.else);
      });
      return;
    case 'Range':
      out.node('Range', [], () => {
        reprExpr(out, e.start);
        reprExpr(out, e.end);
      });
      return;
    case 'Call':
      out.node('Call', [], () => {
        reprExpr(out, e.callee);
        for (const arg of e.args) reprExpr(out, arg);
      });
      return;
    case 'Get':
      out.node('Get', [e.name], () => reprExpr(out, e.object));
      return;
    case 'Index':
      out.node('Index', [], () => {
        reprExpr(out, e.object);
        reprExpr(out, e.index);
      });
      return;
    case 'Assign':
      // Простое присваивание и составное различаются одним атомом,
      // поэтому у обычного `=` тоже есть свой знак — пустого атома не бывает.
      out.node('Assign', [e.op === null ? '=' : e.op], () => {
        reprExpr(out, e.target);
        reprExpr(out, e.value);
      });
      return;
    case 'Fn':
      out.node('Fn', [e.name === null ? '-' : e.name], () => {
        reprParams(out, e.params);
        reprBody(out, e.body);
      });
      return;
    default: {
      // Новый вид выражения в src/ast.ts обязан упасть здесь на этапе типизации,
      // а не тихо исчезнуть из записи и разойтись с парсером на Sable.
      const never: never = e;
      throw new Error(`неизвестное выражение: ${JSON.stringify(never)}`);
    }
  }
}

function reprStmt(out: Out, s: Stmt): void {
  switch (s.kind) {
    case 'VarDecl':
      out.node('VarDecl', [s.mutable ? 'let' : 'const', s.name], () => reprExpr(out, s.init));
      return;
    case 'FnDecl':
      out.node('FnDecl', [s.name], () => {
        reprParams(out, s.params);
        reprBody(out, s.body);
      });
      return;
    case 'StructDecl':
      out.node('StructDecl', [s.name], () => {
        // Обе обёртки печатаются всегда: пустой список полей и отсутствие
        // полей — одно и то же, а вот съехавший порядок детей — уже расхождение.
        out.node('Fields', [], () => {
          for (const f of s.fields) reprParam(out, f);
        });
        out.node('Methods', [], () => {
          for (const m of s.methods) {
            out.node('Method', [m.name], () => {
              reprParams(out, m.params);
              reprBody(out, m.body);
            });
          }
        });
      });
      return;
    case 'Import':
      out.node('Import', [quote(s.path)], () => {
        if (s.names === null) out.line('Alias', s.alias);
        else {
          out.node('Names', [], () => {
            // Псевдоним пишется и тогда, когда совпадает с именем: иначе
            // число атомов зависело бы от текста, а сравнение — от догадки.
            for (const n of s.names) out.line('Name', n.name, n.alias);
          });
        }
      });
      return;
    case 'ExprStmt':
      out.node('ExprStmt', [], () => reprExpr(out, s.expr));
      return;
    case 'Block':
      out.node('Block', [], () => {
        for (const inner of s.body) reprStmt(out, inner);
      });
      return;
    case 'If':
      out.node('If', [], () => {
        reprExpr(out, s.cond);
        reprStmt(out, s.then);
        if (s.else !== null) reprStmt(out, s.else);
      });
      return;
    case 'While':
      out.node('While', [], () => {
        reprExpr(out, s.cond);
        reprStmt(out, s.body);
      });
      return;
    case 'For':
      out.node('For', [s.name], () => {
        reprExpr(out, s.iterable);
        reprStmt(out, s.body);
      });
      return;
    case 'Try':
      out.node('Try', [], () => {
        reprBody(out, s.body);
        // `catch {}` и отсутствие catch различаются наличием самой обёртки,
        // а не числом детей — так же, как они различаются в дереве.
        if (s.handler !== null) {
          const handler = s.handler;
          out.node('Catch', [s.param === null ? '-' : s.param], () => {
            for (const inner of handler) reprStmt(out, inner);
          });
        }
        if (s.finalizer !== null) {
          const finalizer = s.finalizer;
          out.node('Finally', [], () => {
            for (const inner of finalizer) reprStmt(out, inner);
          });
        }
      });
      return;
    case 'Return':
      out.node('Return', [], () => {
        if (s.value !== null) reprExpr(out, s.value);
      });
      return;
    case 'Break':
      out.line('Break');
      return;
    case 'Continue':
      out.line('Continue');
      return;
    default: {
      // См. выше: исчерпывающий разбор держится на этой проверке.
      const never: never = s;
      throw new Error(`неизвестная инструкция: ${JSON.stringify(never)}`);
    }
  }
}

/** Запись всей программы. Без завершающего перевода строки — его добавляет вызывающий. */
export function reprProgram(program: Program): string {
  const out = new Out();
  out.node('Program', [], () => {
    for (const s of program) reprStmt(out, s);
  });
  return out.text();
}

// Файл прежде всего библиотека для тестов, поэтому печать по аргументу
// включается только при прямом запуске, а не при импорте.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (file === undefined) {
    process.stderr.write('Использование: node tests/ast-repr.ts путь/к/файлу.sable\n');
    process.exitCode = 2;
  } else {
    const path = resolve(file);
    const source = readFileSync(path, 'utf8');
    registerSource(path, source);
    try {
      process.stdout.write(reprProgram(parse(tokenize(source, path), path)) + '\n');
    } catch (e) {
      if (!(e instanceof SableError)) throw e;
      process.stderr.write(formatError(e, source) + '\n');
      process.exitCode = 1;
    }
  }
}
