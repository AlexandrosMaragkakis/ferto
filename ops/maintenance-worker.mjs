// Deploy only during an intentional recovery window; this Worker never uses D1.
export default {
  fetch() {
    return new Response("FERTO is temporarily unavailable for maintenance. Please try again later.\n", { status: 503, headers: {
      "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "300",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff",
    } });
  },
  queue(batch) { batch.retryAll({ delaySeconds: 900 }); },
  scheduled() {},
};
