#!/usr/bin/env node
// tests/fuzz-tools.ts — охота на всём, что окружает ядро языка.
//
// tests/fuzz.ts проверяет одну программу в одном файле. Здесь закрыты дыры,
// которые он честно перечислил как непокрытые:
//
//   modules — наборы из нескольких файлов: обычные импорты, ромб (один файл
//             подключён двумя разными), цепочки, циклы, отсутствующий файл,
//             ошибка внутри модуля, обращение к несуществующему имени.
//   fmt     — форматтер как оракул: format идемпотентен, программа после
//             форматирования печатает ровно то же, комментарии не теряются,
//             отформатированное снова разбирается.
//   check   — согласованность «--check» с выполнением в обе стороны, плюс
//             «вердикт анализатора не должен меняться от форматирования».
//   files   — read_file / write_file во временной папке: нет файла, папка
//             вместо файла, пустой, большой, кривой UTF-8, некуда писать.
//   input   — input() при закрытом вводе, без перевода строки, на мусоре.
//   repl    — интерактивный режим: незакрытые конструкции, команды, мусор.
//
// Общее правило дефекта, одно на все режимы: наружу выходит либо результат,
// либо ОШИБКА sable со стрелкой. Стек JavaScript, «undefined», сигнал, чужой
// код возврата, зависание — дефект всегда.
//
// Запуск:
//   node tests/fuzz-tools.ts                    — все режимы, случайное зерно
//   node tests/fuzz-tools.ts --mode=modules     — только модули
//   node tests/fuzz-tools.ts --seed=123 --count=40
//   node tests/fuzz-tools.ts --root=/путь/к/копии   — проверять другой срез кода
//
// Про «--root»: пока в src/interpreter.ts идёт переработка, охотиться в рабочей
// папке бессмысленно — падает всё подряд. Тогда снимается чистая копия
// (git archive HEAD) и «--root» направляет фаззер на неё.
//
// Все временные файлы живут в отдельной папке под tmpdir() и удаляются в конце;
// домашняя папка интерактивного режима подменяется, чтобы не тронуть
// настоящий ~/.sable_history. Найденное складывается в tests/fuzz-findings/.

import { spawn } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Gen, JS_MARKERS, Rnd, ROOT, VALUE_MARKERS, generate } from './fuzz.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(ROOT, 'src', 'cli.ts');
const FINDINGS = join(HERE, 'fuzz-findings');

// ---- разбор аргументов -----------------------------------------------------

const argOf = (name: string, def: number): number => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw === undefined ? def : Number(raw.slice(name.length + 3));
};
const argStr = (name: string, def: string): string => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw === undefined ? def : raw.slice(name.length + 3);
};

const SEED = argOf('seed', (Math.random() * 0xffffffff) >>> 0);
const COUNT = argOf('count', 60);
const TIMEOUT = argOf('timeout', 8000);
const MODE = argStr('mode', 'all');
/** Общий потолок по времени: фаззер обязан закончиться сам, а не по Ctrl+C. */
const DEADLINE = Date.now() + argOf('minutes', 12) * 60_000;
const outOfTime = (): boolean => Date.now() > DEADLINE;

// ---- запуск потомков -------------------------------------------------------

/**
 * Живые потомки. Режимы намеренно запускают то, что может зависнуть
 * (незакрытая конструкция в интерактивном режиме, чтение из именованного канала),
 * поэтому при любом выходе всё запущенное гасится.
 */
const alive = new Set<ReturnType<typeof spawn>>();
const killAll = (): void => {
  for (const child of alive) { try { child.kill('SIGKILL'); } catch { /* уже умер */ } }
  alive.clear();
};
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => { killAll(); cleanup(); process.exit(130); });
}

type RunResult = {
  code: number | null;
  signal: string | null;
  out: string;
  timedOut: boolean;
  flood: boolean;
};

const OUTPUT_LIMIT = 4_000_000;

type RunOpts = {
  cwd?: string;
  env?: Record<string, string>;
  /** Что подать на stdin; undefined — вход сразу закрыт. */
  stdin?: string;
  timeout?: number;
};

function runCli(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const timeout = opts.timeout ?? TIMEOUT;
  return new Promise((resolve_) => {
    const child = spawn(process.execPath, ['--max-old-space-size=512', CLI, ...args], {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    alive.add(child);
    let out = '';
    let seen = 0;
    let timedOut = false;
    let flood = false;
    const cap = (chunk: Buffer): void => {
      seen += chunk.length;
      if (out.length < 400_000) out += chunk.toString('utf8');
      if (seen > OUTPUT_LIMIT && !flood) { flood = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    // Поток ввода закрывается сразу: иначе программа с input() ждала бы вечно,
    // а интерактивный режим не увидел бы конца файла и не вышел.
    child.stdin.on('error', () => { /* потомок закрыл вход раньше нас */ });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('error', () => {
      clearTimeout(timer);
      alive.delete(child);
      resolve_({ code: null, signal: null, out: out + '\nНЕ УДАЛОСЬ ЗАПУСТИТЬ', timedOut, flood });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      alive.delete(child);
      resolve_({ code, signal, out, timedOut, flood });
    });
  });
}

// ---- склад находок ---------------------------------------------------------

type Finding = {
  mode: string;
  category: string;
  detail: string;
  /** Как воспроизвести руками. */
  how: string;
  /** Содержимое участвовавших файлов: путь → текст. */
  files: Array<[string, string]>;
  out: string;
  seed: number;
};

const found = new Map<string, Finding>();
const counts = new Map<string, number>();

/** Подпись сбоя: числа и содержимое кавычек стёрты — иначе один дефект даст сто находок. */
const signature = (mode: string, category: string, detail: string): string =>
  `${mode}|${category}|${detail.replace(/\d+/g, '#').replace(/«[^»]*»/g, '«»').slice(0, 140)}`;

/**
 * Сколько случаев какого рода прогнано. Нужно не для красоты: без этого
 * «дефектов не найдено» не отличить от «ни один интересный случай не построился».
 */
const stats = new Map<string, number>();
const tick = (what: string): void => { stats.set(what, (stats.get(what) ?? 0) + 1); };

function report(f: Finding): void {
  const sig = signature(f.mode, f.category, f.detail);
  counts.set(sig, (counts.get(sig) ?? 0) + 1);
  if (found.has(sig)) return;
  found.set(sig, f);
  process.stdout.write(`  ! [${f.mode}] ${f.category}: ${f.detail} (зерно ${f.seed})\n`);
}

// ---- общие оракулы ---------------------------------------------------------

/** Ошибка sable обязана быть напечатана со стрелкой на исходник. */
const hasArrow = (text: string): boolean => text.includes('  --> ');

/**
 * То, что не должно вылезать наружу ни в одном режиме.
 * Возвращает описание дефекта или null.
 */
function baseTrouble(res: RunResult, allow: number[] = [0, 65, 70]): { category: string; detail: string } | null {
  if (res.flood) return { category: 'зависание', detail: 'бесконечный поток вывода' };
  if (res.timedOut) return { category: 'зависание', detail: 'не уложился в отведённое время' };
  if (res.signal !== null) return { category: 'сбой', detail: `процесс убит сигналом ${res.signal}` };
  if (res.code !== null && !allow.includes(res.code)) {
    return { category: 'сбой', detail: `неожиданный код возврата ${res.code}` };
  }
  for (const mark of JS_MARKERS) {
    if (res.out.includes(mark)) return { category: 'js-внутренности', detail: `в выводе «${mark}»` };
  }
  for (const mark of VALUE_MARKERS) {
    if (res.out.includes(mark)) return { category: 'дырявое-значение', detail: `в выводе «${mark}»` };
  }
  return null;
}

/**
 * Вывод без привязки к номерам строк: форматирование двигает код, поэтому
 * позиция в тексте ошибки и показанная строка исходника меняться вправе.
 * Всё остальное обязано совпасть дословно.
 */
function withoutPositions(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*\d* \|/.test(l))
    .map((l) => l.replace(/:\d+:\d+/g, ':строка:колонка'))
    .join('\n');
}

const firstLine = (t: string): string => t.split('\n').find((l) => l.trim() !== '')?.trim() ?? '(пусто)';

/** Разбор строки «  --> путь:строка:колонка». */
function arrowTarget(text: string): { file: string; line: number; col: number } | null {
  const m = /^ *--> (.*):(\d+):(\d+)$/m.exec(text);
  if (!m) return null;
  return { file: m[1]!, line: Number(m[2]), col: Number(m[3]) };
}

// ---- временная песочница ---------------------------------------------------

const SANDBOX = mkdtempSync(join(tmpdir(), 'sable-tools-'));
/** Права возвращаются на место перед удалением: иначе rm споткнётся о папку без «w». */
const restoreMode: Array<[string, number]> = [];

/** «--keep» оставляет песочницу на диске: без неё разбирать случай нечем. */
const KEEP = process.argv.includes('--keep');

function cleanup(): void {
  if (KEEP) { process.stdout.write(`песочница оставлена: ${SANDBOX}\n`); return; }
  for (const [p, mode] of restoreMode) { try { chmodSync(p, mode); } catch { /* уже нет */ } }
  restoreMode.length = 0;
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* уже нет */ }
}

let caseCounter = 0;
/** Своя папка на случай: файлы разных случаев не должны видеть друг друга. */
function caseDir(prefix: string): string {
  const dir = join(SANDBOX, `${prefix}-${caseCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(dir: string, rel: string, text: string): string {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
  return full;
}

// ============================================================================
// Режим 1: модули
// ============================================================================

type ModCase = {
  kind: string;
  /** Файлы набора: путь относительно папки случая → текст. */
  files: Array<[string, string]>;
  /** Точка входа. */
  main: string;
  /** Модули, чей маркер обязан появиться ровно один раз (для исправных наборов). */
  onceIds: string[];
  /**
   * Где ждём ошибку: файл набора и номер строки в нём.
   * `точно` = false для оборванного синтаксиса: разбор законно доезжает до конца
   * файла и показывает его последнюю строку — важно, что файл СВОЙ.
   */
  faultAt: { rel: string; line: number; text: string; точно: boolean } | null;
  /** Кусок, который обязан быть в тексте ошибки. */
  wants: string | null;
  /** Ждём ли чистого завершения. */
  clean: boolean;
};

/** Папки, по которым раскладываются модули: пути с пробелами и кириллицей тоже путь. */
const MOD_DIRS = ['', 'lib/', 'lib/глубже/', 'папка с пробелом/'];

/** Тело модуля: маркер выполнения, экспорты и немного случайного кода под try. */
function moduleBody(g: Gen, id: string, imports: string[]): { text: string; lines: string[] } {
  const lines: string[] = [];
  lines.push(`// модуль ${id}`);
  for (const imp of imports) lines.push(imp);
  // Маркер печатается безусловно и ровно один раз на выполнение файла.
  lines.push(`print("ЗАПУСК:${id}")`);
  lines.push(`const ${id}_знач = ${g.expr(g.r.pick(['number', 'string', 'list', 'map'] as const), 1)}`);
  lines.push(`fn ${id}_фн(a, b = 2) { return [a, b] }`);
  lines.push(`struct ${id}_Стр { поле1, поле2 = 0 }`);
  // Случайный код обёрнут в try: модуль обязан доработать до конца, иначе
  // проверка «выполнен ровно один раз» превратится в проверку «упал».
  lines.push('try {');
  const body: string[] = [];
  g.scoped(() => { for (const _ of g.r.times(1, 3)) g.statement('  ', 1, body); });
  lines.push(...body);
  lines.push('} catch {}');
  return { text: lines.join('\n') + '\n', lines };
}

function makeModuleCase(seed: number): ModCase {
  const r = new Rnd(seed);
  const g = new Gen(r);
  const kind = r.pick([
    'ок', 'ромб', 'цепочка', 'цикл', 'цикл-длинный', 'сам-себя',
    'нет-файла', 'ошибка-в-модуле', 'синтаксис-в-модуле', 'нет-имени',
    'папка-вместо-файла', 'два-алиаса',
  ]);

  const n = 2 + r.int(3);
  const ids = Array.from({ length: n }, (_, i) => `м${i + 1}`);
  const rels = ids.map((id) => `${r.pick(MOD_DIRS)}${id}.sable`);
  const files: Array<[string, string]> = [];
  const onceIds: string[] = [];
  let faultAt: ModCase['faultAt'] = null;
  let wants: string | null = null;
  let clean = true;

  /** Как записать путь к модулю `to` из файла `from`. */
  const pathTo = (from: string, to: string): string => {
    const p = relative(dirname(from), to);
    // «./» перед именем в той же папке — законная запись, проверяем и её.
    return r.chance(0.4) && !p.startsWith('.') ? `./${p}` : p;
  };
  const importOf = (from: string, i: number, alias = ids[i]!): string =>
    `import "${pathTo(from, rels[i]!)}" as ${alias}`;

  const mainRel = 'main.sable';
  const mainLines: string[] = ['// главный файл'];
  const bodies = new Map<string, string[]>();

  // Каждый модуль строится сам по себе; связи навешиваются ниже по виду случая.
  for (let i = 0; i < n; i++) {
    bodies.set(rels[i]!, moduleBody(g, ids[i]!, []).lines);
  }

  const addImportTo = (rel: string, line: string): void => {
    const lines = bodies.get(rel)!;
    lines.splice(1, 0, line);
  };

  if (kind === 'ок' || kind === 'два-алиаса') {
    for (let i = 0; i < n; i++) mainLines.push(importOf(mainRel, i));
    if (kind === 'два-алиаса') mainLines.push(importOf(mainRel, 0, 'ещёраз'));
    onceIds.push(...ids);
  } else if (kind === 'ромб') {
    // Общий модуль ids[0] подключён двумя разными — выполниться обязан один раз.
    for (let i = 1; i < n; i++) addImportTo(rels[i]!, importOf(rels[i]!, 0));
    for (let i = 1; i < n; i++) mainLines.push(importOf(mainRel, i));
    if (r.chance(0.5)) mainLines.push(importOf(mainRel, 0));
    onceIds.push(...ids);
  } else if (kind === 'цепочка') {
    for (let i = 0; i + 1 < n; i++) addImportTo(rels[i]!, importOf(rels[i]!, i + 1));
    mainLines.push(importOf(mainRel, 0));
    onceIds.push(...ids);
  } else if (kind === 'цикл') {
    addImportTo(rels[0]!, importOf(rels[0]!, 1));
    addImportTo(rels[1]!, importOf(rels[1]!, 0));
    mainLines.push(importOf(mainRel, 0));
    wants = 'циклический import';
    clean = false;
  } else if (kind === 'цикл-длинный') {
    for (let i = 0; i < n; i++) addImportTo(rels[i]!, importOf(rels[i]!, (i + 1) % n));
    mainLines.push(importOf(mainRel, 0));
    wants = 'циклический import';
    clean = false;
  } else if (kind === 'сам-себя') {
    addImportTo(rels[0]!, `import "${rels[0]!.split('/').pop()}" as сам`);
    mainLines.push(importOf(mainRel, 0));
    wants = 'циклический import';
    clean = false;
  } else if (kind === 'нет-файла') {
    mainLines.push(importOf(mainRel, 0));
    addImportTo(rels[0]!, `import "${r.pick(['нет.sable', './нет.sable', '../нет.sable', 'нет/и/тут.sable'])}" as пусто`);
    wants = 'не удалось прочитать модуль';
    clean = false;
  } else if (kind === 'папка-вместо-файла') {
    mainLines.push(`import "${r.pick(['.', './', 'lib', '..'])}" as папка`);
    wants = 'не удалось прочитать модуль';
    clean = false;
  } else if (kind === 'ошибка-в-модуле') {
    // Ошибка сажается в конец модуля, ниже маркеров: до неё файл должен доработать.
    const victim = 1 + r.int(n - 1);
    const bad = r.pick([
      'let сломано = 1 + nil',
      'let сломано = [1, 2][10]',
      'let сломано = нетТакогоИмени',
      'let сломано = error("изнутри модуля")',
      'let сломано = 1 / 0',
    ]);
    const lines = bodies.get(rels[victim]!)!;
    lines.push(bad);
    faultAt = { rel: rels[victim]!, line: lines.length, text: bad, точно: true };
    for (let i = 0; i < n; i++) mainLines.push(importOf(mainRel, i));
    clean = false;
  } else if (kind === 'синтаксис-в-модуле') {
    const victim = 1 + r.int(n - 1);
    const bad = r.pick(['let сломано = ', 'fn( {', 'print(1', 'let = 5', '} }']);
    const lines = bodies.get(rels[victim]!)!;
    lines.push(bad);
    faultAt = { rel: rels[victim]!, line: lines.length, text: bad, точно: false };
    for (let i = 0; i < n; i++) mainLines.push(importOf(mainRel, i));
    clean = false;
  } else if (kind === 'нет-имени') {
    mainLines.push(importOf(mainRel, 0));
    mainLines.push(`print(${ids[0]!}.${r.pick(['нетТакого', `${ids[0]!}_знач_`, 'поле1', 'знач'])})`);
    wants = 'нет имени';
    clean = false;
  }

  // Обращения к экспортам подключённых модулей — иначе импорт ничего не проверяет.
  if (clean) {
    for (let i = 0; i < n; i++) {
      if (!mainLines.some((l) => l.includes(` as ${ids[i]!}`))) continue;
      mainLines.push(`print(${ids[i]!}.${ids[i]!}_знач)`);
      mainLines.push(`print(${ids[i]!}.${ids[i]!}_фн(1))`);
      mainLines.push(`print(${ids[i]!}.${ids[i]!}_Стр(7).поле1)`);
    }
    mainLines.push('print("ЗАПУСК:main")');
  }

  for (const [rel, lines] of bodies) files.push([rel, lines.join('\n') + '\n']);
  files.push([mainRel, mainLines.join('\n') + '\n']);
  return { kind, files, main: mainRel, onceIds, faultAt, wants, clean };
}

async function huntModules(seed: number): Promise<void> {
  const c = makeModuleCase(seed);
  const dir = caseDir('mod');
  for (const [rel, text] of c.files) put(dir, rel, text);
  const mainFull = join(dir, c.main);

  const fail = (category: string, detail: string, out: string): void => {
    report({
      mode: 'modules', category, detail, seed,
      how: `вид «${c.kind}»: node src/cli.ts <папка>/${c.main}`,
      files: c.files, out,
    });
  };

  tick(`modules: ${c.kind}`);
  const res = await runCli([mainFull], { cwd: dir });
  const trouble = baseTrouble(res);
  if (trouble) { fail(trouble.category, `${c.kind}: ${trouble.detail}`, res.out); return; }

  // 1. Ошибка обязана быть напечатана со стрелкой на исходник.
  if (res.code !== 0 && !hasArrow(res.out)) {
    fail('ошибка-без-стрелки', `${c.kind}: ${firstLine(res.out)}`, res.out);
    return;
  }

  // 2. Ожидаемый текст ошибки: цикл, отсутствующий файл, отсутствующее имя.
  if (c.wants !== null && !res.out.includes(c.wants)) {
    fail('не-та-ошибка', `${c.kind}: ждали «${c.wants}», получили «${firstLine(res.out)}»`, res.out);
    return;
  }
  if (c.wants !== null && res.code === 0) {
    fail('ошибка-не-случилась', `${c.kind}: ждали «${c.wants}», программа отработала чисто`, res.out);
    return;
  }

  // 3. Цикл обязан показать всю цепочку, а не одно имя.
  if (c.wants === 'циклический import') {
    const chain = res.out.split('\n').find((l) => l.includes('циклический import')) ?? '';
    if (!chain.includes('→')) {
      fail('цикл-без-цепочки', `${c.kind}: «${chain.trim()}»`, res.out);
      return;
    }
  }

  // 4. Ошибка внутри модуля обязана показывать строку СВОЕГО файла.
  if (c.faultAt !== null) {
    const at = arrowTarget(res.out);
    if (at === null) {
      fail('ошибка-без-стрелки', `${c.kind}: ${firstLine(res.out)}`, res.out);
      return;
    }
    const want = resolve(dir, c.faultAt.rel);
    if (resolve(dir, at.file) !== want) {
      fail(
        'ошибка-показала-чужой-файл',
        `${c.kind}: ждали ${c.faultAt.rel}, стрелка на ${at.file}`,
        res.out,
      );
      return;
    }
    const lineOk = c.faultAt.точно ? at.line === c.faultAt.line : at.line >= c.faultAt.line;
    if (!lineOk) {
      fail(
        'ошибка-показала-чужую-строку',
        `${c.kind}: ждали строку ${c.faultAt.line} (${JSON.stringify(c.faultAt.text)}), показана ${at.line}`,
        res.out,
      );
      return;
    }
    // Показанный кусок исходника обязан быть строкой ИМЕННО этого файла.
    const shown = res.out.split('\n').find((l) => /^\s*\d+ \| /.test(l));
    if (c.faultAt.точно && shown !== undefined && c.faultAt.text.trim() !== '' && !shown.includes(c.faultAt.text.trim())) {
      fail(
        'показана-строка-не-того-файла',
        `${c.kind}: ждали ${JSON.stringify(c.faultAt.text)}, показано ${JSON.stringify(shown.trim())}`,
        res.out,
      );
      return;
    }
  }

  // 5. Модуль выполняется ровно один раз, сколько бы файлов его ни подключило.
  if (c.clean) {
    if (res.code !== 0) {
      fail('исправный-набор-упал', `${c.kind}: ${firstLine(res.out)}`, res.out);
      return;
    }
    for (const id of c.onceIds) {
      const times = res.out.split('\n').filter((l) => l === `ЗАПУСК:${id}`).length;
      if (times !== 1) {
        fail('модуль-выполнен-не-один-раз', `${c.kind}: маркер модуля ${id} встретился ${times} раз(а)`, res.out);
        return;
      }
    }
  }

  // 6. Повторный прогон обязан дать тот же вывод: загрузчик не должен зависеть
  //    от порядка обхода кэша.
  const again = await runCli([mainFull], { cwd: dir });
  if (again.out !== res.out || again.code !== res.code) {
    fail('прогон-не-повторяется', `${c.kind}: два одинаковых запуска дали разный вывод`,
      `--- первый ---\n${res.out}\n--- второй ---\n${again.out}`);
    return;
  }

  // 7. «--check» не имеет права ругаться на исправный набор.
  if (c.clean) {
    const chk = await runCli(['--check', mainFull], { cwd: dir });
    const chkTrouble = baseTrouble(chk);
    if (chkTrouble) { fail(chkTrouble.category, `--check, ${c.kind}: ${chkTrouble.detail}`, chk.out); return; }
    if (chk.code === 65) {
      fail('ложная-тревога', `${c.kind}: --check ругается на рабочий набор: ${firstLine(chk.out)}`, chk.out);
      return;
    }
  }

  // 8. Форматирование любого файла набора не должно менять поведение программы.
  if (c.clean) {
    tick('modules: набор прошёл fmt-круг');
    for (const [rel] of c.files) {
      const full = join(dir, rel);
      const fmt = await runCli(['fmt', full], { cwd: dir });
      if (fmt.code !== 0) {
        fail('модуль-не-форматируется', `${c.kind}: ${rel}: ${firstLine(fmt.out)}`, fmt.out);
        return;
      }
      writeFileSync(full, fmt.out, 'utf8');
    }
    const after = await runCli([mainFull], { cwd: dir });
    if (withoutPositions(after.out) !== withoutPositions(res.out) || after.code !== res.code) {
      fail('форматирование-изменило-поведение', `${c.kind}: вывод после fmt отличается`,
        `--- до ---\n${res.out}\n--- после ---\n${after.out}`);
    }
  }
}

// ============================================================================
// Режим 2: форматтер как оракул
// ============================================================================

/** Комментарии, которыми засеваются программы: форматтер не вправе потерять ни один. */
const COMMENT_TEXTS = [
  '// заметка',
  '//',
  '// TODO: подумать',
  '//// четыре косые',
  '// кириллица, oʻzbekcha, 😀',
  '// "кавычка и ${вставка}',
  '// */ и /* внутри',
  '//    отступ в конце   ',
  '// }',
];

/**
 * Насыпать комментариев в готовый исходник. Строки генератора — законченные
 * инструкции, поэтому «// …» в конце любой из них безопасен; строк, оборванных
 * посреди литерала, генератор не делает.
 */
function injectComments(source: string, r: Rnd): string {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    if (line === '') { out.push(line); continue; }
    if (r.chance(0.12)) {
      const indent = /^\s*/.exec(line)![0];
      out.push(indent + r.pick(COMMENT_TEXTS));
    }
    out.push(r.chance(0.12) ? `${line} ${r.pick(COMMENT_TEXTS)}` : line);
  }
  if (r.chance(0.3)) out.push(r.pick(COMMENT_TEXTS));
  return out.join('\n');
}

/** sourceComments из проверяемого среза кода — грузим один раз и лениво. */
let commentsOf: ((src: string) => string[]) | null = null;
async function loadCommentScanner(): Promise<(src: string) => string[]> {
  if (commentsOf === null) {
    const mod = await import(pathToFileURL(join(ROOT, 'src', 'format.ts')).href) as {
      sourceComments: (src: string) => string[];
    };
    commentsOf = mod.sourceComments;
  }
  return commentsOf;
}

async function huntFormatter(seed: number): Promise<void> {
  const r = new Rnd(seed ^ 0x5bf03635);
  const raw = generate(seed);
  const source = injectComments(raw, r);
  const dir = caseDir('fmt');
  const src = put(dir, 'исходный.sable', source);

  const fail = (category: string, detail: string, out: string, extra: Array<[string, string]> = []): void => {
    report({
      mode: 'fmt', category, detail, seed,
      how: `node tests/fuzz-tools.ts --mode=fmt --seed=${seed} --count=1`,
      files: [['исходный.sable', source], ...extra], out,
    });
  };

  // 1. Форматтер обязан принять всё, что принимает интерпретатор.
  const fmt1 = await runCli(['fmt', src], { cwd: dir });
  const t1 = baseTrouble(fmt1);
  if (t1) { fail(t1.category, `fmt: ${t1.detail}`, fmt1.out); return; }
  if (fmt1.code !== 0) {
    fail('fmt-отверг-рабочую-программу', firstLine(fmt1.out), fmt1.out);
    return;
  }
  const once = fmt1.out;

  // 2. Отформатированное обязано снова разбираться и форматироваться в себя же.
  const dst = put(dir, 'после.sable', once);
  const fmt2 = await runCli(['fmt', dst], { cwd: dir });
  const t2 = baseTrouble(fmt2);
  if (t2) { fail(t2.category, `fmt повторно: ${t2.detail}`, fmt2.out, [['после.sable', once]]); return; }
  if (fmt2.code !== 0) {
    fail('отформатированное-не-разбирается', firstLine(fmt2.out), fmt2.out, [['после.sable', once]]);
    return;
  }
  if (fmt2.out !== once) {
    const at = firstDiffLine(once, fmt2.out);
    fail('fmt-не-идемпотентен', at, `--- первый проход ---\n${once}\n--- второй ---\n${fmt2.out}`,
      [['после.sable', once]]);
    return;
  }

  // 3. «fmt -c» на уже отформатированном обязан молчать.
  const verify = await runCli(['fmt', '-c', dst], { cwd: dir });
  if (verify.code !== 0) {
    fail('fmt--c-краснеет-на-своём-выводе', firstLine(verify.out), verify.out, [['после.sable', once]]);
    return;
  }

  // 4. Ни один комментарий не потерян и порядок сохранён.
  const scan = await loadCommentScanner();
  let before: string[];
  let after: string[];
  try {
    before = scan(source);
    after = scan(once);
  } catch (e) {
    fail('сканер-комментариев-упал', String((e as Error).message), String((e as Error).stack ?? ''));
    return;
  }
  if (before.length !== after.length || before.some((c, i) => c.trim() !== (after[i] ?? '').trim())) {
    const lost = before.filter((c) => !after.some((a) => a.trim() === c.trim()));
    fail(
      'комментарии-потерялись',
      lost.length ? `пропало ${lost.length}: ${JSON.stringify(lost.slice(0, 3))}` : `порядок изменился (${before.length} → ${after.length})`,
      `--- до ---\n${JSON.stringify(before, null, 1)}\n--- после ---\n${JSON.stringify(after, null, 1)}`,
      [['после.sable', once]],
    );
    return;
  }

  tick('fmt: комментарии сверены');
  // 5. Главное: программа после форматирования печатает ровно то же.
  const r1 = await runCli([src], { cwd: dir });
  if (r1.timedOut || r1.flood) return; // долгая программа — не вина форматтера
  const t3 = baseTrouble(r1);
  if (t3) { fail(t3.category, `исходная программа: ${t3.detail}`, r1.out); return; }

  const r2 = await runCli([dst], { cwd: dir });
  if (r2.timedOut || r2.flood) {
    fail('после-fmt-программа-зависла', 'до форматирования укладывалась в срок', r2.out, [['после.sable', once]]);
    return;
  }
  const t4 = baseTrouble(r2);
  if (t4) { fail(t4.category, `после fmt: ${t4.detail}`, r2.out, [['после.sable', once]]); return; }

  tick('fmt: вывод сверен до и после');
  const a = withoutPositions(r1.out);
  const b = withoutPositions(r2.out);
  if (a !== b || r1.code !== r2.code) {
    fail(
      'fmt-изменил-поведение',
      a === b ? `код возврата ${r1.code} → ${r2.code}` : firstDiffLine(a, b),
      `--- до ---\n${r1.out}\n--- после ---\n${r2.out}`,
      [['после.sable', once]],
    );
  }
}

function firstDiffLine(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] === a[i]) continue;
    return `строка ${i + 1}: было ${JSON.stringify(e[i] ?? null)}, стало ${JSON.stringify(a[i] ?? null)}`;
  }
  return 'тексты совпадают';
}

// ============================================================================
// Режим 3: согласованность --check с выполнением
// ============================================================================

/** Сообщения, за которые статическая проверка отвечает по документации. */
const CHECKER_OWNED = /не определено|уже объявлено|через const — менять нельзя|вне цикла|вне функции|ожидает .* аргумент/;

/**
 * Заведомо неправильные вставки: анализатор обязан увидеть каждую по одному
 * лишь тексту. Вставляются в конец программы верхнего уровня, где им ничего
 * не мешает; `нужен` — кусок сообщения, которое ждём.
 */
const BROKEN_INSERTS: Array<{ code: string; нужен: RegExp; note: string }> = [
  { code: 'print(этогоИмениНет)', нужен: /не определено/, note: 'обращение к необъявленному имени' },
  { code: 'const незыблемое = 1\nнезыблемое = 2', нужен: /const/, note: 'запись в const' },
  { code: 'let дважды = 1\nlet дважды = 2', нужен: /уже объявлено/, note: 'повторное объявление' },
  { code: 'break', нужен: /вне цикла/, note: 'break вне цикла' },
  { code: 'continue', нужен: /вне цикла/, note: 'continue вне цикла' },
  { code: 'return 1', нужен: /вне функции/, note: 'return вне функции' },
  { code: 'fn ждётДва(a, b) { return a }\nждётДва(1)', нужен: /аргумент/, note: 'мало аргументов' },
  { code: 'fn ждётОдин(a) { return a }\nждётОдин(1, 2, 3)', нужен: /аргумент/, note: 'много аргументов' },
];

async function huntChecker(seed: number): Promise<void> {
  const r = new Rnd(seed ^ 0x2f9a1c33);
  const source = generate(seed);
  const dir = caseDir('chk');
  const src = put(dir, 'проверяемый.sable', source);

  const fail = (category: string, detail: string, out: string, files: Array<[string, string]>): void => {
    report({
      mode: 'check', category, detail, seed,
      how: `node tests/fuzz-tools.ts --mode=check --seed=${seed} --count=1`,
      files, out,
    });
  };

  const chk = await runCli(['--check', src], { cwd: dir });
  const t = baseTrouble(chk);
  if (t) { fail(t.category, `--check: ${t.detail}`, chk.out, [['проверяемый.sable', source]]); return; }

  const run = await runCli([src], { cwd: dir });
  if (run.timedOut || run.flood) return;
  const t2 = baseTrouble(run);
  if (t2) { fail(t2.category, `запуск: ${t2.detail}`, run.out, [['проверяемый.sable', source]]); return; }

  // 1. Ложная тревога: анализатор ругается, а программа работает.
  //    Генератор по построению не пишет некорректный код, поэтому ОШИБКА тут
  //    всегда ложная — и это хуже пропуска.
  if (chk.code === 65 && run.code === 0) {
    const line = chk.out.split('\n').find((l) => l.startsWith('Ошибка:')) ?? firstLine(chk.out);
    fail('ложная-тревога', line, chk.out, [['проверяемый.sable', source]]);
    return;
  }

  // 2. Пропуск: программа упала на том, что анализатор обязан видеть по тексту.
  if (chk.code !== 65 && run.code === 70 && CHECKER_OWNED.test(run.out)) {
    fail('пропуск-анализатора', firstLine(run.out), run.out, [['проверяемый.sable', source]]);
    return;
  }

  // 3. Форматирование не меняет смысла — значит и вердикт анализатора обязан
  //    остаться тем же. Расхождение означает, что парсер видит один текст двумя
  //    разными деревьями.
  const fmt = await runCli(['fmt', src], { cwd: dir });
  if (fmt.code === 0) {
    const dst = put(dir, 'после.sable', fmt.out);
    const chk2 = await runCli(['--check', dst], { cwd: dir });
    const a = withoutPositions(chk.out).replace(/^\S+: (ошибок|замечаний)/m, '');
    const b = withoutPositions(chk2.out).replace(/^\S+: (ошибок|замечаний)/m, '');
    const norm = (s: string): string => s.replace(/^.*(?:\.sable): /gm, '');
    if (chk.code !== chk2.code || norm(a) !== norm(b)) {
      fail(
        'вердикт-анализатора-плывёт-от-fmt',
        `код ${chk.code} → ${chk2.code}; ${firstDiffLine(norm(a), norm(b))}`,
        `--- до ---\n${chk.out}\n--- после ---\n${chk2.out}`,
        [['проверяемый.sable', source], ['после.sable', fmt.out]],
      );
      return;
    }
  }

  // 4. Обратное направление: заведомо сломанную вставку анализатор обязан
  //    увидеть. Молчание — пропуск, о котором иначе никто не узнает.
  tick('check: вердикт сверен до и после fmt');
  const broken = r.pick(BROKEN_INSERTS);
  const spoiled = source + broken.code + '\n';
  const bad = put(dir, 'сломанный.sable', spoiled);
  const chk3 = await runCli(['--check', bad], { cwd: dir });
  const t3 = baseTrouble(chk3);
  if (t3) { fail(t3.category, `--check на сломанном: ${t3.detail}`, chk3.out, [['сломанный.sable', spoiled]]); return; }
  tick(`check: вставка «${broken.note}»`);
  const said = chk3.out.split('\n').filter((l) => l.startsWith('Ошибка:'));
  if (!said.some((l) => broken.нужен.test(l))) {
    fail(
      'анализатор-не-увидел',
      `${broken.note}: ${said.length ? `сказал «${said[0]!.trim()}»` : 'промолчал'}`,
      chk3.out,
      [['сломанный.sable', spoiled]],
    );
  }
}

// ============================================================================
// Режим 4: read_file / write_file
// ============================================================================

/** Заготовки в песочнице, к которым обращаются сгенерированные программы. */
type FileWorld = { dir: string; paths: Record<string, string> };

function buildFileWorld(): FileWorld {
  const dir = caseDir('files');
  const paths: Record<string, string> = {};

  paths.обычный = put(dir, 'обычный.txt', 'первая\nвторая\nтретья\n');
  paths.пустой = put(dir, 'пустой.txt', '');
  paths.юникод = put(dir, 'юникод.txt', 'oʻzbekcha 😀 кириллица\n');

  // Большой файл: интересен не содержимым, а размером — на нём видно,
  // не ломается ли чтение о лимиты строк JS.
  writeFileSync(join(dir, 'большой.txt'), 'строка данных\n'.repeat(400_000), 'utf8');
  paths.большой = join(dir, 'большой.txt');

  // Ломаные байты: utf8 их не декодирует, и это не повод показывать стек JS.
  writeFileSync(join(dir, 'кривой.bin'), Buffer.from([0xff, 0xfe, 0x41, 0x80, 0x0a, 0xc3, 0x28]));
  paths.кривой = join(dir, 'кривой.bin');

  writeFileSync(join(dir, 'нули.bin'), Buffer.from([0x41, 0x00, 0x42, 0x0a]));
  paths.нули = join(dir, 'нули.bin');

  mkdirSync(join(dir, 'папка'), { recursive: true });
  paths.папка = join(dir, 'папка');

  // Папка без права записи — сюда писать нельзя, и это обязана быть ошибка sable.
  const ro = join(dir, 'только-чтение');
  mkdirSync(ro, { recursive: true });
  put(dir, 'только-чтение/внутри.txt', 'нельзя переписать\n');
  restoreMode.push([ro, 0o755]);
  chmodSync(ro, 0o500);
  paths.толькоЧтение = join(ro, 'новый.txt');
  paths.внутриТолькоЧтение = join(ro, 'внутри.txt');

  try {
    symlinkSync(join(dir, 'петля'), join(dir, 'петля'));
    paths.петля = join(dir, 'петля');
  } catch { /* нет прав на ссылки — не беда */ }

  paths.нет = join(dir, 'нет-такого.txt');
  paths.длинный = join(dir, 'д'.repeat(300) + '.txt');
  paths.новый = join(dir, 'новый.txt');
  paths.вложенныйНет = join(dir, 'нет', 'папки', 'файл.txt');
  paths.устройство = '/dev/null';
  paths.корень = '/';

  return { dir, paths };
}

/** Строки, которые пишем и читаем обратно: круговой оборот обязан быть точным. */
const ROUNDTRIP_TEXTS = [
  '""',
  '"простая строка"',
  '"строка\\nс переводом"',
  '"oʻzbekcha \\u{1F600} и кириллица"',
  '"табы\\tи\\rвозвраты"',
  '"кавычки \\" и слэш \\\\"',
  '("длинная " * 1000)',
];

function makeFileProgram(r: Rnd, w: FileWorld): { code: string; note: string } {
  const q = (p: string): string => JSON.stringify(p);
  const kind = r.pick(['чтение', 'чтение-в-try', 'запись', 'оборот', 'запись-и-чтение', 'дичь']);

  if (kind === 'чтение') {
    const key = r.pick(Object.keys(w.paths));
    return { code: `let текст = read_file(${q(w.paths[key]!)})\nprint(type(текст), len(текст))\n`, note: `read_file(${key})` };
  }
  if (kind === 'чтение-в-try') {
    const key = r.pick(Object.keys(w.paths));
    return {
      code: `try {\n  let т = read_file(${q(w.paths[key]!)})\n  print("прочитано", len(т))\n} catch e {\n  print("поймано:", e.message, type(e.value))\n}\n`,
      note: `try read_file(${key})`,
    };
  }
  if (kind === 'запись') {
    const key = r.pick(['новый', 'толькоЧтение', 'внутриТолькоЧтение', 'папка', 'вложенныйНет', 'длинный', 'устройство', 'корень', 'нет']);
    return { code: `write_file(${q(w.paths[key]!)}, ${r.pick(ROUNDTRIP_TEXTS)})\nprint("записано")\n`, note: `write_file(${key})` };
  }
  if (kind === 'оборот' || kind === 'запись-и-чтение') {
    const text = r.pick(ROUNDTRIP_TEXTS);
    const p = join(w.dir, `оборот-${r.int(1000)}.txt`);
    return {
      code: [
        `let было = ${text}`,
        `write_file(${q(p)}, было)`,
        `let стало = read_file(${q(p)})`,
        `if стало != было { print("ИНВАРИАНТ: круговой оборот файла испортил текст:", len(было), len(стало)) }`,
        `print("оборот ок", len(стало))`,
      ].join('\n') + '\n',
      note: 'запись и чтение обратно',
    };
  }
  // Дичь: аргументы, которых быть не должно.
  const wild = r.pick([
    'read_file("")',
    'read_file(".")',
    'read_file(nil)',
    'read_file(42)',
    'read_file([1, 2])',
    'read_file("файл\\u{0}с нулём")',
    'write_file("", "x")',
    'write_file(nil, "x")',
    'write_file("/нет/такой/папки/ф.txt", "x")',
    `write_file(${q(join(w.dir, 'дичь.txt'))}, nil)`,
    `write_file(${q(join(w.dir, 'дичь.txt'))}, [1, {a: 2}])`,
    `write_file(${q(join(w.dir, 'дичь.txt'))}, x -> x)`,
  ]);
  return { code: `print(${wild.startsWith('write_file') ? `type(${wild})` : wild})\n`, note: wild };
}

async function huntFiles(seed: number, world: FileWorld): Promise<void> {
  const r = new Rnd(seed ^ 0x7c1e55a1);
  const { code, note } = makeFileProgram(r, world);
  const dir = caseDir('fileprog');
  const src = put(dir, 'работа.sable', code);

  const fail = (category: string, detail: string, out: string): void => {
    report({
      mode: 'files', category, detail, seed,
      how: `сценарий «${note}»`,
      files: [['работа.sable', code]], out,
    });
  };

  tick(`files: ${note.replace(/\(.*/, '')}`);
  const res = await runCli([src], { cwd: dir, timeout: Math.max(TIMEOUT, 10_000) });
  const t = baseTrouble(res, [0, 70]);
  if (t) { fail(t.category, `${note}: ${t.detail}`, res.out); return; }

  if (res.code === 70) {
    // Провал обязан выглядеть как ошибка sable: заголовок, путь, строка, стрелка.
    if (!hasArrow(res.out)) { fail('ошибка-без-стрелки', `${note}: ${firstLine(res.out)}`, res.out); return; }
    if (!/^Ошибка (выполнения|синтаксиса|разбора символов):/m.test(res.out)) {
      fail('чужой-вид-ошибки', `${note}: ${firstLine(res.out)}`, res.out);
      return;
    }
  }
  if (res.out.includes('ИНВАРИАНТ:')) {
    fail('инвариант', res.out.split('\n').find((l) => l.includes('ИНВАРИАНТ:'))!.trim(), res.out);
  }
}

// ============================================================================
// Режим 5: input()
// ============================================================================

async function huntInput(seed: number): Promise<void> {
  const r = new Rnd(seed ^ 0x11f0a3b7);
  const dir = caseDir('input');
  const code = r.pick([
    'let a = input()\nprint(type(a), repr(a))\n',
    'let a = input("вопрос: ")\nprint(repr(a))\n',
    'for i in 0..5 { print(i, repr(input())) }\n',
    'let a = input()\nlet b = input()\nprint(repr(a), repr(b))\n',
    'while true { let s = input(); if s == nil { break }; print(len(s)) }\n',
    'print(repr(input()), repr(input()), repr(input()))\n',
  ]);
  const feed = r.pick([
    undefined,                                   // вход закрыт сразу
    '',                                          // пустой поток
    '\n',                                        // пустая строка
    'одна строка\n',
    'без перевода в конце',
    'первая\nвторая\nтретья\n',
    'кириллица и oʻzbekcha 😀\n',
    '\r\nстрока с возвратом\r\n',
    'ю'.repeat(200_000) + '\n',                  // очень длинная строка
    Buffer.from([0xff, 0xfe, 0x41, 0x0a]).toString('latin1'),
    ' нулевой байт\n',
  ]);
  const src = put(dir, 'ввод.sable', code);

  tick('input: сценарий');
  const res = await runCli([src], { cwd: dir, stdin: feed });
  const t = baseTrouble(res, [0, 70]);
  if (t) {
    report({
      mode: 'input', category: t.category, detail: t.detail, seed,
      how: `stdin = ${JSON.stringify((feed ?? '<закрыт>').slice(0, 40))}`,
      files: [['ввод.sable', code]], out: res.out,
    });
    return;
  }
  if (res.code === 70 && !hasArrow(res.out)) {
    report({
      mode: 'input', category: 'ошибка-без-стрелки', detail: firstLine(res.out), seed,
      how: `stdin = ${JSON.stringify((feed ?? '<закрыт>').slice(0, 40))}`,
      files: [['ввод.sable', code]], out: res.out,
    });
  }
}

// ============================================================================
// Режим 6: интерактивный режим
// ============================================================================

/** Строки, из которых собирается сеанс. Половина — заведомо кривые. */
const REPL_LINES: string[] = [
  'let x = 1',
  'x + 1',
  'print("привет")',
  '1 / 0',
  'нетТакогоИмени',
  'fn f(a) { return a * 2 }',
  'f(21)',
  '[1, 2, 3].map(y -> y * y)',
  '({a: 1, b: 2})',
  'let x = 1',                       // повторное объявление
  'struct S { поле }',
  'S(1).поле',
  ':помощь',
  ':имена',
  ':время',
  ':время 2 + 2',
  ':время let z =',
  ':очистить',
  ':неизвестная',
  ':',
  '::',
  ':выход и хвост',
  'if true {',
  'let m = {',
  'print(',
  '[1, 2,',
  'fn g() {',
  '} } }',
  ')',
  'try {',
  'for i in 0..3 {',
  '   ',
  '',
  '// один комментарий',
  '"незакрытая строка',
  '`незакрытый много строк',
  '\\',
  '@#$%^&',
  '§±≠',
  'let у = "ю".repeat(100000)',
  'x'.repeat(50_000),
  '((((((((((1))))))))))',
  '('.repeat(200),
  'error("своя ошибка")',
  'assert(false, "проверка")',
  'input()',
];

function makeReplScript(r: Rnd): string {
  const lines: string[] = [];
  for (const _ of r.times(4, 14)) lines.push(r.pick(REPL_LINES));
  // Сеанс завершается заведомо исправной строкой: её вывод показывает,
  // что режим пережил всё, что было выше.
  lines.push('print("СЕАНС-ЖИВ")');
  return lines.join('\n') + '\n';
}

async function huntRepl(seed: number): Promise<void> {
  const r = new Rnd(seed ^ 0x3a77b19d);
  const script = makeReplScript(r);
  const dir = caseDir('repl');
  // Своя домашняя папка: настоящий ~/.sable_history трогать нельзя.
  const home = join(dir, 'дом');
  mkdirSync(home, { recursive: true });

  tick('repl: сеанс');
  const res = await runCli([], { cwd: dir, stdin: script, env: { HOME: home, USERPROFILE: home } });

  const fail = (category: string, detail: string): void => {
    report({
      mode: 'repl', category, detail, seed,
      how: 'подать сеанс на stdin: printf ... | sable',
      files: [['сеанс.txt', script]], out: res.out,
    });
  };

  const t = baseTrouble(res, [0]);
  if (t) { fail(t.category, t.detail); return; }

  // Незакрытая конструкция имеет право утянуть за собой хвост сеанса:
  // это документированное продолжение ввода. Но если ничего незакрытого не
  // было, последняя строка обязана выполниться.
  const opened = script.split('\n').some((l) => /[{(\[]\s*$/.test(l) || /^[^"]*"[^"]*$/.test(l) || l.includes('`'));
  if (!opened && !res.out.includes('СЕАНС-ЖИВ')) {
    fail('сеанс-не-дожил-до-конца', 'последняя исправная строка не выполнилась');
    return;
  }
  // История обязана лечь в подменённую домашнюю папку, а не в настоящую.
  if (res.out.includes('.sable_history') && !res.out.includes(home)) {
    fail('история-мимо-подменённого-дома', 'в выводе путь к чужой истории');
  }
}

// ---- главный цикл ----------------------------------------------------------

type Hunt = { name: string; step: (seed: number) => Promise<void> };

async function main(): Promise<number> {
  process.stdout.write(
    `sable fuzz-tools — зерно ${SEED}, случаев на режим ${COUNT}, таймаут ${TIMEOUT} мс\n` +
    `проверяемый срез: ${CLI}\n\n`,
  );

  let world: FileWorld | null = null;
  const hunts: Hunt[] = [
    { name: 'modules', step: huntModules },
    { name: 'fmt', step: huntFormatter },
    { name: 'check', step: huntChecker },
    { name: 'files', step: async (s: number) => { world ??= buildFileWorld(); await huntFiles(s, world); } },
    { name: 'input', step: huntInput },
    { name: 'repl', step: huntRepl },
  ].filter((h) => MODE === 'all' || MODE === h.name);

  if (hunts.length === 0) {
    process.stdout.write(`неизвестный режим «${MODE}»; есть: all, modules, fmt, check, files, input, repl\n`);
    return 2;
  }

  for (const hunt of hunts) {
    process.stdout.write(`— ${hunt.name}\n`);
    const seeds = Array.from({ length: COUNT }, (_, i) => (SEED + i * 2654435761) >>> 0);
    let done = 0;
    // Потоки: четыре потомка одновременно; больше упирается в диск песочницы.
    const worker = async (): Promise<void> => {
      for (;;) {
        if (outOfTime()) return;
        const seed = seeds.pop();
        if (seed === undefined) return;
        try {
          await hunt.step(seed);
        } catch (e) {
          // Падение самого фаззера — тоже находка: значит вылезло то,
          // чего мы не предусмотрели.
          report({
            mode: hunt.name, category: 'фаззер-споткнулся', detail: String((e as Error).message), seed,
            how: `node tests/fuzz-tools.ts --mode=${hunt.name} --seed=${seed} --count=1`,
            files: [], out: String((e as Error).stack ?? ''),
          });
        }
        done++;
        if (done % 20 === 0) process.stdout.write(`  прогнано ${done}/${COUNT}\n`);
      }
    };
    await Promise.all(Array.from({ length: 4 }, () => worker()));
    if (outOfTime()) { process.stdout.write('  (время вышло — режим прерван)\n'); break; }
  }

  process.stdout.write('\nЧто прогнано:\n');
  for (const [what, n] of [...stats].sort()) process.stdout.write(`  ${what}: ${n}\n`);

  process.stdout.write(`\nРазных дефектов: ${found.size}\n`);
  if (found.size === 0) {
    process.stdout.write('Дефектов не найдено.\n');
    cleanup();
    return 0;
  }

  mkdirSync(FINDINGS, { recursive: true });
  let i = 0;
  for (const [sig, f] of found) {
    i++;
    process.stdout.write(`\n[${i}] [${f.mode}] ${f.category}: ${f.detail}\n`);
    process.stdout.write(`    встретилось раз: ${counts.get(sig)}; ${f.how}\n`);
    const parts = [
      `// Найдено: tests/fuzz-tools.ts --mode=${f.mode} --seed=${f.seed}`,
      `// Класс: ${f.category}`,
      `// Признак: ${f.detail}`,
      `// Как повторить: ${f.how}`,
      '// Ожидалось: результат или ошибка sable со стрелкой; получено — см. ниже.',
      '',
      '// ---- вывод ----',
      ...f.out.split('\n').slice(0, 40).map((l) => `//   ${l}`),
      '',
    ];
    for (const [rel, text] of f.files) {
      parts.push(`// ======== файл ${rel} ========`, text);
    }
    const name = `tools_${String(i).padStart(2, '0')}_${f.mode}_${f.category}.sable`;
    writeFileSync(join(FINDINGS, name), parts.join('\n'), 'utf8');
    process.stdout.write(`    → tests/fuzz-findings/${name}\n`);
  }

  cleanup();
  return 1;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  cleanup();
  process.stderr.write(`фаззер упал: ${(e as Error).stack}\n`);
  process.exitCode = 3;
});
