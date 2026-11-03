// A fake robot. It runs every motion command it receives (it does not deduplicate, like most real
// robot controllers), takes a few milliseconds per move, and keeps a log so the harness can check
// what physically happened. It lives in the harness process, so it survives controller crashes.
import http from "node:http";

export function startDevice() {
  const log = []; // every command executed, in order
  const status = new Map(); // command id -> "running" | "done"
  const busy = new Map(); // robot -> command id currently moving
  const overlaps = []; // two commands on one robot at the same time

  const server = http.createServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url.startsWith("/command/")) {
      const id = decodeURIComponent(req.url.slice("/command/".length));
      return reply(200, { id, status: status.get(id) ?? "unknown" });
    }
    if (req.method === "POST" && req.url === "/command") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const cmd = JSON.parse(body);
        if (busy.has(cmd.robot)) overlaps.push([busy.get(cmd.robot), cmd.id]);
        busy.set(cmd.robot, cmd.id);
        status.set(cmd.id, "running");
        setTimeout(() => {
          log.push(cmd);
          status.set(cmd.id, "done");
          if (busy.get(cmd.robot) === cmd.id) busy.delete(cmd.robot);
          reply(200, { id: cmd.id, status: "done" });
        }, 3);
      });
      return;
    }
    reply(404, {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, log, overlaps, close: () => server.close() });
    });
  });
}
