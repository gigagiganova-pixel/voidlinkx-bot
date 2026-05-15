const crypto = require('crypto');

function encryptLink(realUrl, userId) {
    // Простое, но красивое шифрование для временного доступа
    const hash = crypto.createHash('md5').update(`${realUrl}${userId}${process.env.CRYPTO_SECRET}`).digest('hex').substring(0, 10);
    // Реальная ссылка скрыта, но бот знает, какую ссылку выдать
    return `https://voidlink.app/access/${hash}`;
}

module.exports = { encryptLink };