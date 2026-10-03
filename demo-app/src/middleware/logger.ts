type RequestHandler = (request: Request) => Promise<Response>;

export function withLogging(handler: RequestHandler): RequestHandler {
  return async (request) => {
    const started = Date.now();
    const response = await handler(request);
    console.log(`${request.method} ${new URL(request.url).pathname} ${response.status} ${Date.now() - started}ms`);
    return response;
  };
}
