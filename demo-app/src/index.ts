import { withLogging } from "./middleware/logger.ts";
import { match, type Route } from "./router.ts";
import { healthRoute } from "./routes/health.ts";
import { userRoutes } from "./routes/users/index.ts";

export const routes: Route[] = [healthRoute, ...userRoutes];

export const handle = withLogging(async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const found = match(routes, request.method, url.pathname);
  if (found === null) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return found.route.handler(request, found.params);
});
