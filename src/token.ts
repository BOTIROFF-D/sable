import type { Span } from './errors.ts';

export type TokenType =
  // литералы и имена
  | 'NUMBER' | 'STRING' | 'IDENT'
  // ключевые слова
  | 'LET' | 'CONST' | 'FN' | 'RETURN' | 'IF' | 'ELSE' | 'WHILE' | 'FOR' | 'IN'
  | 'BREAK' | 'CONTINUE' | 'TRUE' | 'FALSE' | 'NIL' | 'STRUCT' | 'IMPORT' | 'AS'
  | 'TRY' | 'CATCH' | 'FINALLY'
  // пунктуация
  | 'LPAREN' | 'RPAREN' | 'LBRACKET' | 'RBRACKET' | 'LBRACE' | 'RBRACE'
  | 'COMMA' | 'DOT' | 'COLON' | 'SEMI' | 'RANGE' | 'ARROW'
  // операторы
  | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH' | 'PERCENT' | 'CARET'
  | 'ASSIGN' | 'PLUS_ASSIGN' | 'MINUS_ASSIGN' | 'STAR_ASSIGN' | 'SLASH_ASSIGN'
  | 'EQ' | 'NEQ' | 'LT' | 'LTE' | 'GT' | 'GTE'
  | 'AND' | 'OR' | 'BANG' | 'QQ' | 'QUESTION'
  // служебные
  | 'NEWLINE' | 'EOF';

/** Кусок строкового литерала: либо текст, либо исходник выражения из `${...}`. */
export type StringPart =
  | { kind: 'text'; text: string }
  | { kind: 'expr'; source: string; span: Span };

export type Token = {
  type: TokenType;
  /** Исходная запись лексемы — для сообщений об ошибках. */
  lexeme: string;
  span: Span;
  /** Разобранное значение числа или строки. */
  value?: number | string;
  /** Части строки с интерполяцией; отсутствуют у обычных строк. */
  parts?: StringPart[];
};

export const KEYWORDS: Record<string, TokenType> = {
  let: 'LET', const: 'CONST', fn: 'FN', return: 'RETURN',
  if: 'IF', else: 'ELSE', while: 'WHILE', for: 'FOR', in: 'IN',
  break: 'BREAK', continue: 'CONTINUE',
  true: 'TRUE', false: 'FALSE', nil: 'NIL',
  struct: 'STRUCT', import: 'IMPORT', as: 'AS',
  try: 'TRY', catch: 'CATCH', finally: 'FINALLY',
  // словесные синонимы логических операторов
  and: 'AND', or: 'OR', not: 'BANG',
};

/** Типы, после которых перевод строки завершает инструкцию (правило как в Go). */
export const ENDS_STATEMENT = new Set<TokenType>([
  'NUMBER', 'STRING', 'IDENT', 'TRUE', 'FALSE', 'NIL',
  'RPAREN', 'RBRACKET', 'RBRACE',
  'RETURN', 'BREAK', 'CONTINUE',
]);
