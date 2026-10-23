import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

const require = createRequire(import.meta.url);
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to a local/test Postgres database");
if (process.env.NODE_ENV === "production") throw new Error("Integration tests cannot run in production");

// Never reuse the caller's schema or database. Historical migrations contain
// database-wide catalog guards, so an existing enum in another schema could
// otherwise prevent a fresh schema's migrations from being applied correctly.
const schema = `integration_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL);
const admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
url.pathname = `/${schema}`;
url.searchParams.set("schema", schema);
const databaseUrl = url.toString();
const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl, INTEGRATION_SCHEMA: schema };
let created = false;

function run(module, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve(module), ...args], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${module} exited with ${signal ?? code}`));
    });
  });
}

try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${schema}"`);
  created = true;
  // migrate deploy creates the fresh schema named in DATABASE_URL.
  await run("prisma/build/index.js", ["migrate", "deploy"]);
  await run("jest/bin/jest", ["--config", "jest.integration.config.js", ...process.argv.slice(2)]);
} finally {
  try {
    if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${schema}"`);
  } finally {
    await admin.$disconnect();
  }
}
