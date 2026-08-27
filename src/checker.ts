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
type StructInfo = {
  name: string;
  fields: string[];
  min: number;
  max: number;
  /** Методы структуры и сколько аргументов каждый принимает. */
  methods: Map<string, Arity>;
};

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
/**
 * `globals` — встроенные имена. Если передать значения, а не только имена,
 * проверка узнаёт и число аргументов: у каждой встроенной функции оно записано
 * там же, и выбрасывать его на входе значило не выполнять обещание справочника.
 */
export function check(program: Program, globals: Iterable<string | [string, Arity]>): Diagnostic[] {
  return new Checker(globals).run(program);
}

class Checker {
  private diags: Diagnostic[] = [];
  private scope: Scope;
  /** Область объявлений верхнего уровня программы — НЕ область встроенных имён. */
  private topScope: Scope;
  /** Тела функций, отложенные до конца программы. */
  private deferred: Array<() => void> = [];
  /** Области, для которых отчёт о забытых именах ждёт конца программы. */
  private pendingUnused: Scope[] = [];
  private loopDepth = 0;
  private fnDepth = 0;
  /** Имена, которым где-то в программе присваивают: их тип считать известным нельзя. */
  private reassigned = new Set<string>();

  constructor(globals: Iterable<string | [string, Arity]>) {
    // Встроенные имена лежат в отдельной внешней области — как в интерпретаторе.
    // Поэтому `let sum = 0` не «уже объявлено», а законное затенение.
    const builtins: Scope = { names: new Map(), parent: null };
    this.scope = { names: new Map(), parent: builtins };
    this.topScope = this.scope;
    const nowhere: Span = { line: 0, col: 0, file: '<встроенное>' };
    for (const entry of globals) {
      const [name, arity] = typeof entry === 'string' ? [entry, null] : entry;
      builtins.names.set(name, {
        name, span: nowhere, kind: 'global',
        mutable: false, warnUnused: false, used: true,
        arity, struct: null, instance: null,
      });
    }
  }

  run(program: Program): Diagnostic[] {
    collectReassigned(program, this.reassigned);
    this.block(program, this.scope);
    // Тела функций могут порождать новые отложенные тела — черпаем до дна.
    while (this.deferred.length > 0) {
      const jobs = this.deferred;
      this.deferred = [];
      for (const job of jobs) job();
    }
    for (const scope of this.pendingUnused) this.reportUnused(scope);
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
    this.scope = scope;

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

    this.scope = prevScope;
    // Отчёт о забытых именах ждёт конца программы: имя может быть использовано
    // в теле функции, которое проверяется позже.
    this.pendingUnused.push(scope);
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
        // Что лежит внутри модуля, статически неизвестно — проверяем только имена.
        // Выборочный импорт объявляет каждое взятое имя: без этого обращение к нему
        // читалось бы как «имя не определено», а повторный импорт молчал бы.
        if (stmt.names !== null) {
          for (const n of stmt.names) this.define(n.alias, n.span, 'const', false, false);
        } else {
          this.define(stmt.alias, stmt.span, 'const', false, false);
        }
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
          methods: new Map(stmt.methods.map((m) => [m.name, arityOf(`${stmt.name}.${m.name}`, m.params)])),
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
        // Тело, обработчик и finally — три отдельные области; имя ошибки живёт
        // только в обработчике.
        this.block(stmt.body, { names: new Map(), parent: this.scope });
        if (stmt.handler !== null) {
          const handler = stmt.handler;
          this.block(handler, { names: new Map(), parent: this.scope }, () => {
            if (stmt.param) this.define(stmt.param, stmt.span, 'const', false, false);
          });
        }
        if (stmt.finalizer !== null) {
          this.block(stmt.finalizer, { names: new Map(), parent: this.scope });
          for (const s of stmt.finalizer) this.warnFinallyEscape(s, false);
        }
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

  /**
   * `return`, `break` и `continue` прямо в теле `finally`.
   *
   * Выполняться `finally` обязан всегда, в том числе по пути чужого сигнала, —
   * и собственный сигнал изнутри `finally` этот чужой перекрывает: функция
   * вернёт не то, что было в `return` внутри `try`, а цикл прервётся не там,
   * где просили. Язык такую запись разрешает (запретить её всё равно нельзя:
   * ошибка из вызванной внутри `finally` функции перекрывает ровно так же),
   * но молчать о ней проверка не должна — она молча теряет причину выхода.
   *
   * Внутрь вложенных функций не спускаемся вовсе, а `break`/`continue` внутри
   * цикла, заведённого прямо в `finally`, законны: такой сигнал из блока не выходит.
   */
  private warnFinallyEscape(stmt: Stmt, inLoop: boolean): void {
    switch (stmt.kind) {
      case 'Return':
        // Вне функции про «return» уже сказано ошибкой — не повторяться.
        if (this.fnDepth > 0) {
          this.warn(
            '«return» внутри «finally» перекроет то, ради чего покидали блок, — ' +
            'верните значение из «try» или из «catch»',
            stmt.span,
          );
        }
        return;

      case 'Break':
      case 'Continue':
        if (!inLoop && this.loopDepth > 0) {
          this.warn(
            `«${stmt.kind === 'Break' ? 'break' : 'continue'}» внутри «finally» перекроет то, ` +
            'ради чего покидали блок, — перенесите его в «try» или в «catch»',
            stmt.span,
          );
        }
        return;

      case 'Block':
        for (const s of stmt.body) this.warnFinallyEscape(s, inLoop);
        return;

      case 'If':
        this.warnFinallyEscape(stmt.then, inLoop);
        if (stmt.else) this.warnFinallyEscape(stmt.else, inLoop);
        return;

      case 'While':
      case 'For':
        this.warnFinallyEscape(stmt.body, true);
        return;

      case 'Try':
        for (const s of stmt.body) this.warnFinallyEscape(s, inLoop);
        if (stmt.handler !== null) for (const s of stmt.handler) this.warnFinallyEscape(s, inLoop);
        if (stmt.finalizer !== null) for (const s of stmt.finalizer) this.warnFinallyEscape(s, inLoop);
        return;

      default:
        return;
    }
  }

  // ---- функции ------------------------------------------------------------

  /**
   * Отложить проверку тела до конца программы — не до конца блока, где функция
   * объявлена. Имя ищется в момент вызова, а вызвать функцию могут когда угодно
   * позже; проверка на границе блока объявляла бы ошибкой рабочий код:
   *
   *     { fn внутри() { return позже() } }
   *     fn позже() { return 7 }
   *
   * Внутри тела счётчик циклов обнуляется: «break» в функции, объявленной внутри
   * цикла, до цикла не долетит.
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
    // Значения по умолчанию вычисляются рядом с именами верхнего уровня и видят
    // предыдущие поля — область объявления структуры им недоступна.
    this.deferred.push(() => {
      this.block([], { names: new Map(), parent: this.topScope }, () => {
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

      case 'Get': {
        this.expression(expr.object);
        // Тип известен только там, где он очевиден глазами; иначе молчим.
        const info = this.structOf(expr.object);
        if (info && !info.fields.includes(expr.name) && !info.methods.has(expr.name)) {
          const near = nearestOf(expr.name, [...info.fields, ...info.methods.keys()]);
          this.error(
            `у ${info.name} нет поля или метода «${expr.name}»`
            + (near ? ` — возможно, имелось в виду «${near}»` : ''),
            expr.span,
          );
        }
        return;
      }

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

    // Метод структуры, тип которой очевиден: арность известна так же точно,
    // как у свободной функции.
    if (expr.callee.kind === 'Get') {
      const info = this.structOf(expr.callee.object);
      const method = info?.methods.get(expr.callee.name);
      if (method) this.checkArity(method, expr.args.length, expr.span);
      return;
    }

    if (expr.callee.kind !== 'Ident') return;
    const b = this.lookup(expr.callee.name);
    if (!b) return;

    // Проверяем только то, что нельзя переприсвоить: `fn имя(...)` и `struct имя {...}`.
    const arity = b.arity ?? (b.struct ? { name: b.struct.name, min: b.struct.min, max: b.struct.max } : null);
    if (!arity) return;

    this.checkArity(arity, expr.args.length, expr.span);
  }

  private checkArity(arity: Arity, got: number, span: Span): void {
    if (got >= arity.min && got <= arity.max) return;
    const need = arity.min === arity.max ? `${arity.min}` : `от ${arity.min} до ${arity.max}`;
    this.error(`«${arity.name}» ожидает ${need} ${plural(arity.max)}, а получает ${got}`, span);
  }

  private assign(expr: Extract<Expr, { kind: 'Assign' }>): void {
    this.expression(expr.value);
    const target = expr.target;

    if (target.kind === 'Ident') {
      const b = this.lookup(target.name);
      // `x += 1` не только пишет, но и читает: без этого «объявлена и забыта»
      // срабатывало бы на счётчике, который исправно наращивают.
      if (b && expr.op !== null) b.used = true;
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

/** Ближайшее по написанию имя из готового списка. */
function nearestOf(name: string, known: string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const k of known) {
    const d = distance(name, k);
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return best && bestDist <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

const bodyOf = (stmt: Stmt): Stmt[] => (stmt.kind === 'Block' ? stmt.body : [stmt]);

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
      case 'Try':
        stmt.body.forEach(walkStmt);
        stmt.handler?.forEach(walkStmt);
        stmt.finalizer?.forEach(walkStmt);
        return;
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
