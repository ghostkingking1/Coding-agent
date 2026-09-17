import dns from "node:dns/promises";
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import net, { type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { ExecutionNetworkPolicy } from "./sandbox.ts";

export interface NetworkProxyLimits {
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxTunnelBytes?: number;
}

export interface NetworkProxyEvent {
  readonly action: "allow" | "deny";
  readonly method: string;
  readonly host?: string;
  readonly port?: number;
  readonly reason?: string;
}

export interface NetworkTargetPolicy {
  readonly hosts: readonly string[];
  readonly ports: readonly number[];
}

export interface ControlledNetworkProxyOptions extends NetworkProxyLimits {
  readonly policy: NetworkTargetPolicy;
  readonly onEvent?: (event: NetworkProxyEvent) => void;
}

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

/**
 * 受控 HTTP/HTTPS 代理只负责目标级过滤；平台 SandboxBackend 仍必须证明目标进程无法绕过代理直连。
 * 因此该类本身不声明任何 Sandbox Capability。
 */
export class ControlledNetworkProxy {
  private readonly hosts: ReadonlySet<string>;
  private readonly ports: ReadonlySet<number>;
  private readonly limits: Required<NetworkProxyLimits>;
  private readonly onEvent?: (event: NetworkProxyEvent) => void;
  private readonly sockets = new Set<Duplex>();
  private readonly server: http.Server;
  private addressValue?: { readonly host: string; readonly port: number };

  constructor(options: ControlledNetworkProxyOptions) {
    this.hosts = new Set(options.policy.hosts.map(normalizeHost));
    this.ports = new Set(options.policy.ports);
    if (this.hosts.size === 0 || this.ports.size === 0) throw new Error("Proxy allowlist must not be empty");
    this.limits = {
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
      maxRequestBytes: options.maxRequestBytes ?? 8 * 1024 * 1024,
      maxResponseBytes: options.maxResponseBytes ?? 32 * 1024 * 1024,
      maxTunnelBytes: options.maxTunnelBytes ?? 64 * 1024 * 1024,
    };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    }
    this.onEvent = options.onEvent;
    this.server = http.createServer((request, response) => void this.handleHttp(request, response));
    this.server.on("connect", (request, socket, head) => void this.handleConnect(request, socket, head));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  async start(): Promise<{ readonly host: string; readonly port: number; readonly url: string }> {
    if (this.addressValue) return { ...this.addressValue, url: `http://${this.addressValue.host}:${this.addressValue.port}` };
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Proxy did not expose a TCP address");
    this.addressValue = { host: "127.0.0.1", port: address.port };
    return { ...this.addressValue, url: `http://${this.addressValue.host}:${this.addressValue.port}` };
  }

  /** start 后返回可直接写入本地最大策略的端点，proxyId 仍由调用方生成并持久化。 */
  executionPolicy(proxyId: string): Extract<ExecutionNetworkPolicy, { readonly mode: "allowlist" }> {
    if (!this.addressValue) throw new Error("Proxy must be started before creating an execution policy");
    if (!proxyId || proxyId.length > 128) throw new Error("Invalid proxy identity");
    return {
      mode: "allowlist",
      hosts: [...this.hosts].sort(),
      ports: [...this.ports].sort((a, b) => a - b),
      proxyId,
      proxyHost: this.addressValue.host,
      proxyPort: this.addressValue.port,
    };
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.addressValue = undefined;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
      if (target.protocol !== "http:" || target.username || target.password) throw new Error("Only credential-free absolute HTTP URLs are accepted");
      const host = normalizeHost(target.hostname);
      const port = parsePort(target.port, 80);
      const address = await this.authorize(host, port);
      this.emit({ action: "allow", method: request.method ?? "GET", host, port });
      await this.forwardHttp(request, response, target, host, port, address);
    } catch (error) {
      const reason = safeError(error);
      this.emit({ action: "deny", method: request.method ?? "GET", reason });
      if (!response.headersSent) response.writeHead(403, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      response.end("Proxy request denied\n");
    }
  }

  private async forwardHttp(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    target: URL,
    host: string,
    port: number,
    address: string,
  ): Promise<void> {
    const headers = sanitizeHeaders(incoming.headers);
    headers.host = port === 80 ? host : `${host}:${port}`;
    let requestBytes = 0;
    const upstream = http.request({
      host: address,
      port,
      method: incoming.method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: this.limits.idleTimeoutMs,
      lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
    });
    upstream.setTimeout(this.limits.idleTimeoutMs, () => upstream.destroy(new Error("upstream idle timeout")));
    upstream.on("response", (upstreamResponse) => {
      outgoing.writeHead(upstreamResponse.statusCode ?? 502, sanitizeHeaders(upstreamResponse.headers));
      let responseBytes = 0;
      upstreamResponse.on("data", (chunk: Buffer) => {
        responseBytes += chunk.byteLength;
        if (responseBytes > this.limits.maxResponseBytes) upstreamResponse.destroy(new Error("response byte limit exceeded"));
      });
      upstreamResponse.on("error", () => outgoing.destroy());
      upstreamResponse.pipe(outgoing);
    });
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { connection: "close" });
      outgoing.end();
    });
    incoming.on("data", (chunk: Buffer) => {
      requestBytes += chunk.byteLength;
      if (requestBytes > this.limits.maxRequestBytes) incoming.destroy(new Error("request byte limit exceeded"));
    });
    incoming.pipe(upstream);
  }

  private async handleConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    try {
      const { host, port } = parseAuthority(request.url ?? "");
      const address = await this.authorize(host, port);
      const upstream = net.connect({ host: address, port, timeout: this.limits.connectTimeoutMs });
      this.sockets.add(upstream);
      upstream.on("close", () => this.sockets.delete(upstream));
      upstream.setTimeout(this.limits.idleTimeoutMs, () => upstream.destroy());
      if (client instanceof net.Socket) client.setTimeout(this.limits.idleTimeoutMs, () => client.destroy());
      upstream.once("connect", () => {
        this.emit({ action: "allow", method: "CONNECT", host, port });
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        enforceTunnelLimit(client, upstream, this.limits.maxTunnelBytes);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => client.destroy());
    } catch (error) {
      this.emit({ action: "deny", method: "CONNECT", reason: safeError(error) });
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  }

  private async authorize(host: string, port: number): Promise<string> {
    if (!this.hosts.has(host) || !this.ports.has(port)) throw new Error("target is outside the approved allowlist");
    if (isIP(host)) throw new Error("literal IP targets are not accepted by domain allowlists");
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (records.length === 0) throw new Error("target did not resolve");
    for (const record of records) {
      if (!isPublicAddress(record.address)) throw new Error("target resolved to a non-public address");
    }
    // 连接固定到本次校验过的地址，不让底层库再次解析域名，阻断 DNS rebinding。
    return records[0]!.address;
  }

  private emit(event: NetworkProxyEvent): void {
    this.onEvent?.(event);
  }
}

function normalizeHost(value: string): string {
  const ascii = domainToASCII(value.trim().replace(/\.$/, "")).toLowerCase();
  if (!ascii || ascii.length > 253 || ascii.startsWith(".") || ascii.includes("..") || !/^[a-z0-9.-]+$/.test(ascii)) {
    throw new Error("invalid target host");
  }
  return ascii;
}

function parsePort(value: string, fallback: number): number {
  const port = value === "" ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid target port");
  return port;
}

function parseAuthority(value: string): { readonly host: string; readonly port: number } {
  if (!value || value.includes("@") || value.includes("/") || value.includes("?")) throw new Error("invalid CONNECT authority");
  const url = new URL(`https://${value}`);
  if (!url.port) throw new Error("CONNECT requires an explicit port");
  return { host: normalizeHost(url.hostname), port: parsePort(url.port, 443) };
}

function sanitizeHeaders(headers: IncomingMessage["headers"]): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_HEADERS.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function enforceTunnelLimit(left: Duplex, right: Socket, limit: number): void {
  let bytes = 0;
  const count = (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > limit) {
      left.destroy();
      right.destroy();
    }
  };
  left.on("data", count);
  right.on("data", count);
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 0)
      || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a! >= 224);
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9")
      || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") || normalized.startsWith("fd")
      || normalized.startsWith("ff")) return false;
    if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
    return true;
  }
  return false;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "proxy policy rejected request";
}
