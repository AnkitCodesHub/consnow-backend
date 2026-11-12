import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as crypto from 'crypto';
import * as http2 from 'http2';

export type ApnsEnv = 'sandbox' | 'production';

export interface ApnsResult {
  ok: boolean;
  status: number;
  /** APNs error reason, e.g. "BadDeviceToken", "Unregistered". */
  reason?: string;
  /** The token is dead (app deleted / wrong environment): stop using it. */
  tokenInvalid: boolean;
  /** Apple's id for this push; look it up in the Push Notifications Console delivery log. */
  apnsId?: string;
}

const HOSTS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** Testing only: send to another HTTP/2 server instead of Apple (e.g. http://127.0.0.1:9443). */
export function apnsHost(env: ApnsEnv): string {
  return process.env.APNS_HOST_OVERRIDE?.trim() || HOSTS[env];
}

/** Apple wants the provider JWT refreshed between 20 and 60 minutes. */
const JWT_TTL_MS = 45 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Turn a .p8 key pasted into an env var (often with literal "\n") back into PEM. */
export function normalizePem(raw: string): string {
  let key = raw.trim().replace(/\\n/g, '\n');
  if (!key.includes('BEGIN PRIVATE KEY')) {
    key = `-----BEGIN PRIVATE KEY-----\n${key.replace(/\s+/g, '')}\n-----END PRIVATE KEY-----`;
  }
  return key;
}

/** ES256 provider token for APNs (token-based auth with a .p8 key). */
export function makeProviderToken(keyId: string, teamId: string, pem: string, nowMs: number): string {
  const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })));
  const claims = b64url(Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) })));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: pem, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

/** Which APNs answers mean "this token will never work again". */
export function isInvalidTokenResponse(status: number, reason?: string): boolean {
  if (status === 410) return true; // Unregistered: app deleted
  return status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic');
}

/**
 * Sends pushes straight to Apple (APNs HTTP/2), no Firebase needed on iOS.
 *
 * Turned on by these env vars (all from developer.apple.com → Keys):
 *   APNS_KEY_ID       the key's 10-character id
 *   APNS_TEAM_ID      your team id (ZKST8KHYAB)
 *   APNS_PRIVATE_KEY  the .p8 file contents (newlines may be written as \n)
 *   APNS_BUNDLE_ID    optional, defaults to com.consnow.ios
 * Without them, iPhone wake-ups are skipped and everything else works as before.
 */
@Injectable()
export class ApnsService implements OnModuleDestroy {
  private readonly logger = new Logger(ApnsService.name);
  private readonly keyId = process.env.APNS_KEY_ID?.trim();
  private readonly teamId = process.env.APNS_TEAM_ID?.trim();
  private readonly bundleId = process.env.APNS_BUNDLE_ID?.trim() || 'com.consnow.ios';
  private readonly pem: string | null;
  private jwt: { token: string; madeAt: number } | null = null;
  private readonly sessions = new Map<ApnsEnv, http2.ClientHttp2Session>();

  constructor() {
    const raw = process.env.APNS_PRIVATE_KEY;
    let pem: string | null = null;
    if (raw && this.keyId && this.teamId) {
      try {
        pem = normalizePem(raw);
        crypto.createPrivateKey(pem); // fail fast on a bad key
        this.logger.log(`APNs enabled (topic ${this.bundleId})`);
      } catch (e: any) {
        pem = null;
        this.logger.error(`APNs disabled, bad APNS_PRIVATE_KEY: ${e?.message}`);
      }
    } else {
      this.logger.warn('APNs disabled (set APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY to wake iPhones)');
    }
    this.pem = pem;
  }

  get enabled(): boolean {
    return this.pem !== null;
  }

  onModuleDestroy() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  /**
   * A silent "content-available" push: iOS wakes the app in the background for ~30 s
   * without showing anything. Low priority (5) as Apple requires for background pushes.
   */
  async sendBackground(deviceToken: string, env: ApnsEnv, data: Record<string, string>): Promise<ApnsResult> {
    const body = JSON.stringify({ aps: { 'content-available': 1 }, ...data });
    return this.post(deviceToken, env, body, {
      'apns-push-type': 'background',
      'apns-priority': '5',
      // A wake-up that arrives minutes late is useless: let Apple drop it after 5 min.
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 300),
      // Only the newest wake-up per phone matters.
      'apns-collapse-id': 'status_request',
    });
  }

  private providerToken(): string {
    const now = Date.now();
    if (!this.jwt || now - this.jwt.madeAt > JWT_TTL_MS) {
      this.jwt = { token: makeProviderToken(this.keyId!, this.teamId!, this.pem!, now), madeAt: now };
    }
    return this.jwt.token;
  }

  private session(env: ApnsEnv): http2.ClientHttp2Session {
    const existing = this.sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2.connect(apnsHost(env));
    s.on('error', (e) => this.logger.warn(`APNs ${env} connection error: ${e.message}`));
    s.on('close', () => {
      if (this.sessions.get(env) === s) this.sessions.delete(env);
    });
    s.on('goaway', () => s.close());
    // Don't keep the Node process alive just for an idle APNs connection.
    s.unref();
    this.sessions.set(env, s);
    return s;
  }

  private post(deviceToken: string, env: ApnsEnv, body: string, headers: Record<string, string>): Promise<ApnsResult> {
    if (!this.enabled) return Promise.resolve({ ok: false, status: 0, reason: 'disabled', tokenInvalid: false });

    return new Promise<ApnsResult>((resolve) => {
      let settled = false;
      const done = (r: ApnsResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      let req: http2.ClientHttp2Stream;
      try {
        req = this.session(env).request({
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${this.providerToken()}`,
          'apns-topic': this.bundleId,
          'content-type': 'application/json',
          ...headers,
        });
      } catch (e: any) {
        this.sessions.delete(env);
        done({ ok: false, status: 0, reason: e?.message ?? 'connect failed', tokenInvalid: false });
        return;
      }

      let status = 0;
      let apnsId: string | undefined;
      let text = '';
      req.setEncoding('utf8');
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        done({ ok: false, status: 0, reason: 'timeout', tokenInvalid: false });
      });
      req.on('response', (h) => {
        status = Number(h[':status']) || 0;
        apnsId = typeof h['apns-id'] === 'string' ? h['apns-id'] : undefined;
      });
      req.on('data', (chunk: string) => {
        text += chunk;
      });
      req.on('end', () => {
        let reason: string | undefined;
        try {
          reason = text ? JSON.parse(text).reason : undefined;
        } catch {
          reason = text || undefined;
        }
        if (status === 403 && reason === 'ExpiredProviderToken') this.jwt = null;
        done({ ok: status === 200, status, reason, tokenInvalid: isInvalidTokenResponse(status, reason), apnsId });
      });
      req.on('error', (e) => done({ ok: false, status, reason: e.message, tokenInvalid: false }));
      req.end(body);
    });
  }
}
