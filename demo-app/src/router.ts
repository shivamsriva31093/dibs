export type Params = Record<string, string>;
export type Handler = (request: Request, params: Params) => Response | Promise<Response>;

export interface Route {
  method: string;
  // A path such as "/users/:id"; a segment starting with ":" matches anything and is passed as a parameter.
  path: string;
  handler: Handler;
}

export function match(routes: Route[], method: string, pathname: string): { route: Route; params: Params } | null {
  const wanted = pathname.split("/").filter((segment) => segment !== "");
  for (const route of routes) {
    const pattern = route.path.split("/").filter((segment) => segment !== "");
    if (route.method !== method || pattern.length !== wanted.length) {
      continue;
    }
    const params: Params = {};
    const matches = pattern.every((segment, index) => {
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = decodeURIComponent(wanted[index]!);
        return true;
      }
      return segment === wanted[index];
    });
    if (matches) {
      return { route, params };
    }
  }
  return null;
}
