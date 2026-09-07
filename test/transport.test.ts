import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LIMITS,
  defaultWebSocketFactory,
  RustpadSession,
} from '../src/session.js';
import { testConfig } from './harness.js';

/**
 * The real transport against a real socket.
 *
 * Every other suite replaces the WebSocket with a fake that hands the session
 * whole messages, so nothing in them can say what happens *before* a message
 * is whole. That is where the frame limit has to hold: a frame header
 * announces its payload length, and an implementation that buffers the
 * payload before anyone looks at the length has already spent the memory the
 * limit was meant to protect. undici's default is 128 MB per message, which
 * is more than the process this server runs in is usually allowed.
 *
 * The server here is a plain HTTP server that completes the WebSocket
 * handshake by hand and then writes raw frames — enough of the protocol to
 * announce a payload and never deliver it.
 */

/** RFC 6455 § 4.2.2: the accept key is a fixed GUID appended and hashed. */
function acceptKey(key: string): string {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

/** An unmasked text frame header (server to client, FIN set). */
function textFrame(payload: string, announce?: number): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const length = announce ?? body.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, body]);
}

interface Upstream {
  url: string;
  /** Resolves when the client side hung up. */
  closed: Promise<void>;
  server: Server;
}

/** A WebSocket server that runs `script` once the handshake is done. */
async function upstream(script: (socket: Duplex) => void): Promise<Upstream> {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
  server.on('upgrade', (request, socket) => {
    const key = String(request.headers['sec-websocket-key'] ?? '');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    socket.on('close', () => onClosed());
    socket.on('error', () => {});
    // The closing handshake: a client's close frame (opcode 8, masked) is
    // answered with one and the socket ended. Without this the client waits
    // for the echo and the socket never closes.
    socket.on('data', (chunk: Buffer) => {
      if ((chunk[0]! & 0x0f) === 0x08) {
        socket.write(Buffer.from([0x88, 0x00]));
        socket.end();
      }
    });
    script(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, closed, server };
}

const limits = {
  ...DEFAULT_LIMITS,
  openTimeoutMs: 2000,
  settleIdleMs: 100,
  settleDeadlineMs: 2000,
};

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('the default WebSocket factory against a real socket', () => {
  it('reads a pad through undici end to end', async () => {
    const up = await upstream((socket) => {
      socket.write(textFrame(JSON.stringify({ Identity: 7 })));
      socket.write(
        textFrame(
          JSON.stringify({
            History: { start: 0, operations: [{ id: 1, operation: ['hi'] }] },
          })
        )
      );
    });
    servers.push(up.server);
    const session = await RustpadSession.open(
      testConfig({ url: up.url }),
      'pad',
      defaultWebSocketFactory,
      limits
    );
    expect(session.state.text).toBe('hi');
    expect(session.state.revision).toBe(1);
    session.close();
    await up.closed;
  });

  it('fails the connection on a frame header that announces more than the limit, before the payload arrives', async () => {
    // Announces two megabytes and delivers sixty-four kilobytes. A client
    // that buffers first would wait for the rest, and with nothing more
    // arriving the settle window would run out and the session would open
    // on an empty pad — which is exactly what the old code did, while
    // holding whatever had arrived. The limited client refuses at the
    // header and hangs up.
    let written = 0;
    const up = await upstream((socket) => {
      socket.write(textFrame(JSON.stringify({ Identity: 7 })));
      const part = 'x'.repeat(64 * 1024);
      written += socket.write(textFrame(part, 2 * 1024 * 1024)) ? 1 : 0;
    });
    servers.push(up.server);
    const opened = RustpadSession.open(
      testConfig({ url: up.url }),
      'pad',
      defaultWebSocketFactory,
      { ...limits, maxFrameBytes: 1024 * 1024 }
    );
    await expect(opened).rejects.toThrow(
      /connection failed|closed the connection/
    );
    expect(written).toBe(1);
    // The client hung up: the server sees its socket close without ever
    // having sent the rest of the payload.
    await up.closed;
  });
});
