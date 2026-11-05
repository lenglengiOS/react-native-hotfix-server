import type { Server } from 'node:http';

export interface HotfixServerOptions {
  storageDir: string;
  privateKey: string;
  adminToken: string;
  baseUrl?: string;
  maxUpdateBytes?: number;
}

export interface HotfixServer {
  server: Server;
  storage: unknown;
  listen(port?: number, host?: string): Promise<import('node:net').AddressInfo>;
  close(): Promise<void>;
}

export function createHotfixServer(options: HotfixServerOptions): HotfixServer;
