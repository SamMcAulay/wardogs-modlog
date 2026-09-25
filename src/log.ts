export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const stamp = (): string => new Date().toISOString();

export const consoleLogger: Logger = {
  info: (m) => console.log(`[${stamp()}] ${m}`),
  warn: (m) => console.warn(`[${stamp()}] ${m}`),
  error: (m) => console.error(`[${stamp()}] ${m}`)
};
