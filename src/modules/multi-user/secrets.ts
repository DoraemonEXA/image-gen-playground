import { config } from './config';
import crypto from 'node:crypto';

export const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

export function encrypt(secret: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', config().key, iv);
    const content = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
}

export function decrypt(value: string) {
    const data = Buffer.from(value, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', config().key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
