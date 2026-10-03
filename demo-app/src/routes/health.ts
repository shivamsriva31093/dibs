import type { Route } from "../router.ts";

export const healthRoute: Route = {
  method: "GET",
  path: "/health",
  handler: () => Response.json({ ok: true }),
};
