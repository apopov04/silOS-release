const http = require("http");
const { execSync } = require("child_process");

const PORT = 3002;

function getStatus() {
  try {
    // Security
    const f2bRaw = execSync("sudo fail2ban-client status sshd 2>/dev/null", { encoding: "utf8" });
    const totalFailed = f2bRaw.match(/Total failed:\s*(\d+)/)?.[1] || "0";
    const totalBanned = f2bRaw.match(/Total banned:\s*(\d+)/)?.[1] || "0";
    const currentBanned = f2bRaw.match(/Currently banned:\s*(\d+)/)?.[1] || "0";
    const recent = execSync(
      "sudo journalctl -u ssh --since '24 hours ago' 2>/dev/null | grep -c 'Invalid user' || echo 0",
      { encoding: "utf8" }
    ).trim();
    const lastRaw = execSync(
      "sudo journalctl -u ssh --since '7 days ago' 2>/dev/null | grep 'Invalid user' | tail -1 || echo ''",
      { encoding: "utf8" }
    ).trim();
    let lastAttempt = "None";
    if (lastRaw) {
      const match = lastRaw.match(/^(\w+ \d+ [\d:]+)/);
      if (match) lastAttempt = match[1];
    }

    // Server stats
    const cpuLoad = execSync("cat /proc/loadavg", { encoding: "utf8" }).split(" ")[0];
    const memInfo = execSync("free -m", { encoding: "utf8" });
    const memLine = memInfo.split("\n")[1].split(/\s+/);
    const ramTotal = memLine[1];
    const ramUsed = memLine[2];
    const diskInfo = execSync("df -h / | tail -1", { encoding: "utf8" }).split(/\s+/);
    const diskUsed = diskInfo[2];
    const diskTotal = diskInfo[1];
    const diskPercent = diskInfo[4];
    const uptime = execSync("uptime -p", { encoding: "utf8" }).trim().replace("up ", "");

    // Containers
    const containerRaw = execSync("docker ps --format '{{.Names}}|{{.Status}}'", { encoding: "utf8" }).trim();
    const containerLines = containerRaw.split("\n").map((line) => {
      const [name, status] = line.split("|");
      if (name.includes("core")) return `silOS-1: ${status}`;
      if (name.includes("bot")) return `Comm-1: ${status}`;
      return `${name}: ${status}`;
    });

    return [
      "\u{1F6E1}\uFE0F *Security Status* \u{1F6E1}\uFE0F",
      `Failed SSH attempts (All): ${totalFailed}`,
      `Failed SSH attempts (24h): ${recent}`,
      `IPs banned (All): ${totalBanned}`,
      `IPs currently banned: ${currentBanned}`,
      `Last failed attempt: ${lastAttempt}`,
      "",
      "\u{1F6E0}\uFE0F *Server Status* \u{1F6E0}\uFE0F",
      `CPU Load: ${cpuLoad}`,
      `RAM: ${ramUsed}MB / ${ramTotal}MB`,
      `Disk: ${diskUsed} / ${diskTotal} (${diskPercent})`,
      `Uptime: ${uptime}`,
      "",
      "\u{1F4E6} *Containers* \u{1F4E6}",
      ...containerLines,
    ].join("\n");
  } catch (err) {
    return "Failed to get status: " + err.message;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: getStatus() }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log("Admin service listening on port " + PORT);
});
