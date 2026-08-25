// Глобальные объекты Node, которых нет в браузере.
//
// Интерпретатор читает `process.env` при загрузке модуля, а стандартная
// библиотека трогает `Buffer` в `input()`. В браузере обоих нет, и без этих
// заглушек воркер падал бы с `ReferenceError` — то есть внутренностями наружу,
// ровно тем, чего язык не допускает в своих же сообщениях.
//
// Подставляются через `--inject`: esbuild заменяет обращения к глобальным
// именам на эти значения.

export const process = {
  env: {} as Record<string, string | undefined>,
  cwd: () => '/',
  stdout: { write: (_text: string) => {} },
  argv: [] as string[],
  exitCode: 0,
};

/**
 * Ровно столько Buffer, сколько нужно чтению ввода: оно всё равно упрётся
 * в заглушку файловой системы и станет обычной ошибкой языка.
 */
export const Buffer = {
  alloc: (size: number) => new Uint8Array(size),
  from: (bytes: number[] | Uint8Array) => ({
    toString: (_encoding?: string) => new TextDecoder().decode(Uint8Array.from(bytes)),
  }),
  concat: (parts: Uint8Array[]) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return { toString: (_encoding?: string) => new TextDecoder().decode(out) };
  },
};
