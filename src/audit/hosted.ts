// Opt-in hosted-surface probes (P3). The repo-only Tier-0 audit is blind to
// docs a system serves only from its hosted docs site rather than committing
// to the repo: Chakra serves llms.txt slices from route handlers, Mantine
// hosts a 43 KB llms.txt index, a 4.2 MB llms-full.txt, and a 164-entry
// /mcp/index.json — none of that exists as a file a repo walk can find.
//
// This module fetches a small, fixed set of well-known paths from a
// `SystemConfig.docsUrl` when the operator configures one. It is the ONLY
// place in the audit that ever touches the network, and it only runs when
// docsUrl is set — see src/audit/run.ts for the offline-by-default wiring
// (no docsUrl configured = this module is never called = zero network,
// byte-identical to the pre-P3 audit) and checks/surface.ts +
// checks/docs-greppability.ts for how the results feed into findings/score.
//
// A 404/410 is a measured absence: the ecosystem convention is that an
// AI-native system serves these paths, so a clean "not found" is real
// evidence, not silence. A thrown fetch error or a timeout is NOT the same
// thing — the asset's existence simply wasn't determined (slow host,
// firewall, transient DNS blip), so callers must treat 'unreachable' as
// unmeasured and must never fold it into an absence warn.

const DEFAULT_TIMEOUT_MS = 5000;

/** Hard cap on bytes read per probe body. Streamed and stopped early rather than buffering the whole thing — Mantine's real llms-full.txt is 4.2 MB and some hosts could serve something far larger; this check must never become a way to make the audit hang or balloon memory on a hostile or misconfigured server. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Only llms.txt bodies at or under this size get their text captured on the probe (see HostedProbe.text) — large bodies are measured (byte count) but not read into memory twice over, and docs-greppability treats "too big to capture" as unmeasured coverage, never as zero. */
const MAX_LLMS_TEXT_CAPTURE_BYTES = 1024 * 1024;

const PROBE_PATHS = ['/llms.txt', '/llms-full.txt', '/mcp/index.json', '/registry.json'] as const;

export interface HostedProbe {
  path: string;
  url: string;
  status: 'found' | 'absent' | 'unreachable';
  httpStatus?: number;
  /**
   * Bytes read from the body. When the body exceeded MAX_BODY_BYTES this is
   * the amount actually read before the read was aborted — i.e.
   * *at least* this many bytes, not the artifact's true total size.
   */
  bytes?: number;
  /** Only populated for the /llms.txt probe, only when found and the body is <= 1 MB. Lets docs-greppability compute llms.txt name-coverage without a second fetch. */
  text?: string;
}

export interface HostedSurface {
  docsUrl: string;
  probes: HostedProbe[];
}

interface CappedRead {
  bytes: number;
  text?: string;
}

/**
 * Reads a fetch Response body via its stream, stopping (without throwing)
 * once `capBytes` has been read. `captureTextLimitBytes`, when given, also
 * collects the decoded text — but only if the FULL body finished within
 * that limit (a body that hit the byte cap never gets its text captured,
 * regardless of captureTextLimitBytes, since we stopped reading it).
 */
async function readBodyCapped(res: Response, capBytes: number, captureTextLimitBytes?: number): Promise<CappedRead> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body (unusual for a real fetch implementation, but keep
    // this degrading gracefully rather than throwing): fall back to reading
    // it whole. There is no way to cap a read we've already been handed in
    // full, so this path just reports what it got.
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = captureTextLimitBytes !== undefined && buf.byteLength <= captureTextLimitBytes ? new TextDecoder().decode(buf) : undefined;
    return { bytes: buf.byteLength, text };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      total += value.byteLength;
      chunks.push(value);
      if (total >= capBytes) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // best-effort cancel only — the read has already served its purpose
        }
        break;
      }
    }
  }

  let text: string | undefined;
  if (!truncated && captureTextLimitBytes !== undefined && total <= captureTextLimitBytes) {
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(combined);
  }
  return { bytes: total, text };
}

async function probeOne(docsUrl: string, path: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<HostedProbe> {
  const url = new URL(path, docsUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });

    if (res.status === 404 || res.status === 410) {
      try {
        await res.arrayBuffer(); // drain best-effort so the connection can close cleanly
      } catch {
        // ignore — a drain failure doesn't change the verdict
      }
      return { path, url, status: 'absent', httpStatus: res.status };
    }

    if (!res.ok) {
      try {
        await res.arrayBuffer();
      } catch {
        // ignore
      }
      return { path, url, status: 'unreachable', httpStatus: res.status };
    }

    const captureTextLimit = path === '/llms.txt' ? MAX_LLMS_TEXT_CAPTURE_BYTES : undefined;
    const { bytes, text } = await readBodyCapped(res, MAX_BODY_BYTES, captureTextLimit);
    return { path, url, status: 'found', httpStatus: res.status, bytes, ...(text !== undefined ? { text } : {}) };
  } catch {
    // AbortError (timeout) or any network-level failure (DNS, connection
    // refused, TLS, ...): unmeasured, never "absent" — see module header.
    return { path, url, status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes the fixed hosted-surface path set against `docsUrl`, concurrently,
 * each with its own timeout. Never throws: a failing probe just reports
 * itself as 'unreachable'. `fetchImpl` is injectable for tests; production
 * callers omit it and get globalThis.fetch.
 */
export async function probeHostedSurface(docsUrl: string, opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<HostedSurface> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const probes = await Promise.all(PROBE_PATHS.map((path) => probeOne(docsUrl, path, timeoutMs, fetchImpl)));
  return { docsUrl, probes };
}
