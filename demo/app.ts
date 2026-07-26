import { send } from "./sdk";

// This call site still uses the v1 API shape (a single options object),
// so `npm run typecheck` fails after the upgrade. That's the breakage
// self-maintain is supposed to detect and fix.
export async function notify() {
  await send({ channel: "alerts", message: "build failed" });
}
