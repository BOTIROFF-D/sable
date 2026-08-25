// Статическая проверка программы — обход AST до запуска, без выполнения кода.
//
// Находит то, что видно по одному лишь дереву: неизвестные имена, запись в const,
// повторные объявления, «break»/«continue»/«return» не на своём месте, недостижимый
// код, неверное число аргументов, опечатку в имени поля структуры и переменные,
// которые объявили и забыли.
//
// Главное правило: молчать, если не уверены. Ложное срабатывание раздражает сильнее,
// чем пропущенная ошибка, поэтому проверки, которым нужен тип значения, работают
// только там, где тип виден глазами (`let p = Point(1, 2)` → `p` это Point).
//
// Области видимости повторяют интерпретатор:
//   • блок создаёт свою область; параметры функции лежат в одной области с её телом;
//   • переменная цикла `for` живёт в области тела цикла;
//   • имя ищется в момент вызова, а не объявления — поэтому тела функций проверяются
//     не сразу, а в конце того блока, где функция объявлена. Так взаимная рекурсия и
//     ссылка на объявленное ниже имя не превращаются в ложную ошибку.

import type { Expr, Param, Program, Stmt } from './ast.ts';
import type { Span } from './errors.ts';

export type Diagnostic = { severity: 'error' | 'warning'; message: string; span: Span };

/** Сколько аргументов принимает объявленная функция: от обязательных до всех. */
type Arity = { name: string; min: number; max: number };

/** Что известно про структуру: имя, поля по порядку и арность конструктора. */
type StructInfo = { name: string; fields: string[]; min: number; max: number };

/** Что известно про имя: где объявлено, можно ли менять, чем оно является. */
type Binding = {
  name: string;
  span: Span;
  kind: 'let' | 'const' | 'param' | 'loop' | 'fn' | 'struct' | 'self' | 'global';
  mutable: boolean;
  warnUnused: boolean;
  used: boolean;
  /** Заполнено, если имя объявлено через `fn имя(...)`. */
  arity: Arity | null;
  /** Заполнено, если имя объявлено через `struct имя { ... }`. */
  struct: StructInfo | null;
  /** Структура, экземпляр которой заведомо лежит в этом имени. */
  instance: StructInfo | null;
};

type Scope = { names: Map<string, Binding>; parent: Scope | null };

/**
 * Проверить программу. `globals` — имена встроенных функций: они лежат в той же
 * области, что и объявления верхнего уровня, ровно как в интерпретаторе.
 */
export function check(program: Program, globals: Iterable<string>): Diagnostic[] {
  return new Checker(globals).run(program);
}

class Checker {
  private diags: Diagnostic[] = [];
  private scope: Scope;
  /** Тела функций, отложенные до конца текущего блока. */
  private deferred: Array<() => void> = [];
  private loopDepth = 0;
  private fnDepth = 0;
  /** Имена, которым где-то в программе присваивают: их тип считать известным нельзя. */
  private reassigned = new Set<string>();

  constructor(globals: Iterable<string>) {
    this.scope = { names: new Map(), parent: null };
    const nowhere: Span = { line: 0, col: 0, file: '<встроенное>' };
    for (const name of globals) {
      this.scope.names.set(name, {
        name, span: nowhere, kind: 'global',
        mutable: false, warnUnused: false, used: true,
        arity: null, struct: null, instance: null,
      });
    }
  }

  run(program: Program): Diagnostic[] {
    collectReassigned(program, this.reassigned);
    this.block(program, this.scope);
    // Порядок отчёта — порядок чтения: сверху вниз, слева направо.
    this.diags.sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col);
    return this.diags;
  }

  // ---- отчёт --------------------------------------------------------------

  private error(message: string, span: Span): void {
    this.diags.push({ severity: 'error', message, span });
  }

  private warn(message: string, span: Span): void {
    this.diags.push({ severity: 'warning', message, span });
  }

  // ---- области видимости --------------------------------------------------

  private lookup(name: string): Binding | null {
    for (let s: Scope | null = this.scope; s; s = s.parent) {
      const b = s.names.get(name);
      if (b) return b;
    }
    return null;
  }

  private define(
    name: string,
    span: Span,
    kind: Binding['kind'],
    mutable: boolean,
    warnUnused: boolean,
  ): Binding {
    if (this.scope.names.has(name)) {
      this.error(
        `«${name}» уже объявлено в этой области видимости — ` +
        'переименуйте одно из объявлений или присвойте значение без «let»',
        span,
      );
    }
    const b: Binding = {
      name, span, kind, mutable, warnUnused, used: false,
      arity: null, struct: null, instance: null,
    };
    this.scope.names.set(name, b);
    return b;
  }

  /**
   * Обойти блок в своей области видимости.
   * `prelude` — что объявить до первой инструкции (параметры функции, переменная цикла):
   * это делается уже внутри кадра блока, чтобы лямбда в значении по умолчанию тоже
   * попала в отложенную проверку.
   */
  private block(stmts: Stmt[], scope: Scope, prelude?: () => void): void {
    const prevScope = this.scope;
    const prevDeferred = this.deferred;
    this.scope = scope;
    this.deferred = [];

    if (prelude) prelude();

    // Недостижимый код: всё, что стоит после return/break/continue в этом же списке.
    let stopper: 'return' | 'break' | 'continue' | null = null;
    let reported = false;
    for (const stmt of stmts) {
      if (stopper && !reported) {
        this.warn(
          `код после «${stopper}» никогда не выполнится — уберите его или поднимите выше «${stopper}»`,
          stmt.span,
        );
        reported = true;
      }
      this.statement(stmt);
      if (!stopper) {
        if (stmt.kind === 'Return') stopper = 'return';
        else if (stmt.kind === 'Break') stopper = 'break';
        else if (stmt.kind === 'Continue') stopper = 'continue';
      }
    }

    const jobs = this.deferred;
    this.deferred = prevDeferred;
    // Тела функций проверяются, когда весь блок разобран: имя ищется в момент вызова.
    for (const job of jobs) job();

    this.scope = prevScope;
    this.reportUnused(scope);
  }

  private reportUnused(scope: Scope): void {
    for (const b of scope.names.values()) {
      if (!b.warnUnused || b.used || b.name.startsWith('_')) continue;
      this.warn(
        `${b.kind === 'loop' ? 'переменная цикла' : 'переменная'} «${b.name}» объявлена, ` +
        'но нигде не используется — уберите её или начните имя с «_»',
        b.span,
      );
    }
  }

  // ---- инструкции ---------------------------------------------------------

  private statement(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'Import':
        // Что лежит внутри модуля, статически неизвестно — проверяем только само имя.
        this.define(stmt.alias, stmt.span, 'const', false, false);
        return;

      case 'ExprStmt':
        this.expression(stmt.expr);
        return;

      case 'VarDecl': {
        // Значение вычисляется до объявления: `let x = x` смотрит на внешнее «x».
        this.expression(stmt.init);
        const b = this.define(stmt.name, stmt.span, stmt.mutable ? 'let' : 'const', stmt.mutable, true);
        b.instance = this.instanceType(stmt.init, stmt.name);
        return;
      }

      case 'FnDecl': {
        const b = this.define(stmt.name, stmt.span, 'fn', false, false);
        b.arity = arityOf(stmt.name, stmt.params);
        this.deferFunction(stmt.params, stmt.body, stmt.span, null);
        return;
      }

      case 'StructDecl': {
        const info: StructInfo = {
          name: stmt.name,
          fields: stmt.fields.map((f) => f.name),
          min: stmt.fields.filter((f) => f.def === null).length,
          max: stmt.fields.length,
        };
        const b = this.define(stmt.name, stmt.span, 'struct', false, false);
        b.struct = info;
        this.deferStructBodies(stmt, info);
        return;
      }

      case 'Block':
        this.block(stmt.body, { names: new Map(), parent: this.scope });
        return;

      case 'If':
        this.expression(stmt.cond);
        this.statement(stmt.then);
        if (stmt.else) this.statement(stmt.else);
        return;

      case 'While':
        this.expression(stmt.cond);
        this.loopDepth++;
        this.statement(stmt.body);
        this.loopDepth--;
        return;

      case 'For': {
        this.expression(stmt.iterable);
        this.loopDepth++;
        // Переменная цикла живёт в области тела — как в executeFor интерпретатора.
        this.block(bodyOf(stmt.body), { names: new Map(), parent: this.scope }, () => {
          this.define(stmt.name, stmt.span, 'loop', true, true);
        });
        this.loopDepth--;
        return;
      }

      case 'Try':
        // Тело и обработчик — две отдельные области; имя ошибки живёт только в обработчике.
        this.block(stmt.body, { names: new Map(), parent: this.scope });
        this.block(stmt.handler, { names: new Map(), parent: this.scope }, () => {
          if (stmt.param) this.define(stmt.param, stmt.span, 'const', false, false);
        });
        return;

      case 'Return':
        if (this.fnDepth === 0) {
          this.error('«return» вне функции — вернуть значение можно только из тела функции', stmt.span);
        }
        if (stmt.value) this.expression(stmt.value);
        return;

      case 'Break':
        if (this.loopDepth === 0) {
          this.error('«break» вне цикла — прервать можно только «while» или «for»', stmt.span);
        }
        return;

      case 'Continue':
        if (this.loopDepth === 0) {
          this.error('«continue» вне цикла — перейти к следующему витку можно только в «while» или «for»', stmt.span);
        }
        return;
    }
  }

  // ---- функции ------------------------------------------------------------

  /**
   * Отложить проверку тела до конца текущего блока. Внутри тела счётчик циклов
   * обнуляется: «break» в функции, объявленной внутри цикла, до цикла не долетит.
   */
  private deferFunction(params: Param[], body: Stmt[], span: Span, self: StructInfo | null): void {
    const scope = this.scope;
    this.deferred.push(() => {
      const prevLoop = this.loopDepth;
      const prevFn = this.fnDepth;
      this.loopDepth = 0;
      this.fnDepth++;
      // Параметры и тело — одна область: интерпретатор кладёт их в один Environment.
      this.block(body, { names: new Map(), parent: scope }, () => {
        if (self) {
          const b = this.define('self', span, 'self', false, false);
          b.instance = self;
        }
        for (const p of params) {
          // Значение по умолчанию видит предыдущие параметры — объявляем по одному.
          if (p.def) this.expression(p.def);
          this.define(p.name, span, 'param', true, false);
        }
      });
      this.loopDepth = prevLoop;
      this.fnDepth = prevFn;
    });
  }

  /** Значения полей по умолчанию и методы структуры. */
  private deferStructBodies(stmt: Extract<Stmt, { kind: 'StructDecl' }>, info: StructInfo): void {
    // Значения по умолчанию вычисляются рядом с глобальными именами и видят
    // предыдущие поля — область объявления структуры им недоступна.
    const fieldScope = this.scope;
    this.deferred.push(() => {
      this.block([], { names: new Map(), parent: globalOf(fieldScope) }, () => {
        for (const f of stmt.fields) {
          if (f.def) this.expression(f.def);
          this.define(f.name, stmt.span, 'param', true, false);
        }
      });
    });
    for (const m of stmt.methods) this.deferFunction(m.params, m.body, m.span, info);
  }

  // ---- выражения ----------------------------------------------------------

  private expression(expr: Expr): void {
    switch (expr.kind) {
      case 'Number':
      case 'Str':
      case 'Bool':
      case 'Nil':
        return;

      case 'Template':
        for (const part of expr.parts) if ('expr' in part) this.expression(part.expr);
        return;

      case 'List':
        for (const item of expr.items) this.expression(item);
        return;

      case 'Map':
        for (const { key, value } of expr.entries) {
          this.expression(key);
          this.expression(value);
        }
        return;

      case 'Ident':
        this.use(expr.name, expr.span);
        return;

      case 'Unary':
        this.expression(expr.right);
        return;

      case 'Binary':
      case 'Logical':
        this.expression(expr.left);
        this.expression(expr.right);
        return;

      case 'Ternary':
        this.expression(expr.cond);
        this.expression(expr.then);
        this.expression(expr.else);
        return;

      case 'Range':
        this.expression(expr.start);
        this.expression(expr.end);
        return;

      case 'Index':
        this.expression(expr.object);
        this.expression(expr.index);
        return;

      case 'Get':
        this.expression(expr.object);
        return;

      case 'Call':
        this.call(expr);
        return;

      case 'Assign':
        this.assign(expr);
        return;

      case 'Fn':
        // Имя у функции-значения не объявляется нигде — интерпретатор его только помнит.
        this.deferFunction(expr.params, expr.body, expr.span, null);
        return;
    }
  }

  private use(name: string, span: Span): Binding | null {
    const b = this.lookup(name);
    if (b) {
      b.used = true;
      return b;
    }
    this.error(`имя «${name}» не определено${this.hint(name)}`, span);
    return null;
  }

  private call(expr: Extract<Expr, { kind: 'Call' }>): void {
    this.expression(expr.callee);
    for (const a of expr.args) this.expression(a);

    if (expr.callee.kind !== 'Ident') return;
    const b = this.lookup(expr.callee.name);
    if (!b) return;

    // Проверяем только то, что нельзя переприсвоить: `fn имя(...)` и `struct имя {...}`.
    const arity = b.arity ?? (b.struct ? { name: b.struct.name, min: b.struct.min, max: b.struct.max } : null);
    if (!arity) return;

    const got = expr.args.length;
    if (got >= arity.min && got <= arity.max) return;
    const need = arity.min === arity.max ? `${arity.min}` : `от ${arity.min} до ${arity.max}`;
    this.error(
      `«${arity.name}» ожидает ${need} ${plural(arity.max)}, а получает ${got}`,
      expr.span,
    );
  }

  private assign(expr: Extract<Expr, { kind: 'Assign' }>): void {
    this.expression(expr.value);
    const target = expr.target;

    if (target.kind === 'Ident') {
      const b = this.lookup(target.name);
      if (!b) {
        this.error(
          `нельзя присвоить необъявленному «${target.name}» — начните со «let ${target.name} = ...»`,
          target.span,
        );
        return;
      }
      if (!b.mutable) this.error(immutableMessage(b), target.span);
      return;
    }

    if (target.kind === 'Get') {
      this.expression(target.object);
      const info = this.structOf(target.object);
      if (info && !info.fields.includes(target.name)) {
        this.error(`у ${info.name} нет поля «${target.name}»${fieldHint(target.name, info)}`, target.span);
      }
      return;
    }

    if (target.kind === 'Index') {
      this.expression(target.object);
      this.expression(target.index);
    }
  }

  // ---- что мы знаем о типах -----------------------------------------------

  /**
   * Структура, экземпляр которой лежит в выражении, — только когда это очевидно:
   * имя, объявленное как `let p = Point(...)`, либо `self` внутри метода.
   */
  private structOf(expr: Expr): StructInfo | null {
    if (expr.kind !== 'Ident') return null;
    const b = this.lookup(expr.name);
    return b?.instance ?? null;
  }

  /** Тип для `let p = Point(1, 2)`. Если имени где-то присваивают — молчим. */
  private instanceType(init: Expr, name: string): StructInfo | null {
    if (init.kind !== 'Call' || init.callee.kind !== 'Ident') return null;
    if (this.reassigned.has(name)) return null;
    return this.lookup(init.callee.name)?.struct ?? null;
  }

  /** Подсказка про опечатку: ближайшее известное имя по расстоянию Левенштейна. */
  private hint(name: string): string {
    const known: string[] = [];
    for (let s: Scope | null = this.scope; s; s = s.parent) known.push(...s.names.keys());
    const best = nearest(name, known);
    return best ? ` — возможно, имелось в виду «${best}»` : '';
  }
}

// ---- вспомогательное ------------------------------------------------------

const bodyOf = (stmt: Stmt): Stmt[] => (stmt.kind === 'Block' ? stmt.body : [stmt]);

const globalOf = (scope: Scope): Scope => {
  let s = scope;
  while (s.parent) s = s.parent;
  return s;
};

const arityOf = (name: string, params: Param[]): Arity => ({
  name,
  min: params.filter((p) => p.def === null).length,
  max: params.length,
});

function immutableMessage(b: Binding): string {
  switch (b.kind) {
    case 'fn': return `«${b.name}» — имя функции, присваивать ему нельзя`;
    case 'struct': return `«${b.name}» — имя структуры, присваивать ему нельзя`;
    case 'global': return `«${b.name}» — встроенная функция, присваивать ей нельзя`;
    case 'self': return '«self» менять нельзя — присваивайте его полям: self.поле = ...';
    default: return `«${b.name}» объявлено через const — менять нельзя`;
  }
}

function fieldHint(name: string, info: StructInfo): string {
  const best = nearest(name, info.fields);
  if (best) return ` — возможно, имелось в виду «${best}»`;
  return info.fields.length ? ` — есть поля: ${info.fields.join(', ')}` : '';
}

/** Ближайшее имя из списка, если оно достаточно близко; иначе null. */
function nearest(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const known of candidates) {
    if (known === name) continue;
    const d = distance(name, known);
    if (d < bestDist) { bestDist = d; best = known; }
  }
  const limit = Math.max(1, Math.floor(name.length / 3));
  return best && bestDist <= limit ? best : null;
}

/** Расстояние Левенштейна — как в environment.ts, чтобы подсказки совпадали. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return Infinity;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'аргумент';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'аргумента';
  return 'аргументов';
}

/**
 * Предварительный проход: какие имена где-то получают новое значение.
 * Такому имени нельзя приписать тип по первому присваиванию — значение могло смениться.
 */
function collectReassigned(program: Program, out: Set<string>): void {
  const walkStmt = (stmt: Stmt): void => {
    switch (stmt.kind) {
      case 'Import': return;
      case 'ExprStmt': walkExpr(stmt.expr); return;
      case 'VarDecl': walkExpr(stmt.init); return;
      case 'FnDecl': stmt.params.forEach((p) => p.def && walkExpr(p.def)); stmt.body.forEach(walkStmt); return;
      case 'StructDecl':
        stmt.fields.forEach((f) => f.def && walkExpr(f.def));
        stmt.methods.forEach((m) => {
          m.params.forEach((p) => p.def && walkExpr(p.def));
          m.body.forEach(walkStmt);
        });
        return;
      case 'Block': stmt.body.forEach(walkStmt); return;
      case 'If': walkExpr(stmt.cond); walkStmt(stmt.then); if (stmt.else) walkStmt(stmt.else); return;
      case 'While': walkExpr(stmt.cond); walkStmt(stmt.body); return;
      case 'For': walkExpr(stmt.iterable); walkStmt(stmt.body); return;
      case 'Try': stmt.body.forEach(walkStmt); stmt.handler.forEach(walkStmt); return;
      case 'Return': if (stmt.value) walkExpr(stmt.value); return;
      case 'Break':
      case 'Continue': return;
    }
  };

  const walkExpr = (expr: Expr): void => {
    switch (expr.kind) {
      case 'Number': case 'Str': case 'Bool': case 'Nil': return;
      case 'Template': expr.parts.forEach((p) => { if ('expr' in p) walkExpr(p.expr); }); return;
      case 'List': expr.items.forEach(walkExpr); return;
      case 'Map': expr.entries.forEach((e) => { walkExpr(e.key); walkExpr(e.value); }); return;
      case 'Ident': return;
      case 'Unary': walkExpr(expr.right); return;
      case 'Binary': case 'Logical': walkExpr(expr.left); walkExpr(expr.right); return;
      case 'Ternary': walkExpr(expr.cond); walkExpr(expr.then); walkExpr(expr.else); return;
      case 'Range': walkExpr(expr.start); walkExpr(expr.end); return;
      case 'Index': walkExpr(expr.object); walkExpr(expr.index); return;
      case 'Get': walkExpr(expr.object); return;
      case 'Call': walkExpr(expr.callee); expr.args.forEach(walkExpr); return;
      case 'Fn': expr.params.forEach((p) => p.def && walkExpr(p.def)); expr.body.forEach(walkStmt); return;
      case 'Assign':
        if (expr.target.kind === 'Ident') out.add(expr.target.name);
        walkExpr(expr.target);
        walkExpr(expr.value);
        return;
    }
  };

  program.forEach(walkStmt);
}
