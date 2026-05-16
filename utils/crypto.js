const crypto = require('crypto');

function normalizeBaseUrl(baseUrl) {
    return String(baseUrl || 'https://voidlink.app').replace(/\/+$/, '');
}

function createAccessToken() {
    return crypto.randomBytes(8).toString('hex');
}

function temporaryLink(token, baseUrl) {
    return `${normalizeBaseUrl(baseUrl)}/a/${token}`;
}

module.exports = { createAccessToken, temporaryLink };
