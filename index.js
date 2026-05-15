require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { getUser, saveUser, addPayment, readDB, expireSubscriptions } = require('./utils/db');
const { getLinks, reserveFreeLink, releaseLink, removeLinkFromPool } = require('./utils/links');
const { encryptLink } = require('./utils/crypto');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_ID = Number(process.env.ADMIN_ID);
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const photoStart = path.resolve(__dirname, 'assets/start.jpg');
const photoAbout = path.resolve(__dirname, 'assets/about.jpg');

setInterval(expireSubscriptions, 6 * 60 * 60 * 1000);

// --- СТАРТ ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const text = `🚀 *ДОБРО ПОЖАЛОВАТЬ В VOIDLINK X*\n\nПремиальная WebRTC система связи.\n\n💎 Стоимость: ${process.env.PRICE} RUB / месяц.\n\n🏆 Оплати 3 месяца → вечный доступ навсегда!`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '💎 КУПИТЬ ДОСТУП', callback_data: 'buy' }],
            [{ text: '📡 О ПРОЕКТЕ', callback_data: 'about' }]
        ]
    };

    try {
        await bot.sendPhoto(chatId, photoStart, { caption: text, parse_mode: 'Markdown', reply_markup: keyboard });
    } catch (e) {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
});

// --- КНОПКИ ---
bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    try {
        await bot.answerCallbackQuery(query.id);

        if (query.data === 'buy') {
            // ПРАВИЛЬНАЯ ССЫЛКА ДЛЯ АВТО-ОПЛАТЫ
            const payUrl = `https://yoomoney.ru/quickpay/confirm.xml?receiver=${process.env.YOOMONEY_WALLET}&quickpay-form=small&targets=VOIDLINK%20X&sum=${process.env.PRICE}&label=${chatId}&successURL=https://t.me/voidlinkx_bot`;
            
            const text = `💳 *ОПЛАТА ПОДПИСКИ*\n\nСумма: *${process.env.PRICE} RUB*\n\n💰 После оплаты ДОСТУП ВЫДАЕТСЯ АВТОМАТИЧЕСКИ в течение 1 минуты.\n\n👇 Нажми на кнопку и оплати картой или с баланса ЮMoney:`;
            
            await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔗 ОПЛАТИТЬ', url: payUrl }]]
                }
            });
        }

        if (query.data === 'about') {
            const text = `📡 *VOIDLINK X SPECIFICATION*\n\n• Полная изоляция трафика\n• Отсутствие логов\n• Вечный доступ после 3 оплат\n• 500 ₽/месяц`;
            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        }

    } catch (error) {
        console.error('Ошибка:', error.message);
    }
});

// 🔥 АВТОМАТИЧЕСКОЕ ПОДТВЕРЖДЕНИЕ ПЛАТЕЖА (ВЕБХУК ЮMONEY)
app.post('/yoomoney-webhook', async (req, res) => {
    console.log('📥 Получен вебхук:', req.body);
    
    try {
        // Проверяем подпись (безопасность)
        const notificationSecret = req.body.notification_secret;
        if (notificationSecret !== process.env.YOOMONEY_SECRET) {
            console.log('❌ Неверный секрет');
            return res.status(400).send('Invalid secret');
        }

        const { label, amount, withraw_amount, operation_id } = req.body;
        
        // label = это наш chatId пользователя
        const userId = Number(label);
        if (!userId) return res.status(200).send('OK');
        
        // Проверяем, что сумма правильная
        const paymentAmount = parseFloat(amount || withraw_amount);
        if (paymentAmount < parseFloat(process.env.PRICE)) {
            console.log(`❌ Сумма ${paymentAmount} меньше ${process.env.PRICE}`);
            return res.status(200).send('OK');
        }

        // --- ВЫДАЕМ ДОСТУП АВТОМАТИЧЕСКИ ---
        let user = await getUser(userId);
        let link;
        let months = user ? user.monthsPaid + 1 : 1;
        const isPermanent = months >= 3;

        if (!user || !user.personalLink) {
            link = await reserveFreeLink();
            if (!link) {
                await bot.sendMessage(ADMIN_ID, `❌ КРИТИЧНО: У пользователя ${userId} нет свободных ссылок в пуле!`);
                return res.status(200).send('OK');
            }
        } else {
            link = user.personalLink;
        }

        if (isPermanent) {
            await removeLinkFromPool(link);
        }

        const expires = new Date();
        expires.setMonth(expires.getMonth() + 1);

        user = {
            id: userId,
            username: user?.username || 'customer',
            monthsPaid: months,
            personalLink: link,
            permanent: isPermanent,
            expiresAt: expires.toISOString(),
            active: true
        };

        await saveUser(user);
        await addPayment({ user: userId, amount: paymentAmount, operation_id, date: new Date().toISOString() });

        const linkToSend = isPermanent ? link : encryptLink(link, userId);

        let clientText = `✅ *ОПЛАТА ПОЛУЧЕНА! ДОСТУП АКТИВИРОВАН!*\n\n`;
        if (isPermanent) {
            clientText += `🏆 ПОЗДРАВЛЯЮ! Вы оплатили 3 месяца и получили *ВЕЧНЫЙ ДОСТУП*!\n\n🌐 Ваша ссылка: ${linkToSend}\n\n🔒 Сохраните её в надежном месте.`;
        } else {
            clientText += `⏳ Доступ на 1 месяц активирован.\n\n🌐 Ваш шлюз: ${linkToSend}\n\n💎 Оплачено месяцев: *${months}/3*. Осталось: *${3 - months} мес.* до вечного доступа.`;
        }

        await bot.sendMessage(userId, clientText, { parse_mode: 'Markdown' });
        await bot.sendMessage(ADMIN_ID, `💰 *АВТО-ОПЛАТА*: Пользователь ${userId} оплатил ${paymentAmount} руб. Выдан ${months}-й месяц доступа.`);

        res.status(200).send('OK');
    } catch (err) {
        console.error('🔥 Ошибка вебхука:', err.message);
        res.status(200).send('OK');
    }
});

// --- АДМИН-КОМАНДЫ ---
bot.onText(/\/admin/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    await bot.sendMessage(ADMIN_ID, `🛠 *VOIDLINK X ADMIN*\n\n/links — статус ссылок\n/users — список клиентов\n/stats — финансы\n/addlink <url> — добавить ссылку`);
});

bot.onText(/\/links/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const links = await getLinks();
    const free = links.filter(l => l.status === 'free').length;
    const used = links.filter(l => l.status === 'used').length;
    await bot.sendMessage(ADMIN_ID, `📊 *ПУЛ ССЫЛОК:*\n\n🟢 Свободно: ${free}\n🟡 В аренде: ${used}\n📦 Всего: ${links.length}`);
});

bot.onText(/\/users/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const db = await readDB();
    if (!db.users.length) return bot.sendMessage(ADMIN_ID, '👥 Клиентов пока нет.');
    let text = `👥 *КЛИЕНТЫ:*\n\n`;
    db.users.forEach((u, i) => {
        text += `${i+1}. ID: \`${u.id}\` | Оплат: ${u.monthsPaid} мес.\nСтатус: ${u.permanent ? '🏆 Вечный' : `до ${new Date(u.expiresAt).toLocaleDateString()}`}\n`;
    });
    await bot.sendMessage(ADMIN_ID, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const db = await readDB();
    const total = db.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    await bot.sendMessage(ADMIN_ID, `💰 *ФИНАНСЫ:*\n\nВсего заработано: ${total} RUB\nТранзакций: ${db.payments.length}`);
});

bot.onText(/\/addlink (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const newUrl = match[1];
    const links = await getLinks();
    links.push({ url: newUrl, status: 'free' });
    await require('./utils/links').saveLinks(links);
    await bot.sendMessage(ADMIN_ID, `✅ Ссылка ${newUrl} добавлена в пул!`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Бот запущен на порту ${PORT}`));