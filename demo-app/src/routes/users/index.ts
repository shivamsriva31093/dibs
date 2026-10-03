import type { Route } from "../../router.ts";
import { listUsersRoute } from "./list.ts";

export const userRoutes: Route[] = [listUsersRoute];
