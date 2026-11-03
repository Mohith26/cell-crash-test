# cell-crash-test

A robot cell controller has to survive crashing at the worst moment: after it told a robot to
move a part, but before it wrote down that the move happened. If it restarts and sends the move
again, the robot does it twice. I wanted to see how often that happens for a simple design, and
whether recording intent first fixes it, so I built a toy cell and crashed it at every step.

- `device.mjs`: a fake robot over HTTP. It executes every command it gets (no deduplication, like
  most real robot controllers), and logs what it actually did. It runs in the harness process, so
  it keeps going when the controller dies.
- `controller.mjs`: two robots, each with a queue of part moves in SQLite (`node:sqlite`, WAL).
  It claims a task and locks its robot in one transaction, sends the move, then marks the task
  done and releases the robot. It has numbered checkpoints, and `CRASH_AT=k` makes it exit at the
  k-th one.
  - `MODE=naive`: after a restart, any task that was claimed but not done is sent again.
  - `MODE=intent`: before sending, the task is marked `dispatching` with its command id. After a
    restart, the controller asks the robot about that command id, waits if it is still running,
    and only re-sends if the robot never received it.
- `harness.mjs`: for every checkpoint k, starts from a fresh database, runs the controller with
  `CRASH_AT=k`, restarts it until it finishes, then checks the robot's log: every task moved
  exactly once, and no robot got a second move while one was still running.

## Result

```
$ TASKS_PER_ROBOT=10 node harness.mjs
naive  crash points tested: 60, runs with a lost/repeated/overlapping move: 55
intent crash points tested: 80, runs with a lost/repeated/overlapping move: 0
```

With the naive design, 55 of 60 crash points made a robot repeat a move. It's that high because
there are two robots: almost any crash catches one of them mid-move. Crashes inside the claim
transaction were always harmless, because SQLite rolls the half-written claim back. With intent
recorded first, all 80 crash points ended with every move done exactly once.

## Limits

- The fake robot answers "unknown" only if it never got the command. On a real network a command
  can still be in flight when the restarted controller asks, so a real cell needs the robot side
  to reject a command id it has already seen, or a handshake that makes the answer final.
- One process, one crash per trial, and the robot itself never fails.
- It is a toy: no alarms, no telemetry, no real motion. It only exercises the
  persist / dispatch / recover ordering.

## Run it

Needs Node 22.13 or newer (built-in `node:sqlite`), no dependencies.

```sh
npm test                       # 5 tasks per robot
TASKS_PER_ROBOT=10 npm test
```
