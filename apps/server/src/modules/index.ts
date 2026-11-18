import type { FastifyInstance } from 'fastify';
import { registerEventRoutes } from './events.js';
import { registerAnalyticsRoutes } from './analytics.js';
import { registerFeedbackRoutes } from './feedback.js';
import { registerLoyaltyRoutes } from './loyalty.js';
import { registerMarketingRoutes } from './marketing/routes.js';
import { registerPosRoutes } from './pos.js';
import { registerPublicRoutes } from './public.js';
import { registerReportRoutes } from './reports.js';
import { registerExportRoutes } from './export.js';
import { registerSystemRoutes } from './system/routes.js';
import { registerGuestRoutes } from './guests/routes.js';
import { registerHealthRoutes } from './health.js';
import { registerMiscRoutes } from './misc.js';
import { registerReservationRoutes } from './reservations/routes.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSetupRoutes } from './setup.js';
import { registerSyncRoutes } from './sync/routes.js';
import { registerUserRoutes } from './users.js';
import { registerVenueRoutes } from './venue.js';
import { registerWaitlistRoutes } from './waitlist.js';

/** Every domain module registers its routes here (one Fastify plugin-style function per module). */
export async function registerModules(app: FastifyInstance): Promise<void> {
  await registerHealthRoutes(app);
  await registerSetupRoutes(app);
  await registerUserRoutes(app);
  await registerVenueRoutes(app);
  await registerGuestRoutes(app);
  await registerReservationRoutes(app);
  await registerWaitlistRoutes(app);
  await registerSyncRoutes(app);
  await registerSettingsRoutes(app);
  await registerMiscRoutes(app);
  await registerEventRoutes(app);
  await registerSystemRoutes(app);
  await registerExportRoutes(app);
  await registerLoyaltyRoutes(app);
  await registerPosRoutes(app);
  await registerMarketingRoutes(app);
  await registerFeedbackRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerReportRoutes(app);
  await registerPublicRoutes(app);
}
