// `npm run dev`. Starts Next.js listening on 127.0.0.1 only, and marks the process so the local
// setup endpoints know it (lib/local-request.ts).
//
// Why a script and not a one-line npm command: npm appends extra arguments, and Next takes the
// last --hostname it is given, so `npm run dev -- -H 0.0.0.0` would put the server on the
// network while still claiming to be loopback-only. Anyone on the same Wi-Fi could then read the
// saved tokens. This script refuses extra arguments instead.
import { spawn } from "node:child_process";

if (process.argv.length > 2) {
  console.error(
    "npm run dev takes no arguments: the setup page can run commands with your accounts and must\n" +
      "stay on 127.0.0.1. To reach the app from another device, use `npx next dev -H 0.0.0.0`;\n" +
      "the setup endpoints are then switched off.",
  );
  process.exit(2);
}

const child = spawn("next", ["dev", "--hostname", "127.0.0.1"], {
  stdio: "inherit",
  env: { ...process.env, SETUP_LOOPBACK_ONLY: "1" },
  shell: process.platform === "win32",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
