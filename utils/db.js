const fsSync = require('fs');
const fs = fsSync.promises;
const path = require('path');

const ROOT_DB_FILE = path.resolve(__dirname, '../database.json');
const hasDataMount = process.platform !== 'win32' && fsSync.existsSync('/data');
const DATA_DIR = process.env.DATA_DIR || ((process.env.AMVERUM || hasDataMount) ? '/data' : '');
const DB_FILE = DATA_DIR ? path.join(DATA_DIR, 'database.json') : ROOT_DB_FILE;
const DATA_RESET_VERSION = process.env.DATA_RESET_VERSION || '';
const EMPTY_DB = { users: [], payments: [], reviews: [], paymentRequests: [], withdrawals: [], referralEarnings: [], meta: {} };
let writeQueue = Promise.resolve();

async function readJsonFile(file, fallback) {
    try {
        const data = await fs.readFile(file, 'utf-8');
        return JSON.parse(data.replace(/^\uFEFF/, ''));
    } catch {
        return fallback;
    }
}

function hasBusinessData(db = {}) {
    return ['users', 'payments', 'paymentRequests', 'reviews', 'withdrawals', 'referralEarnings']
        .some((key) => Array.isArray(db[key]) && db[key].length > 0);
}

function normalizeDB(db = {}) {
    db.users = Array.isArray(db.users) ? db.users : [];
    db.payments = Array.isArray(db.payments) ? db.payments : [];
    db.reviews = Array.isArray(db.reviews) ? db.reviews : [];
    db.paymentRequests = Array.isArray(db.paymentRequests) ? db.paymentRequests : [];
    db.withdrawals = Array.isArray(db.withdrawals) ? db.withdrawals : [];
    db.referralEarnings = Array.isArray(db.referralEarnings) ? db.referralEarnings : [];
    db.meta = db.meta && typeof db.meta === 'object' ? db.meta : {};
    return db;
}

async function seedDBFile() {
    await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
    try {
        const seed = await fs.readFile(ROOT_DB_FILE, 'utf-8');
        await fs.writeFile(DB_FILE, seed);
    } catch {
        await fs.writeFile(DB_FILE, JSON.stringify(EMPTY_DB, null, 2));
    }
}

async function writeJsonAtomic(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const backupFile = `${file}.bak`;
    try {
        await fs.copyFile(file, backupFile);
    } catch {}
    try {
        await fs.writeFile(tmpFile, JSON.stringify(data, null, 2));
        await fs.rename(tmpFile, file);
    } catch (error) {
        try {
            await fs.unlink(tmpFile);
        } catch {}
        throw error;
    }
}

function enqueueWrite(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
}

async function hydratePersistentDB() {
    if (!DATA_DIR) return;
    const current = await readJsonFile(DB_FILE, EMPTY_DB);
    const currentVersion = normalizeDB(current).meta.seedVersion || '';
    if (DATA_RESET_VERSION && currentVersion !== DATA_RESET_VERSION) {
        const seed = normalizeDB(await readJsonFile(ROOT_DB_FILE, EMPTY_DB));
        seed.meta.seedVersion = DATA_RESET_VERSION;
        await writeJsonAtomic(DB_FILE, seed);
        console.log(`Persistent database reset to data version ${DATA_RESET_VERSION}`);
        return;
    }

    if (hasBusinessData(current)) return;

    const seed = await readJsonFile(ROOT_DB_FILE, EMPTY_DB);
    if (!hasBusinessData(seed)) return;

    await fs.writeFile(DB_FILE, JSON.stringify(seed, null, 2));
    console.log(`Persistent database restored from ${path.basename(ROOT_DB_FILE)}`);
}

async function initDB() {
    try {
        await fs.access(DB_FILE);
    } catch {
        await seedDBFile();
    }
    await hydratePersistentDB();
}

async function readDB() {
    await initDB();
    try {
        const data = (await fs.readFile(DB_FILE, 'utf-8')).replace(/^\uFEFF/, '');
        return normalizeDB(JSON.parse(data));
    } catch {
        return normalizeDB({ ...EMPTY_DB });
    }
}

async function writeDB(data) {
    return enqueueWrite(async () => {
        await initDB();
        await writeJsonAtomic(DB_FILE, normalizeDB(data));
    });
}

async function updateDB(mutator) {
    return enqueueWrite(async () => {
        await initDB();
        const db = normalizeDB(await readJsonFile(DB_FILE, { ...EMPTY_DB }));
        const result = await mutator(db);
        await writeJsonAtomic(DB_FILE, normalizeDB(db));
        return result;
    });
}

async function getUser(id) {
    const db = await readDB();
    return db.users.find(x => x.id === Number(id)) || null;
}

async function saveUser(user) {
    return updateDB((db) => {
        user.id = Number(user.id);
        const index = db.users.findIndex(x => x.id === user.id);
        if (index >= 0) db.users[index] = user;
        else db.users.push(user);
        return user;
    });
}

async function addPayment(payment) {
    return updateDB((db) => {
        db.payments.push(payment);
        return payment;
    });
}

async function resetDB() {
    const empty = { ...EMPTY_DB };
    await writeDB(empty);
    return empty;
}

module.exports = { getUser, saveUser, addPayment, readDB, writeDB, updateDB, resetDB };
