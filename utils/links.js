const fs = require('fs').promises;
const path = require('path');
const LINKS_FILE = path.resolve(__dirname, '../links.json');

async function getLinks() {
    try {
        const data = await fs.readFile(LINKS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

async function saveLinks(data) {
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
