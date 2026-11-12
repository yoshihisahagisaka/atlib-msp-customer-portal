type RequestLike = { method?: unknown; url?: unknown };
type ResponseLike = { statusCode?: unknown };

function pathWithoutQuery(url: unknown): string {
  if (typeof url !== 'string') return '/';
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/** Keep access diagnostics useful without serializing request headers or query values. */
export const safeHttpLogSerializers = {
  req: (req: RequestLike) => ({ method: typeof req.method === 'string' ? req.method : 'UNKNOWN', path: pathWithoutQuery(req.url) }),
  res: (res: ResponseLike) => ({ statusCode: typeof res.statusCode === 'number' ? res.statusCode : 0 }),
};

export const safeHttpLogRedactions = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers.set-cookie',
  'res.headers.set-cookie',
  'req.query.*',
  'err.message',
  'err.stack',
];
