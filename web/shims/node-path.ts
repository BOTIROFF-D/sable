// Заглушка node:path для сборки под браузер.
//
// Модули (`import "файл.sable"`) в песочнице не работают — грузить неоткуда.
// Но интерпретатор трогает path и без модулей, поэтому нужны рабочие функции,
// а не throw: иначе не запустилась бы ни одна программа.

const norm = (p: string): string => p.replace(/\/+/g, '/');

export const join = (...parts: string[]): string =>
  norm(parts.filter((p) => p !== '').join('/')) || '.';

export const dirname = (p: string): string => {
  const at = p.lastIndexOf('/');
  return at <= 0 ? '.' : p.slice(0, at);
};

export const isAbsolute = (p: string): boolean => p.startsWith('/');

export const resolve = (...parts: string[]): string => {
  let out = '';
  for (const p of parts) out = isAbsolute(p) ? p : join(out, p);
  return out || '/';
};

export const relative = (from: string, to: string): string => (to.startsWith(from) ? to.slice(from.length).replace(/^\//, '') : to);
