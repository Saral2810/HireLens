import crypto from 'crypto';

/**
 * Encrypts / decrypts voice-provider credentials before they are stored in the
 * `tenant_voice_providers` table.
 *
 * The key comes ONLY from CREDENTIAL_ENCRYPTION_KEY in your .env (exactly 32 characters).
 * Generate one with:  node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
 *
 * Optional: CREDENTIAL_ENCRYPTION_KEY_PREVIOUS (comma-separated) lets you decrypt rows
 * written with an older key while you rotate to a new one.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

function readKeyString() {
    const keyString = process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!keyString) {
        throw new Error('CREDENTIAL_ENCRYPTION_KEY is not set. Add a 32-character key to your .env file.');
    }
    return keyString;
}

function getKey() {
    const key = Buffer.from(readKeyString(), 'utf-8');
    if (key.length !== 32) {
        throw new Error('CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes long');
    }
    return key;
}

export function encrypt(obj) {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const textToEncrypt = JSON.stringify(obj);
    let encrypted = cipher.update(textToEncrypt, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    const authTag = cipher.getAuthTag().toString('base64');

    return `${iv.toString('base64')}:${authTag}:${encrypted}`;
}

export function decrypt(str) {
    const parts = str.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted credential format');
    }

    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const encryptedText = parts[2];

    const previousKeys = (process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS || '')
        .split(',')
        .map(k => k.trim())
        .filter(Boolean);
    const candidateKeyStrings = [readKeyString(), ...previousKeys];

    let lastError = null;
    for (const keyStr of candidateKeyStrings) {
        try {
            const key = Buffer.from(keyStr, 'utf-8');
            if (key.length !== 32) continue;
            const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return JSON.parse(decrypted);
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Decryption failed for all candidate keys');
}
