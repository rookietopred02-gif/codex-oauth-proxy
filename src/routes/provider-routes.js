import { registerProxyRoutes } from "./proxy.js";

export function registerProviderRoutes(app, context) {
  registerProxyRoutes(app, { handlers: context.handlers });
}
