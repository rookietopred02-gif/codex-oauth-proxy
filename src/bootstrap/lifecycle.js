function addUniqueProcessListener(eventName, handler) {
  const listeners = process.listeners(eventName);
  if (!listeners.includes(handler)) {
    process.on(eventName, handler);
  }
}

function readListenPort(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 && value < 65536 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed < 65536 ? parsed : null;
  }
  return null;
}

function resolveListenPort(value, fallback, defaultPort = 8787) {
  return readListenPort(value) ?? readListenPort(fallback) ?? defaultPort;
}

export function startConfiguredServer({
  app,
  config,
  shouldAutostart,
  getActiveUpstreamBaseUrl,
  onStartup,
  onShutdown,
  syncResolvedAddress,
  installSignalHandlers = shouldAutostart
}) {
  let mainServer = null;
  let startPromise = null;
  let stopPromise = null;
  let gracefulExitStarted = false;

  async function start(overrides = {}) {
    if (mainServer) {
      return {
        mainServer,
        host: config.host,
        port: config.port
      };
    }
    if (startPromise) return await startPromise;

    const nextHost = String(overrides.host || config.host || "127.0.0.1").trim() || "127.0.0.1";
    const rawPort = overrides.port ?? config.port;
    const nextPort = resolveListenPort(rawPort, config.port);

    startPromise = new Promise((resolve, reject) => {
      const server = app.listen(nextPort, nextHost);
      server.timeout = 0;
      const cleanup = () => {
        server.off("error", handleError);
        server.off("listening", handleListening);
      };
      const handleError = (err) => {
        cleanup();
        startPromise = null;
        reject(err);
      };
      const handleListening = async () => {
        cleanup();
        mainServer = server;

        const address = server.address();
        const resolvedHost =
          typeof address === "object" && address?.address
            ? address.address
            : nextHost;
        const resolvedPort =
          typeof address === "object" && Number.isFinite(address?.port)
            ? Number(address.port)
            : nextPort;

        config.host = resolvedHost;
        config.port = resolvedPort;
        syncResolvedAddress?.({
          host: resolvedHost,
          port: resolvedPort,
          requestedPort: nextPort
        });

        console.log(`codex-pro-max listening on http://${config.host}:${config.port}`);
        console.log(`mode:   ${config.authMode}`);
        console.log(`upstream-mode: ${config.upstreamMode}`);
        console.log(`upstream-url:  ${getActiveUpstreamBaseUrl()}`);

        try {
          await onStartup?.({
            host: config.host,
            port: config.port,
            requestedPort: nextPort,
            server
          });
        } catch (err) {
          await new Promise((resolve) => {
            server.close(() => resolve());
          });
          mainServer = null;
          startPromise = null;
          reject(err);
          return;
        }

        startPromise = null;
        resolve({
          mainServer,
          host: config.host,
          port: config.port
        });
      };

      server.once("error", handleError);
      server.once("listening", handleListening);
    });

    return await startPromise;
  }

  async function stop(signal = "SIGTERM") {
    if (stopPromise) return await stopPromise;

    stopPromise = (async () => {
      if (gracefulExitStarted) return;
      gracefulExitStarted = true;
      console.log(`[shutdown] received ${signal}, cleaning up...`);
      try {
        await onShutdown?.(signal);
      } finally {
        const serverToClose = mainServer;
        mainServer = null;
        startPromise = null;
        if (serverToClose) {
          await new Promise((resolve) => {
            serverToClose.close(() => resolve());
          });
        }
      }
    })();

    try {
      await stopPromise;
    } finally {
      stopPromise = null;
      gracefulExitStarted = false;
    }
  }

  const handleSigint = () => {
    stop("SIGINT")
      .catch((err) => {
        console.error(`[shutdown] ${err?.message || err}`);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  const handleSigterm = () => {
    stop("SIGTERM")
      .catch((err) => {
        console.error(`[shutdown] ${err?.message || err}`);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  if (installSignalHandlers) {
    addUniqueProcessListener("SIGINT", handleSigint);
    addUniqueProcessListener("SIGTERM", handleSigterm);
  }

  const autostartPromise = shouldAutostart ? start() : Promise.resolve(null);

  return {
    get mainServer() {
      return mainServer;
    },
    autostartPromise,
    start,
    stop,
    gracefulShutdown: stop
  };
}
