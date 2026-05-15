const fs = require('fs').promises;
const path = require('path');
// Файл database.json лежит в корне, а не в папке utils
const DB_FILE = path.resolve(__dirname, '../database.json'); 

async function initDB() {
    try {
        await fs.access(DB_FILE);
    } catch {
        await fs.writeFile(DB_FILE, JSON.stringify({ users: [], payments: [] }, null, 2));
    }
}

async function readDB() {
    await initDB();
    try {
        const data = await fs.readFile(DB_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return { users: [], payments: [] };
    }
}

async function writeDB(data) {
    await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

async function getUser(id) {
    const db = await readDB();
    return db.users.find(x => x.id === Number(id)) || null;
}

async function saveUser(user) {
    const db = await readDB();
    user.id = Number(user.id);
    const index = db.users.findIndex(x => x.id === user.id);
    if (index >= 0) db.users[index] = user;
    else db.users.push(user);
    await writeDB(db);
}

async function addPayment(payment) {
    const db = await readDB();
    db.payments.push(payment);
    await writeDB(db);
}

// Новая функция: проверка просроченных подписок
async function expireSubscriptions() {
    const db = await readDB();
    let changed = false;
    const now = new Date();
    for (const user of db.users) {
        if (!user.permanent && new Date(user.expiresAt) < now) {
            // Срок истек, возвращаем ссылку в пул, если она не была удалена
            const { releaseLink } = require('./links');
            await releaseLink(user.personalLink);
            // Удаляем пользователя из базы или помечаем как неактивного
            user.active = false;
            changed = true;
        }
    }
    if (changed) {
        db.users = db.users.filter(u => u.active !== false);
        await writeDB(db);
    }
}

module.exports = { getUser, saveUser, addPayment, readDB, writeDB, expireSubscriptions };