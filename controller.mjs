// Cell controller: two robots each work through a queue of part moves stored in SQLite.
// MODE=naive  claims a task, sends the move, then marks it done. After a crash it re-sends any
//             task that was claimed but not marked done.
// MODE=intent records "dispatching" (with the command id) before sending. After a crash it asks
//             the robot about that command id and only re-sends if the robot never got it.
// CRASH_AT=k  exits the process at the k-th checkpoint, to simulate a crash or power loss there.
import { DatabaseSync } from "node:sqlite";

const DB = process.env.DB;
const PORT = Number(process.env.DEVICE_PORT);
const MODE = process.env.MODE ?? "intent";
const CRASH_AT = process.env.CRASH_AT ? Number(process.env.CRASH_AT) : 0;

let checkpoints = 0;
function checkpoint() {
  checkpoints += 1;
  if (checkpoints === CRASH_AT) process.exit(137);
}

const db = new DatabaseSync(DB);
db.exec("PRAGMA journal_mode=WAL");

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

async function send(cmd) {
  const r = await fetch(`http://127.0.0.1:${PORT}/command`, {
    method: "POST",
    body: JSON.stringify(cmd),
  });
  return r.json();
}

async function commandStatus(id) {
  const r = await fetch(`http://127.0.0.1:${PORT}/command/${encodeURIComponent(id)}`);
  return (await r.json()).status;
}

async function waitDone(id) {
  for (;;) {
    const s = await commandStatus(id);
    if (s === "done") return;
    if (s === "unknown") return "unknown";
    await new Promise((r) => setTimeout(r, 1));
  }
}

const claimNext = db.prepare(
  "SELECT id FROM tasks WHERE robot = ? AND state = 'pending' ORDER BY id LIMIT 1",
);

function claim(robot) {
  let task;
  tx(() => {
    const row = claimNext.get(robot);
    if (!row) return;
    db.prepare("UPDATE robots SET holder = ? WHERE robot = ? AND holder IS NULL").run(row.id, robot);
    checkpoint(); // crash inside the transaction: both writes roll back
    db.prepare("UPDATE tasks SET state = 'claimed', attempt = attempt + 1 WHERE id = ?").run(row.id);
    task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(row.id);
  });
  return task;
}

function finish(task) {
  tx(() => {
    db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(task.id);
    db.prepare("UPDATE robots SET holder = NULL WHERE robot = ? AND holder = ?").run(task.robot, task.id);
  });
}

function commandFor(task) {
  return { id: `task-${task.id}`, robot: task.robot, from: task.src, to: task.dst };
}

async function runTask(task) {
  const cmd = commandFor(task);
  if (MODE === "intent") {
    db.prepare("UPDATE tasks SET state = 'dispatching' WHERE id = ?").run(task.id);
    checkpoint(); // intent recorded, command not sent yet
  }
  await send(cmd);
  checkpoint(); // robot has moved, completion not recorded yet
  finish(task);
  checkpoint();
}

async function recover() {
  // Tasks a previous run left in flight, one per robot at most.
  const inflight = db.prepare("SELECT * FROM tasks WHERE state IN ('claimed', 'dispatching')").all();
  for (const task of inflight) {
    if (MODE === "naive" || task.state === "claimed") {
      await runTask(task); // naive: no record of whether the move was sent, so send it again
      continue;
    }
    // intent: the move may or may not have reached the robot. Ask before re-sending.
    const s = await waitDone(`task-${task.id}`);
    if (s === "unknown") await runTask(task);
    else {
      finish(task);
      checkpoint();
    }
  }
}

async function worker(robot) {
  for (;;) {
    const task = claim(robot);
    if (!task) return;
    await runTask(task);
  }
}

await recover();
await Promise.all([worker("r1"), worker("r2")]);
db.close();
