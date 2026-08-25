import type { Expr, Param, Program, Stmt } from './ast.ts';
import { parseError, type Span } from './errors.ts';
import { Lexer } from './lexer.ts';
import type { Token, TokenType } from './token.ts';

/** Человеческие имена лексем — попадают прямо в текст ошибки. */
const NAMES: Partial<Record<TokenType, string>> = {
  NEWLINE: 'конец строки', EOF: 'конец файла',
  LPAREN: '«(»', RPAREN: '«)»', LBRACKET: '«[»', RBRACKET: '«]»',
  LBRACE: '«{»', RBRACE: '«}»', COMMA: '«,»', COLON: '«:»',
  IDENT: 'имя', NUMBER: 'число', STRING: 'строка', ASSIGN: '«=»', IN: '«in»',
};
const describe = (t: Token): string =>
  NAMES[t.type] ?? (t.lexeme ? `«${t.lexeme}»` : t.type);

export class Parser {
  private tokens: Token[];
  private pos = 0;
  private file: string;
  /** Пока > 0, «{» после выражения читается как блок, а не как словарь. */
  private noMapLiteral = 0;

  constructor(tokens: Token[], file = '<input>') {
    this.tokens = tokens;
    this.file = file;
  }

  // ---- работа с потоком лексем -------------------------------------------

  private peek(off = 0): Token {
    return this.tokens[Math.min(this.pos + off, this.tokens.length - 1)]!;
  }
  private prev(): Token {
    return this.tokens[Math.max(0, this.pos - 1)]!;
  }
  private atEnd(): boolean {
    return this.peek().type === 'EOF';
  }
  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }
  private advance(): Token {
    if (!this.atEnd()) this.pos++;
    return this.prev();
  }
  private match(...types: TokenType[]): boolean {
    if (types.some((t) => this.check(t))) {
      this.advance();
      return true;
    }
    return false;
  }
  private expect(type: TokenType, what: string): Token {
    if (this.check(type)) return this.advance();
    throw parseError(`ожидалось ${what}, а встретилось ${describe(this.peek())}`, this.peek().span);
  }
  private skipSeparators(): void {
    while (this.check('NEWLINE') || this.check('SEMI')) this.advance();
  }
  private endStatement(): void {
    if (this.match('NEWLINE', 'SEMI')) { this.skipSeparators(); return; }
    if (this.check('RBRACE') || this.atEnd()) return;
    throw parseError(
      `после инструкции ожидался перенос строки или «;», а встретилось ${describe(this.peek())}`,
      this.peek().span,
    );
  }

  // ---- программа ----------------------------------------------------------

  parse(): Program {
    const stmts: Stmt[] = [];
    this.skipSeparators();
    while (!this.atEnd()) {
      stmts.push(this.declaration());
      this.skipSeparators();
    }
    return stmts;
  }

  /** Разбор одного выражения — для вставок `${...}` в строках. */
  parseSingleExpr(): Expr {
    this.skipSeparators();
    const e = this.expression();
    this.skipSeparators();
    if (!this.atEnd()) {
      throw parseError(`лишнее ${describe(this.peek())} внутри вставки \${...}`, this.peek().span);
    }
    return e;
  }

  private declaration(): Stmt {
    if (this.check('LET') || this.check('CONST')) return this.varDecl();
    if (this.check('FN') && this.peek(1).type === 'IDENT') return this.fnDecl();
    if (this.check('STRUCT')) return this.structDecl();
    return this.statement();
  }

  private varDecl(): Stmt {
    const kw = this.advance();
    const name = this.expect('IDENT', 'имя переменной');
    this.expect('ASSIGN', '«=» и начальное значение');
    const init = this.expression();
    this.endStatement();
    return { kind: 'VarDecl', mutable: kw.type === 'LET', name: String(name.value), init, span: kw.span };
  }

  private fnDecl(): Stmt {
    const kw = this.advance();
    const name = this.expect('IDENT', 'имя функции');
    const params = this.params();
    const body = this.block();
    return { kind: 'FnDecl', name: String(name.value), params, body, span: kw.span };
  }

  private structDecl(): Stmt {
    const kw = this.advance();
    const name = this.expect('IDENT', 'имя структуры');
    this.expect('LBRACE', '«{» и описание полей');
    this.skipSeparators();

    const fields: Param[] = [];
    const methods: Array<{ name: string; params: Param[]; body: Stmt[]; span: Span }> = [];

    while (!this.check('RBRACE') && !this.atEnd()) {
      if (this.check('FN')) {
        const fkw = this.advance();
        const mName = this.expect('IDENT', 'имя метода');
        methods.push({
          name: String(mName.value),
          params: this.params(),
          body: this.block(),
          span: fkw.span,
        });
      } else {
        const f = this.expect('IDENT', 'имя поля или «fn» для метода');
        const def = this.match('ASSIGN') ? this.expression() : null;
        fields.push({ name: String(f.value), def });
      }
      this.skipSeparators();
      this.match('COMMA');
      this.skipSeparators();
    }

    this.expect('RBRACE', '«}» в конце структуры');
    return { kind: 'StructDecl', name: String(name.value), fields, methods, span: kw.span };
  }

  private params(): Param[] {
    this.expect('LPAREN', '«(» и список параметров');
    const params: Param[] = [];
    const seen = new Set<string>();
    while (!this.check('RPAREN') && !this.atEnd()) {
      const p = this.expect('IDENT', 'имя параметра');
      const pname = String(p.value);
      if (seen.has(pname)) throw parseError(`параметр «${pname}» указан дважды`, p.span);
      seen.add(pname);
      const def = this.match('ASSIGN') ? this.expression() : null;
      if (def === null && params.length > 0 && params[params.length - 1]!.def !== null) {
        throw parseError(
          `параметр «${pname}» без значения по умолчанию не может идти после параметра со значением`,
          p.span,
        );
      }
      params.push({ name: pname, def });
      if (!this.match('COMMA')) break;
    }
    this.expect('RPAREN', '«)» в конце списка параметров');
    return params;
  }

  private block(): Stmt[] {
    this.expect('LBRACE', '«{» и тело блока');
    const body: Stmt[] = [];
    this.skipSeparators();
    while (!this.check('RBRACE') && !this.atEnd()) {
      body.push(this.declaration());
      this.skipSeparators();
    }
    this.expect('RBRACE', '«}» в конце блока');
    return body;
  }

  // ---- инструкции ---------------------------------------------------------

  private statement(): Stmt {
    if (this.check('LBRACE')) {
      const span = this.peek().span;
      return { kind: 'Block', body: this.block(), span };
    }
    if (this.check('IF')) return this.ifStmt();
    if (this.check('WHILE')) return this.whileStmt();
    if (this.check('FOR')) return this.forStmt();
    if (this.check('RETURN')) return this.returnStmt();
    if (this.check('BREAK')) { const t = this.advance(); this.endStatement(); return { kind: 'Break', span: t.span }; }
    if (this.check('CONTINUE')) { const t = this.advance(); this.endStatement(); return { kind: 'Continue', span: t.span }; }

    const span = this.peek().span;
    const expr = this.expression();
    this.endStatement();
    return { kind: 'ExprStmt', expr, span };
  }

  /** Условие цикла/ветвления: «{» здесь всегда начало тела. */
  private condition(): Expr {
    this.noMapLiteral++;
    try {
      return this.expression();
    } finally {
      this.noMapLiteral--;
    }
  }

  private ifStmt(): Stmt {
    const kw = this.advance();
    const cond = this.condition();
    const span = this.peek().span;
    const then: Stmt = { kind: 'Block', body: this.block(), span };
    let alt: Stmt | null = null;
    // «}» и «else» на разных строках — обычное форматирование, перенос здесь не разделитель.
    const afterThen = this.pos;
    this.skipSeparators();
    if (!this.check('ELSE')) this.pos = afterThen;
    if (this.check('ELSE')) {
      this.advance();
      if (this.check('IF')) alt = this.ifStmt();
      else {
        const s = this.peek().span;
        alt = { kind: 'Block', body: this.block(), span: s };
      }
    }
    return { kind: 'If', cond, then, else: alt, span: kw.span };
  }

  private whileStmt(): Stmt {
    const kw = this.advance();
    const cond = this.condition();
    const span = this.peek().span;
    return { kind: 'While', cond, body: { kind: 'Block', body: this.block(), span }, span: kw.span };
  }

  private forStmt(): Stmt {
    const kw = this.advance();
    const name = this.expect('IDENT', 'имя переменной цикла');
    this.expect('IN', '«in» и последовательность');
    const iterable = this.condition();
    const span = this.peek().span;
    return {
      kind: 'For',
      name: String(name.value),
      iterable,
      body: { kind: 'Block', body: this.block(), span },
      span: kw.span,
    };
  }

  private returnStmt(): Stmt {
    const kw = this.advance();
    let value: Expr | null = null;
    if (!this.check('NEWLINE') && !this.check('SEMI') && !this.check('RBRACE') && !this.atEnd()) {
      value = this.expression();
    }
    this.endStatement();
    return { kind: 'Return', value, span: kw.span };
  }

  // ---- выражения ----------------------------------------------------------

  private expression(): Expr {
    return this.assignment();
  }

  private assignment(): Expr {
    // Короткая лямбда одного аргумента: `x -> x * 2`
    if (this.check('IDENT') && this.peek(1).type === 'ARROW') {
      const p = this.advance();
      this.advance();
      const body = this.assignment();
      return {
        kind: 'Fn',
        name: null,
        params: [{ name: String(p.value), def: null }],
        body: [{ kind: 'Return', value: body, span: body.span }],
        span: p.span,
      };
    }

    const target = this.ternary();
    const op = this.peek();
    const compound: Partial<Record<TokenType, string>> = {
      PLUS_ASSIGN: '+', MINUS_ASSIGN: '-', STAR_ASSIGN: '*', SLASH_ASSIGN: '/',
    };

    if (op.type === 'ASSIGN' || compound[op.type]) {
      this.advance();
      if (target.kind !== 'Ident' && target.kind !== 'Get' && target.kind !== 'Index') {
        throw parseError('присваивать можно только переменной, полю или элементу', op.span);
      }
      const rhs = this.assignment();
      const value: Expr = compound[op.type]
        ? { kind: 'Binary', op: compound[op.type]!, left: target, right: rhs, span: op.span }
        : rhs;
      return { kind: 'Assign', target, value, span: op.span };
    }

    return target;
  }

  private binaryLevel(next: () => Expr, kind: 'Binary' | 'Logical', ops: TokenType[]): Expr {
    let left = next();
    while (ops.some((t) => this.check(t))) {
      const op = this.advance();
      const right = next();
      left = { kind, op: op.lexeme, left, right, span: op.span } as Expr;
    }
    return left;
  }

  /** `условие ? одно : другое` — правоассоциативно, слабее «??». */
  private ternary(): Expr {
    const cond = this.nullish();
    if (!this.check('QUESTION')) return cond;
    const q = this.advance();
    const then = this.ternary();
    this.expect('COLON', '«:» и вторую ветку тернарного оператора');
    const alt = this.ternary();
    return { kind: 'Ternary', cond, then, else: alt, span: q.span };
  }

  private nullish(): Expr {
    return this.binaryLevel(() => this.or(), 'Logical', ['QQ']);
  }
  private or(): Expr {
    return this.binaryLevel(() => this.and(), 'Logical', ['OR']);
  }
  private and(): Expr {
    return this.binaryLevel(() => this.equality(), 'Logical', ['AND']);
  }
  private equality(): Expr {
    return this.binaryLevel(() => this.comparison(), 'Binary', ['EQ', 'NEQ']);
  }
  private comparison(): Expr {
    return this.binaryLevel(() => this.rangeExpr(), 'Binary', ['LT', 'LTE', 'GT', 'GTE']);
  }

  private rangeExpr(): Expr {
    const start = this.additive();
    if (this.check('RANGE')) {
      const op = this.advance();
      const end = this.additive();
      return { kind: 'Range', start, end, span: op.span };
    }
    return start;
  }

  private additive(): Expr {
    return this.binaryLevel(() => this.multiplicative(), 'Binary', ['PLUS', 'MINUS']);
  }
  private multiplicative(): Expr {
    return this.binaryLevel(() => this.unary(), 'Binary', ['STAR', 'SLASH', 'PERCENT']);
  }

  private unary(): Expr {
    if (this.check('BANG') || this.check('MINUS')) {
      const op = this.advance();
      return { kind: 'Unary', op: op.type === 'BANG' ? '!' : '-', right: this.unary(), span: op.span };
    }
    return this.power();
  }

  /**
   * Степень правоассоциативна (2^3^2 == 2^(3^2)) и связывает крепче унарного минуса:
   * -2^2 читается как -(2^2), как в математике.
   */
  private power(): Expr {
    const left = this.postfix();
    if (this.check('CARET')) {
      const op = this.advance();
      const right = this.unary();
      return { kind: 'Binary', op: '^', left, right, span: op.span };
    }
    return left;
  }

  private postfix(): Expr {
    let expr = this.primary();
    for (;;) {
      if (this.check('LPAREN')) {
        const open = this.advance();
        const args: Expr[] = [];
        while (!this.check('RPAREN') && !this.atEnd()) {
          // Внутри скобок «{» снова может быть словарём.
          const saved = this.noMapLiteral;
          this.noMapLiteral = 0;
          try {
            args.push(this.expression());
          } finally {
            this.noMapLiteral = saved;
          }
          if (!this.match('COMMA')) break;
        }
        this.expect('RPAREN', '«)» в конце списка аргументов');
        expr = { kind: 'Call', callee: expr, args, span: open.span };
      } else if (this.check('LBRACKET')) {
        const open = this.advance();
        const saved = this.noMapLiteral;
        this.noMapLiteral = 0;
        let index: Expr;
        try {
          index = this.expression();
        } finally {
          this.noMapLiteral = saved;
        }
        this.expect('RBRACKET', '«]» после индекса');
        expr = { kind: 'Index', object: expr, index, span: open.span };
      } else if (this.check('DOT')) {
        const dot = this.advance();
        const name = this.expect('IDENT', 'имя поля или метода после «.»');
        expr = { kind: 'Get', object: expr, name: String(name.value), span: dot.span };
      } else {
        return expr;
      }
    }
  }

  private primary(): Expr {
    const t = this.peek();

    if (this.match('NUMBER')) return { kind: 'Number', value: this.prev().value as number, span: t.span };
    if (this.match('TRUE')) return { kind: 'Bool', value: true, span: t.span };
    if (this.match('FALSE')) return { kind: 'Bool', value: false, span: t.span };
    if (this.match('NIL')) return { kind: 'Nil', span: t.span };
    if (this.match('IDENT')) return { kind: 'Ident', name: String(this.prev().value), span: t.span };

    if (this.match('STRING')) {
      const tok = this.prev();
      if (tok.parts === undefined) return { kind: 'Str', value: String(tok.value), span: t.span };
      const parts = tok.parts.map((p) =>
        p.kind === 'text' ? { text: p.text } : { expr: this.subExpression(p.source, p.span) },
      );
      return { kind: 'Template', parts, span: t.span };
    }

    if (this.check('FN')) {
      const kw = this.advance();
      const name = this.check('IDENT') ? String(this.advance().value) : null;
      const params = this.params();
      // `fn(x) -> x * 2` — тело-выражение с неявным return.
      if (this.match('ARROW')) {
        const body = this.expression();
        return { kind: 'Fn', name, params, body: [{ kind: 'Return', value: body, span: body.span }], span: kw.span };
      }
      return { kind: 'Fn', name, params, body: this.block(), span: kw.span };
    }

    if (this.check('LPAREN')) {
      this.advance();
      // `(a, b) -> ...` — лямбда; отличаем от группировки по стрелке после «)».
      const lambda = this.tryLambda(t.span);
      if (lambda) return lambda;
      const saved = this.noMapLiteral;
      this.noMapLiteral = 0;
      let inner: Expr;
      try {
        inner = this.expression();
      } finally {
        this.noMapLiteral = saved;
      }
      this.expect('RPAREN', '«)» в конце выражения в скобках');
      return inner;
    }

    if (this.check('LBRACKET')) {
      const open = this.advance();
      const items: Expr[] = [];
      const saved = this.noMapLiteral;
      this.noMapLiteral = 0;
      try {
        while (!this.check('RBRACKET') && !this.atEnd()) {
          items.push(this.expression());
          if (!this.match('COMMA')) break;
        }
      } finally {
        this.noMapLiteral = saved;
      }
      this.expect('RBRACKET', '«]» в конце списка');
      return { kind: 'List', items, span: open.span };
    }

    if (this.check('LBRACE')) {
      if (this.noMapLiteral === 0) return this.mapLiteral();
      // Здесь «{» уже занято телом if/while/for — словарь нужно отделить скобками.
      throw parseError(
        'здесь «{» начинает тело блока — если это словарь, возьмите его в скобки: ({ ... })',
        t.span,
      );
    }

    if (t.type === 'NEWLINE' || t.type === 'EOF') {
      throw parseError('выражение оборвалось — ожидалось значение', t.span);
    }
    throw parseError(`ожидалось значение, а встретилось ${describe(t)}`, t.span);
  }

  /** Разбирает `(a, b) -> тело`, откатываясь, если это была обычная скобка. */
  private tryLambda(span: Span): Expr | null {
    const start = this.pos;
    const names: string[] = [];
    while (this.check('IDENT')) {
      names.push(String(this.advance().value));
      if (!this.match('COMMA')) break;
    }
    const ok = this.check('RPAREN') && this.peek(1).type === 'ARROW';
    if (!ok) {
      this.pos = start;
      return null;
    }
    this.advance(); // )
    this.advance(); // ->
    const body = this.expression();
    return {
      kind: 'Fn',
      name: null,
      params: names.map((n) => ({ name: n, def: null })),
      body: [{ kind: 'Return', value: body, span: body.span }],
      span,
    };
  }

  private mapLiteral(): Expr {
    const open = this.expect('LBRACE', '«{»');
    const entries: Array<{ key: Expr; value: Expr }> = [];
    const saved = this.noMapLiteral;
    this.noMapLiteral = 0;
    try {
      this.skipSeparators();
      while (!this.check('RBRACE') && !this.atEnd()) {
        let key: Expr;
        if (this.check('LBRACKET')) {
          this.advance();
          key = this.expression();
          this.expect('RBRACKET', '«]» после вычисляемого ключа');
        } else if (this.check('STRING')) {
          const k = this.advance();
          if (k.parts) throw parseError('ключ словаря не может содержать вставку ${...}', k.span);
          key = { kind: 'Str', value: String(k.value), span: k.span };
        } else if (this.check('NUMBER')) {
          const k = this.advance();
          key = { kind: 'Number', value: k.value as number, span: k.span };
        } else if (this.check('TRUE') || this.check('FALSE')) {
          const k = this.advance();
          key = { kind: 'Bool', value: k.type === 'TRUE', span: k.span };
        } else {
          const k = this.expect('IDENT', 'ключ словаря');
          key = { kind: 'Str', value: String(k.value), span: k.span };
        }
        this.expect('COLON', '«:» между ключом и значением');
        this.skipSeparators();
        entries.push({ key, value: this.expression() });
        this.skipSeparators();
        if (!this.match('COMMA')) break;
        this.skipSeparators();
      }
      this.skipSeparators();
    } finally {
      this.noMapLiteral = saved;
    }
    this.expect('RBRACE', '«}» в конце словаря');
    return { kind: 'Map', entries, span: open.span };
  }

  /** Отдельный разбор исходника вставки `${...}` с сохранением позиций. */
  private subExpression(source: string, span: Span): Expr {
    const tokens = new Lexer(source, span.file, span.line, span.col).tokenize();
    return new Parser(tokens, this.file).parseSingleExpr();
  }
}

export function parse(tokens: Token[], file = '<input>'): Program {
  return new Parser(tokens, file).parse();
}
