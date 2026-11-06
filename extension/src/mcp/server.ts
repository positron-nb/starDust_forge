/**
 * Streamable-HTTP MCP server hosted inside the extension host, bound to 127.0.0.1
 * on a random port and protected by a per-activation bearer token. TrueForge
 * reaches it via the header-auth connector we register (see registerWithTrueForge).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { TrueForge } from '@truefoundry/trueforge-sdk';

export type ToolInstaller = (server: McpServer) => void;

export class EditorMcpServer {
  private httpServer?: http.Server;
  readonly token = crypto.randomBytes(24).toString('hex');
  port = 0;

  constructor(private readonly install: ToolInstaller, private readonly log: (m: string) => void = () => {}) {}

  get url(): string { return `http://127.0.0.1:${this.port}/mcp`; }

  async start(): Promise<void> {
    this.httpServer = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>(resolve => this.httpServer!.listen(0, '127.0.0.1', resolve));
    this.port = (this.httpServer.address() as AddressInfo).port;
    this.log(`MCP server listening on ${this.url}`);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    // Stateless mode: a fresh server+transport per request keeps the tool layer simple.
    const server = new McpServer({ name: 'forge-workspace', version: '0.1.0' });
    this.install(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      const body = await readBody(req);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (err) {
      this.log(`MCP request failed: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  /** Register (or update) this server as a TrueForge connector with header auth. */
  async registerWithTrueForge(client: TrueForge, name: string): Promise<void> {
    await client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote', name, url: this.url,
        description: 'VS Code workspace tools exposed by the Forge Agent extension',
        auth: { type: 'header', headers: { Authorization: `Bearer ${this.token}` } },
      } as never,
    });
    this.log(`Registered MCP connector "${name}" with TrueForge`);
  }

  async stop(): Promise<void> {
    // closeAllConnections: TrueForge keeps HTTP connections alive; without it close() never resolves.
    this.httpServer?.closeAllConnections();
    await new Promise<void>(r => (this.httpServer ? this.httpServer.close(() => r()) : r()));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', c => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
