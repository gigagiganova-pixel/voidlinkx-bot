const fs = require('fs').promises;
const path = require('path');
// Файл database.json лежит в корне, а не в папке utils
const DB_FILE = path.resolve(__dirname, '../database.json'); 

async function initDB() {
    try {
        await fs.access(DB_FILE);
    } catch {
        await fs.writeFile(DB_FILE, JSON.stringify({ users: [], payments: [], reviews: [] }, null, 2));
    }
}

async function readDB() {
    await initDB();
    try {
        const data = await fs.readFile(DB_FILE, 'utf-8');
        const db = JSON.parse(data);
        db.users = Array.isArray(db.users) ? db.users : [];
        db.payments = Array.isArray(db.payments) ? db.payments : [];
        db.reviews = Array.isArray(db.reviews) ? db.reviews : [];
        return db;
    } catch {
        return { users: [], payments: [], reviews: [] };
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

async function resetDB() {
    const empty = { users: [], payments: [], reviews: [] };
    await writeDB(empty);
    return empty;
}

module.exports = { getUser, saveUser, addPayment, readDB, writeDB, resetDB };
