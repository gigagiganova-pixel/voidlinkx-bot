const crypto = require('crypto');

function normalizeBaseUrl(baseUrl) {
    return String(baseUrl || 'https://voidlink.app').replace(/\/+$/, '');
}

function linkToken(realUrl, userId) {
    return crypto
        .createHash('sha256')
        .update(`${realUrl}:${userId}:${process.env.CRYPTO_SECRET || 'voidlink-secret'}`)
        .digest('hex')
        .substring(0, 32);
}

function encryptLink(realUrl, userId, baseUrl) {
    return `${normalizeBaseUrl(baseUrl)}/access/${linkToken(realUrl, userId)}`;
}

module.exports = { encryptLink, linkToken };
