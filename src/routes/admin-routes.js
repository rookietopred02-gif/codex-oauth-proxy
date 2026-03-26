import { registerAdminCoreRoutes } from "./admin-core.js";
import { registerAdminPoolRoutes } from "./admin-pool.js";
import { registerAdminSettingsRoutes } from "./admin-settings.js";

export function registerAdminRoutes(app, context) {
  registerAdminCoreRoutes(app, context.core);
  registerAdminPoolRoutes(app, context.pool);
  registerAdminSettingsRoutes(app, context.settings);
}
