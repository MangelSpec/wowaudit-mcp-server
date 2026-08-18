import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";

const serverEntry = process.argv[2];
const keyPath = process.env.WOWAUDIT_TEST_API_KEY_PATH;
if (!serverEntry || !keyPath) {
  throw new Error("The FD test launcher requires a server entry and key path");
}

const keyFd = openSync(keyPath, "r");
delete process.env.WOWAUDIT_TEST_API_KEY_PATH;
const child = spawn(process.execPath, [serverEntry], {
  env: process.env,
  stdio: ["inherit", "inherit", "inherit", keyFd],
  windowsHide: true,
});
closeSync(keyFd);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error("Unable to start FD test server:", error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
