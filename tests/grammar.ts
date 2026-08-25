// Проверка грамматики подсветки: она обязана знать те же слова, что и сам язык.
//
// Подсветка устаревает молча: добавили ключевое слово — оно просто перестаёт
// подсвечиваться, и никто этого не замечает годами. Здесь список слов в
// грамматике сверяется с настоящим списком из token.ts и из интерпретатора.
//
// Запуск: node tests/grammar.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interpreter } from '../src/interpreter.ts';
import { KEYWORDS } from '../src/token.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRAMMAR = join(ROOT, 'editors', 'vscode', 'syntaxes', 'sable.tmLanguage.json');

type Rule = { match?: string; begin?: string; end?: string; name?: string; patterns?: Rule[] };
type Grammar = { scopeName: string; patterns: Rule[]; repository: Record<string, Rule & { patterns?: Rule[] }> };

const problems: string[] = [];
const ok = (what: string) => process.stdout.write(`  ✓ ${what}\n`);
const fail = (what: string, why: string) => {
  process.stdout.write(`  ✗ ${what}\n`);
  problems.push(`${what}: ${why}`);
};

const grammar = JSON.parse(readFileSync(GRAMMAR, 'utf8')) as Grammar;

// ---- 1. все выражения компилируются ---------------------------------------

const walk = (rules: Rule[] | undefined, path: string): void => {
  for (const [i, rule] of (rules ?? []).entries()) {
    for (const field of ['match', 'begin', 'end'] as const) {
      const src = rule[field];
      if (src === undefined) continue;
      try {
        // Oniguruma в VS Code богаче JS, но опечатки и незакрытые скобки ловятся и так.
        // Единственное расхождение, которое приходится сглаживать: имя письменности
        // Oniguruma пишет как \p{Cyrillic}, а JS требует \p{Script=Cyrillic}.
        const forJs = src.replace(/\\p\{(Cyrillic|Latin|Greek)\}/g, '\\p{Script=$1}');
        new RegExp(forJs, forJs.includes('\\p{') ? 'u' : '');
      } catch (e) {
        fail(`${path}[${i}].${field}`, `не компилируется: ${(e as Error).message}`);
      }
    }
    walk(rule.patterns, `${path}[${i}].patterns`);
  }
};

walk(grammar.patterns, 'patterns');
for (const [name, rule] of Object.entries(grammar.repository)) {
  walk(rule.patterns ?? [rule], `repository.${name}`);
}
if (problems.length === 0) ok('все регулярные выражения грамматики компилируются');

// ---- 2. ключевые слова языка присутствуют ---------------------------------

const grammarText = readFileSync(GRAMMAR, 'utf8');
const missingKeywords = Object.keys(KEYWORDS).filter((kw) => {
  // Слово должно встретиться внутри какого-нибудь перечисления через «|».
  return !new RegExp(`[(|]${kw}[)|]`).test(grammarText);
});
if (missingKeywords.length === 0) ok(`все ${Object.keys(KEYWORDS).length} ключевых слов есть в грамматике`);
else fail('ключевые слова', `нет в грамматике: ${missingKeywords.join(', ')}`);

// ---- 3. встроенные функции присутствуют -----------------------------------

const builtins = [...new Interpreter({ write: () => {} }).builtins.ownEntries().keys()];
const missingBuiltins = builtins.filter((name) => !new RegExp(`[(|]${name}[)|]`).test(grammarText));
if (missingBuiltins.length === 0) ok(`все ${builtins.length} встроенных функций есть в грамматике`);
else fail('встроенные функции', `нет в грамматике: ${missingBuiltins.join(', ')}`);

// ---- 4. в грамматике нет выдуманных имён ----------------------------------

const listed = /"\\\\b\((print\|[^)]+)\)\\\\s\*\(\?=\\\\\(\)"/.exec(grammarText);
const declared = listed ? listed[1]!.split('|') : [];
const invented = declared.filter((n) => !builtins.includes(n));
if (declared.length === 0) fail('список встроенных', 'не найден в грамматике — проверка не сработала');
else if (invented.length === 0) ok('в грамматике нет несуществующих встроенных имён');
else fail('лишние имена', `подсвечиваются как встроенные, но их нет в языке: ${invented.join(', ')}`);

process.stdout.write(`\n${problems.length === 0 ? 'грамматика согласована с языком' : 'расхождений: ' + problems.length}\n`);
if (problems.length) {
  process.stdout.write('\n' + problems.join('\n') + '\n');
  process.exitCode = 1;
}
