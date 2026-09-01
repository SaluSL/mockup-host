export interface Env {
  DATA_DIR: string;
  DATABASE_PATH: string;
  PORT: number;
  PANEL_HOST: string;
  MOCKUPS_HOST: string;
  SESSION_SECRET: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD_HASH: string;
  MAX_UPLOAD_BYTES: number;
  NODE_ENV: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function getEnv(): Env {
  const DATA_DIR = process.env.DATA_DIR ?? "./data";
  return {
    DATA_DIR,
    DATABASE_PATH: process.env.DATABASE_PATH ?? `${DATA_DIR}/db.sqlite`,
    PORT: parseInt(process.env.PORT ?? "3000", 10),
    PANEL_HOST: required("PANEL_HOST"),
    MOCKUPS_HOST: required("MOCKUPS_HOST"),
    SESSION_SECRET: required("SESSION_SECRET"),
    ADMIN_USERNAME: required("ADMIN_USERNAME"),
    ADMIN_PASSWORD_HASH: required("ADMIN_PASSWORD_HASH"),
    MAX_UPLOAD_BYTES: parseInt(process.env.MAX_UPLOAD_BYTES ?? "209715200", 10),
    NODE_ENV: process.env.NODE_ENV ?? "development",
  };
}
