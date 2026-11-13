/**
 * SSRF-guarded fetch helpers (#206, RLV-017).
 *
 * Node-runtime ONLY (uses node:dns/node:net) — never import from edge paths
 * (middleware.ts, lib/auth.ts or anything they reach).
 *
 * DNS rebinding (#281 F15): assertPublicUrl's lookup and the socket's own
 * lookup are separate, so a feed host's DNS could answer the check with a
 * public IP and the connection with 127.0.0.1. safeFetch therefore connects
 * through GUARDED_DISPATCHER, whose connect-time lookup re-runs isBlockedIp on
 * every address the socket may use. assertPublicUrl still runs first for clear
 * UnsafeUrlError messages and IP-literal hosts (which skip lookup entirely).
 *
 * Known-unblocked exotic ranges: 6to4 2002::/16 (can embed an internal IPv4),
 * IPv4-compatible ::/96, documentation 2001:db8::/32. Non-routable or
 * negligible for this deployment; listed here so the omission is deliberate.
 */

import dns, { type LookupAddress, type LookupOptions } from 'node:dns'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { Agent, fetch as undiciFetch } from 'undici'

/**
 * Thrown when a URL is rejected by the SSRF guard (bad protocol, or the host
 * is / resolves to a blocked address). Callers map this to a clean 4xx; other
 * errors (DNS failure, network, timeout) propagate as ordinary fetch failures.
 */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

/**
 * Thrown by readTextCapped (when opts.throwOnCap is set) if the response body
 * exceeds maxBytes. Lets callers that cannot tolerate a truncated body — e.g.
 * an XML feed parser — fail loudly instead of parsing a silently-cut stream
 * (#234).
 */
export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response body exceeds the ${maxBytes}-byte cap`)
    this.name = 'ResponseTooLargeError'
  }
}

/** Blocked IPv4 CIDR ranges: [base address, prefix length]. */
const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]

/** Parse dotted-quad IPv4 to an unsigned 32-bit int, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const v = Number(part)
    if (v > 255) return null
    n = n * 256 + v
  }
  // Normalize to unsigned
  return n >>> 0
}

function isBlockedIpv4Int(addr: number): boolean {
  for (const [base, prefix] of BLOCKED_IPV4_CIDRS) {
    const baseInt = ipv4ToInt(base)!
    const shift = 32 - prefix
    if (addr >>> shift === baseInt >>> shift) return true
  }
  return false
}

/**
 * Expand an IPv6 address (already validated by net.isIP) into 8 16-bit groups.
 * Handles '::' compression and a trailing embedded dotted-quad.
 */
function expandIpv6(ip: string): number[] | null {
  let s = ip
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':')
    const v4 = ipv4ToInt(s.slice(lastColon + 1))
    if (v4 === null) return null
    s =
      s.slice(0, lastColon + 1) +
      (((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16))
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (halves.length === 2 && missing < 0) return null
  if (halves.length === 1 && left.length !== 8) return null
  const groupsHex =
    halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left

  const groups: number[] = []
  for (const g of groupsHex) {
    const v = parseInt(g, 16)
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null
    groups.push(v)
  }
  return groups
}

/**
 * True when the IP must not be fetched server-side (loopback, private,
 * link-local, CGNAT, multicast, reserved, NAT64, IPv4-mapped forms of those).
 * Fails CLOSED: unparseable input is treated as blocked.
 *
 * IPv4-mapped IPv6 is detected structurally (high 96 bits === ::ffff:0:0/96),
 * NOT via a dotted-quad regex: the WHATWG URL parser canonicalizes
 * `[::ffff:169.254.169.254]` to the hex-compressed `[::ffff:a9fe:a9fe]`, which
 * a dotted-form unwrap would wave straight through (plan review A1).
 */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip)

  if (family === 4) {
    const addr = ipv4ToInt(ip)
    if (addr === null) return true
    return isBlockedIpv4Int(addr)
  }

  if (family === 6) {
    const g = expandIpv6(ip)
    if (g === null) return true

    const allZero = g.every((v) => v === 0)
    if (allZero) return true // :: unspecified
    if (g.slice(0, 7).every((v) => v === 0) && g[7] === 1) return true // ::1

    if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
    if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast

    // NAT64 64:ff9b::/96 — embeds an IPv4 address in the low 32 bits
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return true
    }

    // IPv4-mapped ::ffff:0:0/96 — unwrap low 32 bits and re-check as IPv4
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
      return isBlockedIpv4Int(((g[6] << 16) | g[7]) >>> 0)
    }

    return false
  }

  // Not a parseable IP at all — fail closed
  return true
}

/**
 * Reject URLs that must not be fetched server-side: non-http(s) protocols,
 * blocked IP literals (any form the URL parser canonicalizes), and hostnames
 * where ANY DNS-resolved address is blocked.
 *
 * DNS failures propagate as plain errors (an NXDOMAIN is a fetch failure, not
 * a policy block).
 */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Blocked protocol: ${url.protocol}`)
  }

  // URL keeps IPv6 literals bracketed: [::1] → ::1
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '')

  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new UnsafeUrlError(`Blocked address: ${host}`)
    }
    return
  }

  const addresses = await lookup(host, { all: true })
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Host resolved to no addresses: ${host}`)
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new UnsafeUrlError(`Host ${host} resolves to blocked address ${address}`)
    }
  }
}

/**
 * net.connect-compatible lookup that refuses blocked addresses at connect time
 * (#281 F15). Handles both callback shapes: (err, address, family) and, with
 * options.all, (err, addresses[]).
 */
export function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, ...result: any[]) => void
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = addresses as LookupAddress[]
    if (list.length === 0) {
      return callback(new UnsafeUrlError(`Host resolved to no addresses: ${hostname}`))
    }
    const blocked = list.find((a) => isBlockedIp(a.address))
    if (blocked) {
      return callback(
        new UnsafeUrlError(`Host ${hostname} resolves to blocked address ${blocked.address}`)
      )
    }
    if (options?.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

const GUARDED_DISPATCHER = new Agent({ connect: { lookup: guardedLookup } })

export interface SafeFetchOptions {
  timeoutMs?: number
  /** Redirect hops to follow, each re-validated. Default 3. */
  maxRedirects?: number
  headers?: Record<string, string>
  method?: string
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * fetch() with the SSRF guard applied to the initial URL AND every redirect
 * hop. Redirects are followed manually (`redirect: 'manual'`) so a public URL
 * cannot 30x the server into an internal host. One timeout budget spans all
 * hops. All current callers are GETs, so the 303→GET method change is moot.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { timeoutMs = 10_000, maxRedirects = 3, headers, method } = opts
  const signal = AbortSignal.timeout(timeoutMs)

  let current = new URL(url)
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current)
    // undici's own fetch, version-matched to GUARDED_DISPATCHER: handing this
    // Agent to Node's built-in fetch (a different bundled undici on Node 26)
    // dropped response headers — Location and Content-Encoding — so redirects
    // and gzip feeds broke.
    const res = (await undiciFetch(current.toString(), {
      method,
      headers,
      redirect: 'manual',
      signal,
      dispatcher: GUARDED_DISPATCHER,
    })) as unknown as Response

    if (!REDIRECT_STATUSES.has(res.status)) return res

    const location = res.headers.get('location')
    if (!location) return res // malformed redirect; hand it to the caller as-is
    if (hop >= maxRedirects) {
      throw new Error(`Too many redirects fetching ${url}`)
    }
    res.body?.cancel().catch(() => {})
    current = new URL(location, current)
  }
}

export interface ReadTextCappedOptions {
  /**
   * When the body exceeds maxBytes, throw ResponseTooLargeError instead of
   * returning the truncated text. Use for callers (e.g. XML feed parsing)
   * where a silently-cut body corrupts the result. Default false.
   */
  throwOnCap?: boolean
}

/**
 * Read a response body as UTF-8 text, never buffering more than maxBytes.
 *
 * By default, reading stops (and the stream is cancelled) at the cap and the
 * truncated text is returned. With opts.throwOnCap, a body larger than the cap
 * throws ResponseTooLargeError instead — so a truncated body never reaches a
 * parser that would choke on it (#234).
 *
 * Note: rss-parser's parseURL honored the Content-Type charset; we decode
 * UTF-8 only (all current feeds are UTF-8 — accepted).
 */
export async function readTextCapped(
  res: Response,
  maxBytes: number,
  opts: ReadTextCappedOptions = {}
): Promise<string> {
  const body = res.body
  if (!body) return ''

  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let received = 0
  let text = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()

    if (received + value.byteLength > maxBytes) {
      // Body exceeds the cap.
      await reader.cancel().catch(() => {})
      if (opts.throwOnCap) throw new ResponseTooLargeError(maxBytes)
      const chunk = value.subarray(0, maxBytes - received)
      text += decoder.decode(chunk, { stream: true })
      return text + decoder.decode()
    }

    received += value.byteLength
    text += decoder.decode(value, { stream: true })
  }
}
