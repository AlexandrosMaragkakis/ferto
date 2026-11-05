/** The signal stays attached after headers arrive, bounding response-body reads too. */
export function fetchWithDeadline(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
}
