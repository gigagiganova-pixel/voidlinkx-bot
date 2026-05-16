require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');
const fs = require('fs');

const { getUser, saveUser, addPayment, readDB, writeDB, expireSubscriptions } = require('./utils/db');
const { getLinks, reserveFreeLink, removeLinkFromPool } = require('./utils/links');
const { encryptLink, linkToken } = require('./utils/crypto');

// --- НАСТРОЙКИ ---
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const ADMIN_ID = Number(process.env.ADMIN_ID);
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const photoStart = path.resolve(__dirname, 'assets/start.jpg');
const photoAbout = path.resolve(__dirname, 'assets/about.jpg');
const photoPayment = path.resolve(__dirname, 'assets/payment.jpg');

const price = process.env.PRICE || '500';
const botUsername = (process.env.BOT_USERNAME || 'voidlinkx_bot').replace(/^@/, '');
const publicBaseUrl = (process.env.PUBLIC_URL || process.env.ACCESS_BASE_URL || 'https://voidlink.app').replace(/\/+$/, '');
let pollingConflictShown = false;

const MAIN_KEYBOARD = {
    inline_keyboard: [
        [{ text: '💎 Купить доступ', callback_data: 'buy' }],
        [{ text: '🛡 О проекте и безопасности', callback_data: 'about' }]
    ]
};

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function profileFromTelegram(from = {}) {
    return {
        id: Number(from.id),
        username: from.username || '',
        firstName: from.first_name || '',
        lastName: from.last_name || '',
        languageCode: from.language_code || ''
    };
}

function fullName(profile = {}) {
    return [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'Пользователь Telegram';
}

function profileUrl(profile = {}) {
    return profile.username ? `https://t.me/${profile.username}` : `tg://user?id=${profile.id}`;
}

function adminProfileText(profile = {}) {
    const username = profile.username ? `@${profile.username}` : 'не указан';
    return [
        `🆔 Telegram ID: <code>${profile.id}</code>`,
        `👤 Имя: ${escapeHtml(fullName(profile))}`,
        `🔗 Username: ${escapeHtml(username)}`,
        `💬 Профиль: <a href="${profileUrl(profile)}">открыть в Telegram</a>`
    ].join('\n');
}

async function upsertUserProfile(profile) {
    if (!profile.id) return null;

    const existing = await getUser(profile.id);
    const now = new Date().toISOString();
    const user = {
        id: profile.id,
        telegramId: profile.id,
        username: profile.username || existing?.username || '',
        firstName: profile.firstName || existing?.firstName || '',
        lastName: profile.lastName || existing?.lastName || '',
        languageCode: profile.languageCode || existing?.languageCode || '',
        monthsPaid: existing?.monthsPaid || 0,
        personalLink: existing?.personalLink || null,
        permanent: Boolean(existing?.permanent),
        expiresAt: existing?.expiresAt || null,
        active: Boolean(existing?.active),
        remindersSent: existing?.remindersSent || {},
        createdAt: existing?.createdAt || now,
        updatedAt: now
    };

    await saveUser(user);
    return user;
}

function buildStartText() {
    return [
        '🛰 <b>VOIDLINK X</b>',
        '<b>Твой личный канал связи</b>',
        '',
        'Приватная WebRTC/P2P-система для защищённой связи прямо в браузере. Персональный доступ выдаётся вручную после проверки оплаты.',
        '',
        '🛡 личная ссылка из ограниченного пула',
        '🔒 без серверной записи разговоров и переписок',
        '⚡ временный защищённый шлюз на 1 месяц',
        '🏆 после 3 оплат открывается постоянная оригинальная ссылка',
        '',
        `💎 <b>Стоимость:</b> ${escapeHtml(price)} ₽ / месяц`
    ].join('\n');
}

function buildAboutText() {
    return [
        '🛡 <b>VOIDLINK X: личный канал связи</b>',
        '',
        'VOIDLINK X работает через WebRTC: соединение создаётся напрямую между участниками, а ссылка выдаётся персонально после ручной проверки оплаты.',
        '',
        '<b>Как устроен доступ:</b>',
        `💎 1 месяц — временный защищённый шлюз за ${escapeHtml(price)} ₽.`,
        '🔁 2 месяц — продление того же персонального шлюза.',
        '🏆 3 месяц — постоянная оригинальная ссылка из пула, закреплённая за вами.',
        '',
        'Проект не продаёт «просто HTML». Вы получаете готовый приватный экземпляр браузерной системы связи, развёрнутый отдельно и выданный персонально.'
    ].join('\n');
}

function buildPaymentText() {
    return [
        '💳 <b>Оплата доступа VOIDLINK X</b>',
        '<b>Твой личный канал связи активируется вручную</b>',
        '',
        `💎 <b>Сумма:</b> ${escapeHtml(price)} ₽`,
        '',
        '1. Нажмите кнопку оплаты.',
        '2. После перевода вернитесь в бот.',
        '3. Нажмите «Я оплатил».',
        '4. Администратор проверит платёж и выдаст персональный доступ.',
        '',
        '⏱ Обычно проверка занимает 5-10 минут.'
    ].join('\n');
}

function buildClientAccessText({ linkToSend, months, isPermanent }) {
    if (isPermanent) {
        return [
            '🏆 <b>Доступ подтверждён</b>',
            '',
            'Вы получили постоянный доступ VOIDLINK X.',
            '',
            `🔗 <b>Ваша оригинальная ссылка:</b>\n${escapeHtml(linkToSend)}`,
            '',
            '🔒 Сохраните её в надёжном месте. Эта ссылка закреплена за вами.'
        ].join('\n');
    }

    return [
        '✅ <b>Доступ подтверждён</b>',
        '',
        'Ваш защищённый шлюз активирован на 1 месяц.',
        '',
        `🔐 <b>Временная ссылка:</b>\n${escapeHtml(linkToSend)}`,
        '',
        `💎 <b>Прогресс:</b> ${months}/3 оплат до постоянного доступа.`,
        `⏳ Осталось: ${3 - months} мес.`
    ].join('\n');
}

function addOneMonthFromCurrentAccess(user) {
    const now = new Date();
    const currentExpires = user?.expiresAt ? new Date(user.expiresAt) : null;
    const base = currentExpires && currentExpires > now ? currentExpires : now;
    const expires = new Date(base);
    expires.setMonth(expires.getMonth() + 1);
    return expires;
}

function daysUntil(date) {
    const ms = new Date(date).getTime() - Date.now();
    return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function reminderText(daysLeft, expiresAt) {
    const dayWord = daysLeft === 1 ? 'день' : 'дня';
    return [
        '⏳ <b>VOIDLINK X: подписка скоро закончится</b>',
        '',
        `До окончания временного доступа осталось ${daysLeft} ${dayWord}.`,
        `📅 Дата окончания: ${new Date(expiresAt).toLocaleDateString('ru-RU')}.`,
        '',
        '💎 Чтобы продлить доступ, откройте бота и нажмите «Купить доступ». После 3 подтверждённых оплат вы получите постоянную оригинальную ссылку.'
    ].join('\n');
}

async function sendPaymentMessage(chatId, text, replyMarkup) {
    const options = {
        parse_mode: 'HTML',
        reply_markup: replyMarkup
    };

    if (fs.existsSync(photoPayment)) {
        try {
            await bot.sendPhoto(chatId, photoPayment, { ...options, caption: text });
            return;
        } catch (error) {
            console.error('Не удалось отправить payment.jpg:', error.message);
        }
    }

    await bot.sendMessage(chatId, text, options);
}

async function sendExpiryReminders() {
    const db = await readDB();
    let changed = false;

    for (const user of db.users) {
        if (!user.active || user.permanent || !user.expiresAt) continue;

        const daysLeft = daysUntil(user.expiresAt);
        if (![3, 1].includes(daysLeft)) continue;

        user.remindersSent = user.remindersSent || {};
        if (user.remindersSent[String(daysLeft)]) continue;

        try {
            await bot.sendMessage(user.telegramId || user.id, reminderText(daysLeft, user.expiresAt), { parse_mode: 'HTML' });
            user.remindersSent[String(daysLeft)] = new Date().toISOString();
            changed = true;
        } catch (error) {
            console.error(`Не удалось отправить напоминание пользователю ${user.id}:`, error.message);
        }
    }

    if (changed) {
        await writeDB(db);
    }
}

async function runMaintenance() {
    await sendExpiryReminders();
    await expireSubscriptions();
}

// Запускаем фоновую проверку подписок и напоминаний (раз в 6 часов)
setInterval(runMaintenance, 6 * 60 * 60 * 1000);

// --- КОМАНДА /start ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await upsertUserProfile(profileFromTelegram(msg.from));

    try {
        await bot.sendPhoto(chatId, photoStart, { caption: buildStartText(), parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD });
    } catch (e) {
        await bot.sendMessage(chatId, buildStartText(), { parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD });
    }
});

// --- ОБРАБОТКА КНОПОК ---
bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    try {
        await bot.answerCallbackQuery(query.id);
        const profile = profileFromTelegram(query.from);

        // КНОПКА: КУПИТЬ ДОСТУП
        if (query.data === 'buy') {
            await upsertUserProfile(profile);
            const payUrl = `https://yoomoney.ru/quickpay/confirm.xml?receiver=${process.env.YOOMONEY_WALLET}&quickpay-form=small&targets=VOIDLINK%20X&sum=${price}&label=${profile.id}&successURL=https://t.me/${botUsername}`;
            
            await sendPaymentMessage(chatId, buildPaymentText(), {
                inline_keyboard: [
                    [{ text: '💳 Перейти к оплате', url: payUrl }],
                    [{ text: '✅ Я оплатил', callback_data: 'check_payment' }]
                ]
            });
        }

        // КНОПКА: О ПРОЕКТЕ
        if (query.data === 'about') {
            try {
                await bot.sendPhoto(chatId, photoAbout, { caption: buildAboutText(), parse_mode: 'HTML' });
            } catch (e) {
                await bot.sendMessage(chatId, buildAboutText(), { parse_mode: 'HTML' });
            }
        }

        // ПОЛЬЗОВАТЕЛЬ НАЖАЛ "Я ОПЛАТИЛ"
        if (query.data === 'check_payment') {
            await upsertUserProfile(profile);

            // Отправляем админу запрос на подтверждение
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '✅ Подтвердить', callback_data: `confirm_${profile.id}` },
                        { text: '✖️ Отклонить', callback_data: `reject_${profile.id}` }
                    ],
                    [{ text: '💬 Написать пользователю', url: profileUrl(profile) }]
                ]
            };
            
            await bot.sendMessage(
                ADMIN_ID, 
                [
                    '💰 <b>Новая заявка на оплату</b>',
                    '',
                    adminProfileText(profile),
                    '',
                    `💎 <b>Сумма:</b> ${escapeHtml(price)} ₽`,
                    `🏷 <b>Метка ЮMoney:</b> <code>${profile.id}</code>`,
                    '',
                    '🧾 Проверьте ЮMoney и подтвердите доступ.'
                ].join('\n'),
                { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true }
            );
            
            await bot.sendMessage(profile.id, '✅ Заявка отправлена администратору. Доступ будет выдан после ручной проверки платежа, обычно в течение 5-10 минут.');
        }

        // АДМИН ПОДТВЕРДИЛ
        if (query.data.startsWith('confirm_')) {
            if (query.from.id !== ADMIN_ID) return;
            const userId = parseInt(query.data.split('_')[1]);
            
            let user = await getUser(userId);
            let link;
            let months = (user?.monthsPaid || 0) + 1;
            const isPermanent = months >= 3;

            if (!user || !user.personalLink) {
                link = await reserveFreeLink();
                if (!link) {
                    await bot.sendMessage(ADMIN_ID, `⚠️ Нет свободных ссылок для пользователя ${userId}. Добавьте ссылки через /addlink <url>.`);
                    return;
                }
            } else {
                link = user.personalLink;
            }

            if (isPermanent) {
                await removeLinkFromPool(link);
            }

            const expires = addOneMonthFromCurrentAccess(user);

            user = {
                id: userId,
                telegramId: userId,
                username: user?.username || '',
                firstName: user?.firstName || '',
                lastName: user?.lastName || '',
                languageCode: user?.languageCode || '',
                monthsPaid: months,
                personalLink: link,
                permanent: isPermanent,
                expiresAt: expires.toISOString(),
                active: true,
                remindersSent: {},
                createdAt: user?.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            await saveUser(user);
            await addPayment({ user: userId, amount: price, date: new Date().toISOString() });

            const linkToSend = isPermanent ? link : encryptLink(link, userId, publicBaseUrl);

            await bot.sendMessage(userId, buildClientAccessText({ linkToSend, months, isPermanent }), { parse_mode: 'HTML', disable_web_page_preview: true });
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_ID, message_id: query.message.message_id });
            await bot.sendMessage(ADMIN_ID, `✅ Доступ выдан пользователю ${userId}: ${months}-й месяц${isPermanent ? ', постоянная ссылка' : ''}.`);
        }

        // АДМИН ОТКЛОНИЛ
        if (query.data.startsWith('reject_')) {
            if (query.from.id !== ADMIN_ID) return;
            const userId = parseInt(query.data.split('_')[1]);
            await bot.sendMessage(userId, '✖️ Платёж не подтверждён. Пожалуйста, проверьте сумму, кошелёк и попробуйте отправить заявку ещё раз.');
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_ID, message_id: query.message.message_id });
            await bot.sendMessage(ADMIN_ID, `✖️ Заявка пользователя ${userId} отклонена.`);
        }

    } catch (error) {
        console.error('Ошибка в callback_query:', error.message);
    }
});

// --- АДМИН-КОМАНДЫ ---
bot.onText(/\/admin/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    await bot.sendMessage(ADMIN_ID, [
        '🛰 <b>VOIDLINK X ADMIN</b>',
        '',
        '📦 /links — статус пула ссылок',
        '👥 /users — клиенты и Telegram ID',
        '💰 /stats — финансы',
        '➕ /addlink &lt;url&gt; — добавить ссылку'
    ].join('\n'), { parse_mode: 'HTML' });
});

bot.onText(/\/links/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const links = await getLinks();
    const free = links.filter(l => l.status === 'free').length;
    const used = links.filter(l => l.status === 'used').length;
    await bot.sendMessage(ADMIN_ID, [
        '📦 <b>Пул ссылок</b>',
        '',
        `🟢 Свободно: ${free}`,
        `🟡 В аренде: ${used}`,
        `📊 Всего: ${links.length}`
    ].join('\n'), { parse_mode: 'HTML' });
});

bot.onText(/\/users/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const db = await readDB();
    const users = db.users.filter(u => Number(u.monthsPaid || 0) > 0);
    if (!users.length) return bot.sendMessage(ADMIN_ID, '👥 Клиентов с подтверждёнными оплатами пока нет.');

    let text = '👥 <b>Клиенты VOIDLINK X</b>\n\n';
    users.forEach((u, i) => {
        const profile = {
            id: u.telegramId || u.id,
            username: u.username,
            firstName: u.firstName,
            lastName: u.lastName
        };
        const status = u.permanent ? 'постоянный доступ' : `активен до ${new Date(u.expiresAt).toLocaleDateString('ru-RU')}`;
        text += `${i + 1}. <a href="${profileUrl(profile)}">${escapeHtml(fullName(profile))}</a>\n`;
        text += `🆔 ID: <code>${profile.id}</code> | 💎 оплат: ${u.monthsPaid} мес.\n`;
        text += `🛡 Статус: ${status}\n\n`;
    });
    await bot.sendMessage(ADMIN_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.onText(/\/stats/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const db = await readDB();
    const total = db.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    await bot.sendMessage(ADMIN_ID, [
        '💰 <b>Финансы</b>',
        '',
        `💎 Всего заработано: ${total} ₽`,
        `🧾 Транзакций: ${db.payments.length}`
    ].join('\n'), { parse_mode: 'HTML' });
});

bot.onText(/\/addlink (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const newUrl = match[1];
    const links = await getLinks();
    links.push({ url: newUrl, status: 'free' });
    await require('./utils/links').saveLinks(links);
    await bot.sendMessage(ADMIN_ID, `✅ Ссылка добавлена в пул:\n${newUrl}`);
});

bot.on('polling_error', (error) => {
    const code = error?.response?.body?.error_code;
    const description = error?.response?.body?.description || error.message;

    if (code === 409) {
        if (!pollingConflictShown) {
            pollingConflictShown = true;
            console.error('Telegram polling conflict 409: уже запущен другой экземпляр этого бота. Остановите локальный запуск, старый Railway deploy или второй процесс.');
        }
        return;
    }

    console.error('Telegram polling error:', description);
});

async function configureBotProfile() {
    const description = [
        'Твой личный канал связи.',
        'VOIDLINK X — приватная браузерная WebRTC/P2P-система с персональными ссылками, ручной проверкой оплаты и временным защищённым шлюзом на 1 месяц.',
        'После 3 подтверждённых оплат открывается постоянная оригинальная ссылка.'
    ].join('\n');

    try {
        await bot.setMyShortDescription({ short_description: 'Твой личный канал связи: приватный WebRTC/P2P-доступ VOIDLINK X.' });
        await bot.setMyDescription({ description });
        await bot.setMyCommands([{ command: 'start', description: '🛰 Открыть VOIDLINK X' }]);
        await bot.setMyCommands([
            { command: 'start', description: '🛰 Открыть VOIDLINK X' },
            { command: 'admin', description: '🛠 Админ-панель' },
            { command: 'links', description: '📦 Пул ссылок' },
            { command: 'users', description: '👥 Клиенты' },
            { command: 'stats', description: '💰 Финансы' }
        ], { scope: { type: 'chat', chat_id: ADMIN_ID } });
    } catch (error) {
        console.error('Не удалось обновить описание бота:', error.message);
    }
}

async function startBot() {
    if (!process.env.BOT_TOKEN) {
        throw new Error('BOT_TOKEN не задан в .env');
    }

    if (!ADMIN_ID) {
        throw new Error('ADMIN_ID не задан или не является числом');
    }

    await bot.deleteWebHook({ drop_pending_updates: true });
    await bot.startPolling({ restart: true });
    await configureBotProfile();
    await runMaintenance();
}

// --- ЗАПУСК СЕРВЕРА (только для Railway, вебхук не используется) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`VOIDLINK X BOT запущен на порту ${PORT}`);
    console.log('Бот работает в режиме ручного подтверждения платежей');
});

app.get('/access/:token', async (req, res) => {
    try {
        const db = await readDB();
        const now = new Date();
        const user = db.users.find((item) => {
            if (!item.active || item.permanent || !item.personalLink || !item.expiresAt) return false;
            if (new Date(item.expiresAt) <= now) return false;
            return linkToken(item.personalLink, item.id) === req.params.token;
        });

        if (!user) {
            return res.status(403).send([
                '<!doctype html>',
                '<html lang="ru">',
                '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VOIDLINK X</title></head>',
                '<body style="margin:0;background:#05060b;color:#fff;font-family:Arial,sans-serif;display:grid;min-height:100vh;place-items:center;text-align:center;padding:24px">',
                '<main style="max-width:520px">',
                '<h1 style="letter-spacing:2px">VOIDLINK X</h1>',
                '<p style="color:#aab0c2;line-height:1.6">Временная ссылка недействительна или срок доступа истёк. Откройте бота и продлите доступ.</p>',
                '</main>',
                '</body></html>'
            ].join(''));
        }

        return res.redirect(302, user.personalLink);
    } catch (error) {
        console.error('Ошибка access-шлюза:', error.message);
        return res.status(500).send('VOIDLINK X access gateway error');
    }
});

app.get('/', (req, res) => {
    res.json({ ok: true, service: 'VOIDLINK X BOT' });
});

startBot().catch((error) => {
    console.error('Не удалось запустить бота:', error.message);
    process.exitCode = 1;
});
