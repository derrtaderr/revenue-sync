// One HTTP layer for Stripe and HubSpot: retry 429 and 5xx with backoff, honour Retry-After,
// retry network failures, and build every error message from the service name, status and URL
// path only. Headers, query strings and response bodies never reach a message, so a key cannot
// leak through an error.

export const MAX_RETRIES = 5;
export const MAX_WAIT_SECONDS = 60;
const BASE_MS = 500;

export class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const retryable = (status) => status === 429 || status >= 500;

export function createRequester({ service, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random }) {
  const backoff = (attempt) => {
    const base = BASE_MS * 2 ** attempt;
    return Math.round(base + random() * base);
  };

  return async function request(url, init = {}) {
    const path = new URL(url).pathname;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, init);
      } catch {
        if (attempt < MAX_RETRIES) { await sleep(backoff(attempt)); continue; }
        throw new ApiError(`Could not reach ${service} at ${path}. Check the network connection.`);
      }
      if (retryable(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        if (retryAfter > MAX_WAIT_SECONDS) {
          throw new ApiError(`${service} rate limited ${path} and asked to wait ${retryAfter} seconds. Try again later.`, res.status);
        }
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      if (retryable(res.status)) {
        throw new ApiError(`${service} kept failing ${path} (status ${res.status}) after ${MAX_RETRIES} retries. Try again in a few minutes.`, res.status);
      }
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        if (res.ok) throw new ApiError(`${service}'s response from ${path} was not valid JSON (status ${res.status}).`, res.status);
      }
      return { status: res.status, body, headers: res.headers };
    }
  };
}
