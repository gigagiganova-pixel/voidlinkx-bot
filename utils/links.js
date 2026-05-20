const fs = require('fs').promises;
const path = require('path');

const ROOT_LINKS_FILE = path.resolve(__dirname, '../links.json');
const DATA_DIR = process.env.DATA_DIR || (process.env.AMVERUM ? '/data' : '');
const LINKS_FILE = DATA_DIR ? path.join(DATA_DIR, 'links.json') : ROOT_LINKS_FILE;

async function initLinks() {
    try {
        await fs.access(LINKS_FILE);
    } catch {
        await fs.mkdir(path.dirname(LINKS_FILE), { recursive: true });
        try {
            const seed = await fs.readFile(ROOT_LINKS_FILE, 'utf-8');
            await fs.writeFile(LINKS_FILE, seed);
        } catch {
            await fs.writeFile(LINKS_FILE, JSON.stringify([], null, 2));
        }
    }
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
