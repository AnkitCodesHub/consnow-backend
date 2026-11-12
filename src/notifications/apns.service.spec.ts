import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { isInvalidTokenResponse, makeProviderToken, normalizePem } from './apns.service';

describe('APNs provider token', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  test('is a valid ES256 JWT with kid, iss and iat', () => {
    const now = Date.parse('2026-11-13T00:00:00Z');
    const jwt = makeProviderToken('ABC123DEFG', 'ZKST8KHYAB', pem, now);
    const [h, c, s] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.deepEqual(header, { alg: 'ES256', kid: 'ABC123DEFG' });
    assert.deepEqual(claims, { iss: 'ZKST8KHYAB', iat: Math.floor(now / 1000) });
    const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    assert.equal(ok, true);
  });

  test('a key pasted with literal \\n still works', () => {
    const oneLine = pem.trim().replace(/\n/g, '\\n');
    assert.doesNotThrow(() => crypto.createPrivateKey(normalizePem(oneLine)));
  });

  test('a key pasted without the BEGIN/END lines still works', () => {
    const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    assert.doesNotThrow(() => crypto.createPrivateKey(normalizePem(body)));
  });
});

describe('dead tokens', () => {
  test('410 Unregistered and bad tokens are dead; other errors are not', () => {
    assert.equal(isInvalidTokenResponse(410, 'Unregistered'), true);
    assert.equal(isInvalidTokenResponse(400, 'BadDeviceToken'), true);
    assert.equal(isInvalidTokenResponse(400, 'DeviceTokenNotForTopic'), true);
    assert.equal(isInvalidTokenResponse(429, 'TooManyRequests'), false);
    assert.equal(isInvalidTokenResponse(403, 'ExpiredProviderToken'), false);
    assert.equal(isInvalidTokenResponse(500, 'InternalServerError'), false);
  });
});
