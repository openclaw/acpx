import type http from "node:http";
import { isIP } from "node:net";

function formatAuthority(host: string, port: number): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `${authority}:${port}`;
}

export function formatViewerOrigin(host: string, port: number): string {
  return new URL(`http://${formatAuthority(host, port)}`).origin;
}

function parseAuthority(authority: string | undefined): string | undefined {
  if (!authority || /[\\/?#@\s,%]/.test(authority)) {
    return undefined;
  }
  try {
    return new URL(`http://${authority}`).origin;
  } catch {
    return undefined;
  }
}

function requestOrigin(request: http.IncomingMessage): string | undefined {
  const hosts = request.headersDistinct.host;
  if (hosts?.length !== 1) {
    return undefined;
  }
  const origin = parseAuthority(hosts[0]);
  if (!origin) {
    return undefined;
  }
  const origins = request.headersDistinct.origin;
  if (origins && (origins.length !== 1 || origins[0] !== origin)) {
    return undefined;
  }
  return origin;
}

function localHostnames(address: string): string[] {
  const names = [address];
  const unmapped = address.replace(/^::ffff:/i, "");
  const ipv4 = isIP(unmapped) === 4 ? unmapped : undefined;
  if (ipv4) {
    names.push(ipv4);
  }
  if (address === "::1" || ipv4?.startsWith("127.")) {
    names.push("localhost");
  }
  return names;
}

export function isAllowedViewerRequest(request: http.IncomingMessage, bindHost: string): boolean {
  const port = request.socket.localPort;
  const address = request.socket.localAddress;
  if (!port || !address) {
    return false;
  }
  const origin = requestOrigin(request);
  if (!origin) {
    return false;
  }
  // Wildcard binds admit the accepted socket's local address, never arbitrary Host values.
  return [bindHost, ...localHostnames(address)].some(
    (host) => parseAuthority(formatAuthority(host, port)) === origin,
  );
}
