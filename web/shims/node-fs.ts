// Заглушка node:fs для сборки под браузер.
//
// Файловой системы в браузере нет, поэтому read_file, write_file и input()
// в песочнице не работают. Заглушка бросает ошибку, а стандартная библиотека
// Sable ловит её и превращает в обычную ошибку языка со стрелкой — падения
// наружу не происходит.

const нет = (что: string): never => {
  throw new Error(`в браузере ${что} недоступно`);
};

export const readFileSync = (): never => нет('чтение файлов');
export const writeFileSync = (): never => нет('запись файлов');
export const readSync = (): never => нет('чтение ввода');
export const existsSync = (): boolean => false;
