const fs = require('fs').promises;
const path = require('path');

const ROOT_DB_FILE = path.resolve(__dirname, '../database.json');
const DATA_DIR = process.env.DATA_DIR || (process.env.AMVERUM ? '/data' : '');
const DB_FILE = DATA_DIR ? path.join(DATA_DIR, 'database.json') : ROOT_DB_FILE;
const EMPTY_DB = { users: [], payments: [], reviews: [], paymentRequests: [], withdrawals: [], referralEarnings: [] };

async function initDB() {
    try {
        await fs.access(DB_FILE);
    } catch {
        await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
        try {
            const seed = await fs.readFile(ROOT_DB_FILE, 'utf-8');
            await fs.writeFile(DB_FILE, seed);
        } catch {
            await fs.writeFile(DB_FILE, JSON.stringify(EMPTY_DB, null, 2));
        }
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
        db.paymentRequests = Array.isArray(db.paymentRequests) ? db.paymentRequests : [];
        db.withdrawals = Array.isArray(db.withdrawals) ? db.withdrawals : [];
        db.referralEarnings = Array.isArray(db.referralEarnings) ? db.referralEarnings : [];
        return db;
    } catch {
        return { ...EMPTY_DB };
    }
}

async function writeDB(data) {
    await initDB();
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
    const empty = { ...EMPTY_DB };
    await writeDB(empty);
    return empty;
}

module.exports = { getUser, saveUser, addPayment, readDB, writeDB, resetDB };
