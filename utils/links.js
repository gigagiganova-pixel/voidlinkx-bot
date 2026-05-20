const fsSync = require('fs');
const fs = fsSync.promises;
const path = require('path');

const ROOT_LINKS_FILE = path.resolve(__dirname, '../links.json');
const hasDataMount = process.platform !== 'win32' && fsSync.existsSync('/data');
const DATA_DIR = process.env.DATA_DIR || ((process.env.AMVERUM || hasDataMount) ? '/data' : '');
const LINKS_FILE = DATA_DIR ? path.join(DATA_DIR, 'links.json') : ROOT_LINKS_FILE;

async function readJsonFile(file, fallback) {
    try {
        const data = await fs.readFile(file, 'utf-8');
        return JSON.parse(data.replace(/^\uFEFF/, ''));
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

async function writeJsonAtomic(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.tmp`;
    const backupFile = `${file}.bak`;
    try {
        await fs.copyFile(file, backupFile);
    } catch {}
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2));
    await fs.rename(tmpFile, file);
}

async function initLinks() {
    try {
        await fs.access(LINKS_FILE);
    } catch {
        await seedLinksFile();
    }
}

async function getLinks() {
    await initLinks();
    try {
        const data = (await fs.readFile(LINKS_FILE, 'utf-8')).replace(/^\uFEFF/, '');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

async function saveLinks(data) {
    await initLinks();
    await writeJsonAtomic(LINKS_FILE, data);
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
