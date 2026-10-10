import { currentSpan } from "../context.ts";
import { formatTraceparent } from "../propagation.ts";
import { SpanKind, SpanStatus } from "../span.ts";
import { failSpan } from "../tracer.ts";

/** Whether host is one of hosts or a subdomain of one. */
export function propagatesTo(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((x) => {
    const a = x.trim().toLowerCase();
    return a !== "" && (h === a || h.endsWith(`.${a}`));
  });
}

/**
 * fetch with an OTel client span (`HTTP <METHOD>`). base is the fetch to wrap (a provider's injected one in tests)
 * and is called the same way traced or not: base(input, init). traceparent goes only to settings.traces
 * .propagateHosts: third parties never see internal trace ids. globalThis.fetch is read at call time so stubs work.
 */
export async function tracedFetch(
  input: string | URL | Request,
  init?: RequestInit,
  base: typeof fetch = (i, o) => globalThis.fetch(i, o),
): Promise<Response> {
  const parent = currentSpan();
  if (!parent) return await base(input, init);
  const isReq = input instanceof Request;
  const url = new URL(isReq ? input.url : String(input));
  const method = (init?.method ?? (isReq ? input.method : "GET")).toUpperCase();
  const span = parent.trace!.start(`HTTP ${method}`, parent.id, false, {
    kind: SpanKind.client,
    attributes: {
      "http.request.method": method,
      "server.address": url.hostname,
      "server.port": url.port ? Number(url.port) : undefined,
      "url.full": `${url.origin}${url.pathname}`,
    },
  });
  let callInit = init;
  if (propagatesTo(url.hostname, parent.trace!.sink.settings().propagateHosts ?? [])) {
    const headers = new Headers(init?.headers ?? (isReq ? input.headers : undefined));
    headers.set("traceparent", formatTraceparent({ traceId: span.traceId, spanId: span.id, sampled: span.sampled }));
    callInit = { ...init, headers };
  }
  try {
    const res = await base(input, callInit);
    span.setAttribute("http.response.status_code", res.status);
    if (res.status >= 400) span.setStatus(SpanStatus.error, `HTTP ${res.status}`);
    return res;
  } catch (e) {
    failSpan(span, e);
    throw e;
  } finally {
    span.end();
  }
}
