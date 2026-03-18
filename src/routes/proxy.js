export function registerProxyRoutes(app, context) {
  const { handlers } = context;

  app.get("/v1/models", handlers.modelsList);
  app.use(handlers.auditMiddleware);
  app.use("/v1beta", handlers.geminiNativeProxy);
  app.use("/v1/messages", handlers.anthropicNativeProxy);
  app.use("/v1", handlers.openAIProxy);
}
