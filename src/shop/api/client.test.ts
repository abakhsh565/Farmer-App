import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callShopRpc, classifyFailure, farmerJoinShop, farmerMe, farmerSendMessage } from './client';

/**
 * The client is tested against a socket, not a mocked `fetch`.
 *
 * What has to be true is that this app speaks the shop's protocol — the path, the
 * two headers, the parameters by their documented names, and the error shapes the
 * contract names. A stub that returns a fixture proves none of that.
 */

type Seen = { path: string; apikey: string; authorization: string; body: Record<string, unknown> };

let server: Server;
let base: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += String(chunk);
    });
    request.on('end', () => {
      seen.push({
        path: request.url ?? '',
        apikey: String(request.headers.apikey ?? ''),
        authorization: String(request.headers.authorization ?? ''),
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      response.writeHead(reply.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: {} };
});

const config = () => ({ url: base, key: 'anon-key', configured: true });

describe('callShopRpc', () => {
  it('posts to the rpc path with the anon key in both headers', async () => {
    reply = { status: 200, body: [{ farmer_id: 'f1' }] };
    const result = await callShopRpc('farmer_api_me', { p_token: 'tok' }, config());

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/rest/v1/rpc/farmer_api_me');
    expect(seen[0]?.apikey).toBe('anon-key');
    expect(seen[0]?.authorization).toBe('Bearer anon-key');
    expect(seen[0]?.body).toEqual({ p_token: 'tok' });
  });

  it('sends the farmer credential as a parameter, never as the bearer', async () => {
    await farmerSendMessage('credential-token', 'salam').then(() => undefined);
    // The call above had no config override, and the suite pins the shop backend
    // empty, so nothing left the process — which is itself the assertion that an
    // unconfigured build makes no network call.
    expect(seen).toHaveLength(0);

    await callShopRpc(
      'farmer_api_send_message',
      { p_token: 'credential-token', p_body: 'salam', p_shop_id: null },
      config(),
    );
    expect(seen[0]?.authorization).toBe('Bearer anon-key');
    expect(seen[0]?.body).toEqual({ p_token: 'credential-token', p_body: 'salam', p_shop_id: null });
  });

  it('introduces the farmer with the three parameters the shop’s join declares', async () => {
    reply = { status: 200, body: [{ farmer_id: 'f1', token: 't', shop_id: 's1' }] };
    await farmerJoinShop('WNYB2G', { phone: '923001234567', name: 'Bilal' }, config());

    expect(seen[0]?.path).toBe('/rest/v1/rpc/farmer_api_join_shop');
    expect(seen[0]?.body).toEqual({
      p_code: 'WNYB2G',
      p_phone: '923001234567',
      p_name: 'Bilal',
      p_village: null,
    });
  });

  it('does not call anything when the build has no shop backend', async () => {
    const result = await callShopRpc('farmer_api_me', { p_token: 'x' }, {
      url: null,
      key: null,
      configured: false,
    });

    expect(result).toMatchObject({ ok: false, error: 'unconfigured' });
    expect(seen).toHaveLength(0);
  });

  it('reports an unreachable shop rather than throwing at the screen', async () => {
    const result = await callShopRpc('farmer_api_me', { p_token: 'x' }, {
      url: 'http://127.0.0.1:1',
      key: 'k',
      configured: true,
    });

    expect(result).toMatchObject({ ok: false, error: 'unavailable' });
  });

  it('keeps the shop’s NOT_AUTHORIZED apart from every other refusal', async () => {
    reply = { status: 400, body: { code: 'P0001', message: 'NOT_AUTHORIZED: token revoked' } };
    const result = await farmerMe('gone');
    expect(result).toMatchObject({ ok: false, error: 'unconfigured' });

    const direct = await callShopRpc('farmer_api_me', { p_token: 'gone' }, config());
    expect(direct).toMatchObject({ ok: false, error: 'unauthorized' });
  });
});

describe('classifyFailure', () => {
  it('reads the shop’s own words', () => {
    expect(classifyFailure(400, { message: 'NOT_AUTHORIZED: nope' })).toBe('unauthorized');
    expect(classifyFailure(400, { message: 'NOT_FOUND: no such shop' })).toBe('not-found');
    expect(classifyFailure(400, { message: 'VALIDATION: body is empty' })).toBe('validation');
  });

  it('treats a missing function as a deployment fact, not a credential problem', () => {
    expect(classifyFailure(404, { code: 'PGRST202', message: 'function not found' })).toBe(
      'unavailable',
    );
    expect(classifyFailure(404, {})).toBe('unavailable');
  });

  it('does not read a bare 401 or 403 as a verdict on the credential', () => {
    /*
     * Only the shop's own NOT_AUTHORIZED message (above) ends a credential. A bare
     * gateway 401/403 was measured while the same token still read and sent text;
     * reading it as a verdict signed the farmer out in the middle of a conversation.
     */
    expect(classifyFailure(401, {})).toBe('unavailable');
    expect(classifyFailure(403, {})).toBe('unavailable');
  });
});
