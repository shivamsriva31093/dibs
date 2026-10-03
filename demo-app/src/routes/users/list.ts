import { listUsers } from "../../db/users.ts";
import type { Route } from "../../router.ts";
import { paginate } from "../../services/pagination.ts";

export const listUsersRoute: Route = {
  method: "GET",
  path: "/users",
  handler: (request) => {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "10");
    return Response.json(paginate(listUsers(), page, perPage));
  },
};
