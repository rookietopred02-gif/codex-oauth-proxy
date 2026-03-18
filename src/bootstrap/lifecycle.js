export function startConfiguredServer({
  app,
  config,
  shouldAutostart,
  getActiveUpstreamBaseUrl,
  onStartup,
  onShutdown
}) {
  let mainServer = null;
  let gracefulExitStarted = false;

  async function gracefulShutdown(signal = "SIGTERM") {
    if (gracefulExitStarted) return;
    gracefulExitStarted = true;
    console.log(`[shutdown] received ${signal}, cleaning up...`);
    try {
      await onShutdown(signal);
    } finally {
      if (mainServer) {
        mainServer.close(() => {
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
      setTimeout(() => process.exit(0), 1200).unref();
    }
  }

  if (shouldAutostart) {
    mainServer = app.listen(config.port, config.host, () => {
      console.log(`codex-pro-max listening on http://${config.host}:${config.port}`);
      console.log(`mode:   ${config.authMode}`);
      console.log(`upstream-mode: ${config.upstreamMode}`);
      console.log(`upstream-url:  ${getActiveUpstreamBaseUrl()}`);
      onStartup();
    });

    mainServer.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        console.error(
          `[startup] Port ${config.host}:${config.port} is already in use. ` +
          "Stop the existing process or run with a different PORT."
        );
        process.exit(1);
        return;
      }
      console.error(`[startup] Failed to start server: ${err?.message || err}`);
      process.exit(1);
    });

    process.on("SIGINT", () => {
      gracefulShutdown("SIGINT").catch(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      gracefulShutdown("SIGTERM").catch(() => process.exit(0));
    });
  }

  return {
    mainServer,
    gracefulShutdown
  };
}
