// Crash-injection harness. For each checkpoint k it starts from a fresh database, runs the
// controller with CRASH_AT=k, restarts it (without crashing) until it finishes, and then checks
// what the fake robot actually did:
//   - every task moved exactly once (no lost moves, no repeated moves)
//   - a robot never received a second move while one was still running
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDevice } from "./device.mjs";

const TASKS_PER_ROBOT = Number(process.env.TASKS_PER_ROBOT ?? 5);

function freshDb(file) {
  for (const f of [file, file + "-wal", file + "-shm"]) fs.rmSync(f, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, robot TEXT, src TEXT, dst TEXT,
                        state TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE robots (robot TEXT PRIMARY KEY, holder INTEGER);
    INSERT INTO robots VALUES ('r1', NULL), ('r2', NULL);
  `);
  const ins = db.prepare("INSERT INTO tasks (robot, src, dst) VALUES (?, ?, ?)");
  for (let i = 0; i < TASKS_PER_ROBOT; i++) {
    ins.run("r1", `m${i}`, "inspect");
    ins.run("r2", `m${i + 10}`, "inspect");
  }
  db.close();
}

function runController(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["controller.mjs"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "inherit"],
    });
    p.on("exit", (code) => resolve(code));
  });
}

async function trial(mode, crashAt, dbFile) {
  freshDb(dbFile);
  const dev = await startDevice();
  const env = { DB: dbFile, DEVICE_PORT: String(dev.port), MODE: mode };
  let code = await runController({ ...env, CRASH_AT: String(crashAt) });
  const crashed = code === 137;
  let restarts = 0;
  while (code !== 0) {
    if (++restarts > 5) throw new Error(`controller keeps failing (exit ${code})`);
    code = await runController(env);
  }
  dev.close();
  const counts = new Map();
  for (const c of dev.log) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
  const expected = TASKS_PER_ROBOT * 2;
  const missing = expected - counts.size;
  const repeated = [...counts.values()].filter((n) => n > 1).length;
  return { crashed, missing, repeated, overlaps: dev.overlaps.length };
}

const dbFile = path.join(os.tmpdir(), `cell-crash-test-${process.pid}.db`);
const summary = {};
for (const mode of ["naive", "intent"]) {
  let crashes = 0;
  const bad = [];
  for (let k = 1; ; k++) {
    const r = await trial(mode, k, dbFile);
    if (!r.crashed) break; // k is past the last checkpoint of a full run
    crashes++;
    if (r.missing || r.repeated || r.overlaps) bad.push({ k, ...r });
  }
  summary[mode] = { crashPoints: crashes, badRuns: bad.length };
  console.log(
    `${mode.padEnd(6)} crash points tested: ${crashes}, runs with a lost/repeated/overlapping move: ${bad.length}`,
  );
  for (const b of bad.slice(0, 3)) {
    console.log(`  e.g. crash at checkpoint ${b.k}: missing=${b.missing} repeated=${b.repeated} overlaps=${b.overlaps}`);
  }
}
for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
process.exitCode = summary.intent.badRuns === 0 ? 0 : 1;
