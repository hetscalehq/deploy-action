import { run } from './action.js';

// A cancelled job sends SIGINT, then SIGTERM: either aborts the call in flight, and the step fails.
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

process.exitCode = await run({ signal: controller.signal });
