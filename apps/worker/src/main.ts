// The worker will host orchestration, agent-runtime and mcp-platform. Until the
// first workflow runs it only stays alive so the deployment shape is in place.
console.log("worker started");

const keepAlive = setInterval(() => {}, 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(keepAlive);
    process.exit(0);
  });
}
