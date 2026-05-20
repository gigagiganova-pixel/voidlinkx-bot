const fsSync = require('fs');
const fs = fsSync.promises;
const path = require('path');

const ROOT_LINKS_FILE = path.resolve(__dirname, '../links.json');
const hasDataMount = process.platform !== 'win32' && fsSync.existsSync('/data');
const DATA_DIR = process.env.DATA_DIR || ((process.env.AMVERUM || hasDataMount) ? '/data' : '');
const LINKS_FILE = DATA_DIR ? path.join(DATA_DIR, 'links.json') : ROOT_LINKS_FILE;

async function readJsonFile(file, fallback) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf-8'));
    } catch {
        return fallback;
    }
}

async function seedLinksFile() {
    await fs.mkdir(path.dirname(LINKS_FILE), { recursive: true });
    try {
        const seed = await fs.readFile(ROOT_LINKS_FILE, 'utf-8');
        await fs.writeFile(LINKS_FILE, seed);
    } catch {
        await fs.writeFile(LINKS_FILE, JSON.stringify([], null, 2));
    }
}

async function hydratePersistentLinks() {
    if (!DATA_DIR) return;
    const current = await readJsonFile(LINKS_FILE, []);
    if (Array.isArray(current) && current.length > 0) return;

    const seed = await readJsonFile(ROOT_LINKS_FILE, []);
    if (!Array.isArray(seed) || seed.length === 0) return;

    await fs.writeFile(LINKS_FILE, JSON.stringify(seed, null, 2));
    console.log(`Persistent links restored from ${path.basename(ROOT_LINKS_FILE)}`);
}

async function initLinks() {
    try {
        await fs.access(LINKS_FILE);
    } catch {
        await seedLinksFile();
    }
    await hydratePersistentLinks();
}

async function getLinks() {
    await initLinks();
    try {
        const data = await fs.readFile(LINKS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

async function saveLinks(data) {
    await initLinks();
    await fs.writeFile(LINKS_FILE, JSON.stringify(data, null, 2));
}

async function reserveFreeLink(owner = {}) {
    const links = await getLinks();
    const freeIndex = links.findIndex(x => x.status === 'free');
    if (freeIndex === -1) return null;
    const [reserved] = links.splice(freeIndex, 1);
    await saveLinks(links);
    return reserved.url;
}

module.exports = { getLinks, saveLinks, reserveFreeLink };
