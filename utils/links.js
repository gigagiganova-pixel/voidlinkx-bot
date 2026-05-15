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

async function reserveFreeLink() {
    const links = await getLinks();
    const freeIndex = links.findIndex(x => x.status === 'free');
    if (freeIndex === -1) return null;
    links[freeIndex].status = 'used';
    await saveLinks(links);
    return links[freeIndex].url;
}

async function releaseLink(url) {
    const links = await getLinks();
    const item = links.find(x => x.url === url);
    if (item && item.status === 'used') {
        item.status = 'free';
        await saveLinks(links);
    }
}

async function removeLinkFromPool(url) {
    const links = await getLinks();
    const filtered = links.filter(x => x.url !== url);
    await saveLinks(filtered);
}

module.exports = { getLinks, reserveFreeLink, releaseLink, removeLinkFromPool };