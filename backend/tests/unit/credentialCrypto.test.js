import test from 'node:test';
import assert from 'node:assert';
import { encrypt, decrypt } from '../../src/services/credentialCrypto.js';

test('credentialCrypto module', async (t) => {
    const testKey = '12345678901234567890123456789012';
    process.env.CREDENTIAL_ENCRYPTION_KEY = testKey;

    await t.test('should successfully encrypt and decrypt an object', () => {
        const payload = { xi_api_key: 'test_key', sip_uri: 'sip:test@vobiz.net' };
        
        const encrypted = encrypt(payload);
        assert.ok(typeof encrypted === 'string');
        assert.ok(encrypted.includes(':'));
        assert.strictEqual(encrypted.split(':').length, 3);
        
        const decrypted = decrypt(encrypted);
        assert.deepStrictEqual(decrypted, payload);
    });

    await t.test('should fail if key is not 32 bytes', () => {
        process.env.CREDENTIAL_ENCRYPTION_KEY = 'short_key';
        assert.throws(() => {
            encrypt({ foo: 'bar' });
        }, /exactly 32 bytes/);
        
        process.env.CREDENTIAL_ENCRYPTION_KEY = testKey;
    });
});
