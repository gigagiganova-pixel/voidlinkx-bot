require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');
const fs = require('fs');

const { getUser, saveUser, addPayment, readDB, writeDB } = require('./utils/db');
const { getLinks, saveLinks, reserveFreeLink } = require('./utils/links');

// --- НАСТРОЙКИ ---
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const ADMIN_ID = Number(process.env.ADMIN_ID);
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const photoStart = path.resolve(__dirname, 'assets/start.jpg');
const photoAbout = path.resolve(__dirname, 'assets/about.jpg');
const photoPayment = path.resolve(__dirname, 'assets/payment.jpg');
const photoSupport = path.resolve(__dirname, 'assets/support.jpg');
const photoReviews = path.resolve(__dirname, 'assets/reviews.jpg');

const price = process.env.PRICE || '500';
const botUsername = (process.env.BOT_USERNAME || 'voidlinkx_bot').replace(/^@/, '');
const supportUsername = (process.env.SUPPORT_USERNAME || 'vdx_support').replace(/^@/, '');
let pollingConflictShown = false;
const reviewDrafts = new Map();
const photoFileIdCache = new Map();

const MAIN_KEYBOARD = {
    inline_keyboard: [
        [{ text: '💎 Купить доступ', callback_data: 'buy' }],
        [
            { text: '🛡 О проекте', callback_data: 'about' },
            { text: '⭐ Отзывы', callback_data: 'reviews' }
        ],
        [{ text: '💬 Поддержка', callback_data: 'support' }]
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
        purchases: existing?.purchases || existing?.monthsPaid || 0,
        personalLink: existing?.personalLink || null,
        active: Boolean(existing?.active),
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
        '⚡ полноценный личный канал связи после одной оплаты',
        '🏆 оригинальная рабочая ссылка закрепляется за вами',
        '',
        `💎 <b>Стоимость:</b> ${escapeHtml(price)} ₽`
    ].join('\n');
}

function buildAboutText() {
    return [
        '🛡 <b>VOIDLINK X: личный канал связи</b>',
        '',
        'VOIDLINK X работает через WebRTC: соединение создаётся напрямую между участниками, а ссылка выдаётся персонально после ручной проверки оплаты.',
        '',
        '<b>Как устроен доступ:</b>',
        `💎 Оплата ${escapeHtml(price)} ₽ — личный канал связи из ограниченного пула.`,
        '🔗 После подтверждения вы получаете оригинальную рабочую ссылку.',
        '🛡 Ссылка удаляется из общего пула и закрепляется за вами.',
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
        '4. Администратор проверит платёж и выдаст оригинальную рабочую ссылку.',
        '',
        '⏱ Обычно проверка занимает 5-15 минут.'
    ].join('\n');
}

function buildSupportText() {
    return [
        '💬 <b>Поддержка VOIDLINK X</b>',
        '',
        'Если есть вопрос по оплате, доступу или ссылке, напишите в поддержку. Мы поможем спокойно и по делу.',
        '',
        `🔗 <b>Контакт:</b> @${escapeHtml(supportUsername)}`,
        '',
        'Для быстрой проверки платежа можно сразу отправить скрин/чек и ваш Telegram ID из бота.'
    ].join('\n');
}

function buildReviewsText() {
    return [
        '⭐ <b>Отзывы VOIDLINK X</b>',
        '',
        'Здесь отображаются отзывы, которые прошли ручную модерацию.',
        '',
        'Клиенты с активным доступом могут оставить отзыв после 3 дней использования: выбрать оценку от 1 до 5 и написать короткий комментарий.',
        '',
        'Все новые отзывы сначала приходят администратору на проверку.'
    ].join('\n');
}

function stars(rating) {
    return '⭐'.repeat(Number(rating));
}

function formatApprovedReview(review, index) {
    const name = review.displayName || 'Клиент VOIDLINK X';
    const date = review.approvedAt || review.createdAt;
    return [
        `${index + 1}. ${stars(review.rating)} <b>${escapeHtml(name)}</b>`,
        `<i>${new Date(date).toLocaleDateString('ru-RU')}</i>`,
        escapeHtml(review.text)
    ].join('\n');
}

function buildPublicReviewsText(reviews = []) {
    const approved = reviews
        .filter((review) => review.status === 'approved')
        .sort((a, b) => new Date(b.approvedAt || b.createdAt) - new Date(a.approvedAt || a.createdAt))
        .slice(0, 10);

    if (!approved.length) {
        return [
            buildReviewsText(),
            '',
            'Пока опубликованных отзывов нет. Первый честный отзыв появится здесь после модерации.'
        ].join('\n');
    }

    return [
        '⭐ <b>Отзывы VOIDLINK X</b>',
        '',
        ...approved.map(formatApprovedReview).flatMap((text) => [text, '']),
        '💎 Хотите проверить лично? Оформите доступ и получите персональную защищённую ссылку.'
    ].join('\n').trim();
}

function reviewEligibility(user) {
    if (!user || !user.active || !user.firstPaidAt) {
        return { ok: false, reason: 'Оставить отзыв могут клиенты с активным доступом VOIDLINK X.' };
    }

    const usedMs = Date.now() - new Date(user.firstPaidAt).getTime();
    const minMs = 3 * 24 * 60 * 60 * 1000;

    if (usedMs < minMs) {
        const availableAt = new Date(new Date(user.firstPaidAt).getTime() + minMs);
        return {
            ok: false,
            reason: `Отзыв можно оставить после 3 дней использования. Доступно с ${availableAt.toLocaleDateString('ru-RU')}.`
        };
    }

    return { ok: true };
}

function buildReviewStartText(user) {
    const eligibility = reviewEligibility(user);

    if (!eligibility.ok) {
        return [
            '⭐ <b>Отзывы VOIDLINK X</b>',
            '',
            eligibility.reason,
            '',
            'Если есть вопрос по доступу или оплате, напишите в поддержку.'
        ].join('\n');
    }

    return [
        '⭐ <b>Оставить отзыв</b>',
        '',
        'Спасибо, что пользуетесь VOIDLINK X.',
        '',
        'Выберите оценку от 1 до 5. После этого бот попросит написать комментарий, а отзыв уйдёт администратору на модерацию.'
    ].join('\n');
}

function buildReviewModerationText(review) {
    return [
        '⭐ <b>Новый отзыв на модерацию</b>',
        '',
        `Оценка: ${stars(review.rating)} (${review.rating}/5)`,
        `Пользователь: <a href="${profileUrl(review.profile)}">${escapeHtml(review.displayName)}</a>`,
        `Telegram ID: <code>${review.userId}</code>`,
        '',
        `<b>Комментарий:</b>\n${escapeHtml(review.text)}`
    ].join('\n');
}

function buildClientAccessText({ linkToSend, months, isPermanent }) {
    return [
        '🏆 <b>Доступ подтверждён</b>',
        '',
        'Ваш личный канал связи VOIDLINK X активирован.',
        '',
        `🔗 <b>Ваша оригинальная ссылка:</b>\n${escapeHtml(linkToSend)}`,
        '',
        '🔒 Сохраните её в надёжном месте. Эта ссылка закреплена за вами и удалена из общего пула.'
    ].join('\n');
}

async function sendPhotoMessage(chatId, photoPath, text, replyMarkup) {
    const options = {
        parse_mode: 'HTML',
        reply_markup: replyMarkup
    };

    if (fs.existsSync(photoPath)) {
        const cachedFileId = photoFileIdCache.get(photoPath);

        if (cachedFileId) {
            try {
                await bot.sendPhoto(chatId, cachedFileId, { ...options, caption: text });
                return;
            } catch (error) {
                photoFileIdCache.delete(photoPath);
                console.error(`Не удалось отправить кеш ${path.basename(photoPath)}:`, error.message);
            }
        }

        try {
            const sent = await bot.sendPhoto(chatId, photoPath, { ...options, caption: text });
            const bestPhoto = sent.photo?.[sent.photo.length - 1];
            if (bestPhoto?.file_id) {
                photoFileIdCache.set(photoPath, bestPhoto.file_id);
            }
            return;
        } catch (error) {
            console.error(`Не удалось отправить ${path.basename(photoPath)}:`, error.message);
        }
    }

    await bot.sendMessage(chatId, text, options);
}

async function sendPaymentMessage(chatId, text, replyMarkup) {
    await sendPhotoMessage(chatId, photoPayment, text, replyMarkup);
}

async function addReview(review) {
    const db = await readDB();
    db.reviews.push(review);
    await writeDB(db);
}

async function updateReviewStatus(reviewId, status) {
    const db = await readDB();
    const review = db.reviews.find((item) => item.id === reviewId);

    if (!review) {
        return null;
    }

    review.status = status;
    review.reviewedAt = new Date().toISOString();

    if (status === 'approved') {
        review.approvedAt = review.reviewedAt;
    }

    await writeDB(db);
    return review;
}

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
                    [{ text: '✅ Я оплатил', callback_data: 'check_payment' }],
                    [{ text: '💬 Поддержка', url: `https://t.me/${supportUsername}` }]
                ]
            });
            return;
        }

        // КНОПКА: О ПРОЕКТЕ
        if (query.data === 'about') {
            try {
                await bot.sendPhoto(chatId, photoAbout, { caption: buildAboutText(), parse_mode: 'HTML' });
            } catch (e) {
                await bot.sendMessage(chatId, buildAboutText(), { parse_mode: 'HTML' });
            }
            return;
        }

        // КНОПКА: ОТЗЫВЫ
        if (query.data === 'reviews') {
            const db = await readDB();
            await sendPhotoMessage(chatId, photoReviews, buildPublicReviewsText(db.reviews), {
                inline_keyboard: [
                    [{ text: '⭐ Оставить отзыв', callback_data: 'leave_review' }],
                    [{ text: '💎 Купить доступ', callback_data: 'buy' }],
                    [{ text: '💬 Поддержка', url: `https://t.me/${supportUsername}` }]
                ]
            });
            return;
        }

        // КНОПКА: ОСТАВИТЬ ОТЗЫВ
        if (query.data === 'leave_review') {
            const user = await getUser(profile.id);
            const eligibility = reviewEligibility(user);
            const keyboard = eligibility.ok
                ? {
                    inline_keyboard: [[1, 2, 3, 4, 5].map((rating) => ({
                        text: `${rating}⭐`,
                        callback_data: `review_rate_${rating}`
                    }))]
                }
                : {
                    inline_keyboard: [
                        [{ text: '💬 Поддержка', url: `https://t.me/${supportUsername}` }]
                    ]
                };

            await bot.sendMessage(chatId, buildReviewStartText(user), { parse_mode: 'HTML', reply_markup: keyboard });
            return;
        }

        // КНОПКА: ОЦЕНКА ОТЗЫВА
        if (query.data.startsWith('review_rate_')) {
            const user = await getUser(profile.id);
            const eligibility = reviewEligibility(user);

            if (!eligibility.ok) {
                await bot.sendMessage(chatId, buildReviewStartText(user), { parse_mode: 'HTML' });
                return;
            }

            const rating = Number(query.data.split('_')[2]);
            reviewDrafts.set(profile.id, { rating, createdAt: new Date().toISOString() });

            await bot.sendMessage(
                chatId,
                [
                    `${stars(rating)} <b>Оценка принята</b>`,
                    '',
                    'Теперь напишите комментарий одним сообщением. Лучше коротко: что понравилось, как прошёл запуск, качество связи и общее впечатление.'
                ].join('\n'),
                { parse_mode: 'HTML' }
            );
            return;
        }

        // АДМИН: ПОДТВЕРДИТЬ ОТЗЫВ
        if (query.data.startsWith('review_approve_')) {
            if (query.from.id !== ADMIN_ID) return;
            const reviewId = query.data.replace('review_approve_', '');
            const review = await updateReviewStatus(reviewId, 'approved');

            if (!review) {
                await bot.sendMessage(ADMIN_ID, '⚠️ Отзыв не найден.');
                return;
            }

            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_ID, message_id: query.message.message_id });
            await bot.sendMessage(ADMIN_ID, `✅ Отзыв опубликован: ${stars(review.rating)} от ${review.displayName}`);
            await bot.sendMessage(review.userId, '✅ Спасибо! Ваш отзыв прошёл модерацию и опубликован в блоке отзывов.');
            return;
        }

        // АДМИН: ОТКЛОНИТЬ ОТЗЫВ
        if (query.data.startsWith('review_reject_')) {
            if (query.from.id !== ADMIN_ID) return;
            const reviewId = query.data.replace('review_reject_', '');
            const review = await updateReviewStatus(reviewId, 'rejected');

            if (!review) {
                await bot.sendMessage(ADMIN_ID, '⚠️ Отзыв не найден.');
                return;
            }

            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_ID, message_id: query.message.message_id });
            await bot.sendMessage(ADMIN_ID, `❌ Отзыв отклонён: ${stars(review.rating)} от ${review.displayName}`);
            return;
        }

        // КНОПКА: ПОДДЕРЖКА
        if (query.data === 'support') {
            await sendPhotoMessage(chatId, photoSupport, buildSupportText(), {
                inline_keyboard: [
                    [{ text: '💬 Написать в поддержку', url: `https://t.me/${supportUsername}` }],
                    [{ text: '💎 Купить доступ', callback_data: 'buy' }]
                ]
            });
            return;
        }

        // ПОЛЬЗОВАТЕЛЬ НАЖАЛ "Я ОПЛАТИЛ"
        if (query.data === 'check_payment') {
            await upsertUserProfile(profile);

            // Отправляем админу запрос на подтверждение
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '✅ Подтвердить', callback_data: `confirm_${profile.id}` },
                        { text: '❌ Отклонить', callback_data: `reject_${profile.id}` }
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
            
            await bot.sendMessage(profile.id, '✅ Заявка отправлена администратору. Доступ будет выдан после ручной проверки платежа, обычно в течение 5-15 минут.');
            return;
        }

        // АДМИН ПОДТВЕРДИЛ
        if (query.data.startsWith('confirm_')) {
            if (query.from.id !== ADMIN_ID) return;
            const userId = parseInt(query.data.split('_')[1]);
            
            let user = await getUser(userId);
            let link;

            if (user?.personalLink) {
                link = user.personalLink;
                await bot.sendMessage(userId, buildClientAccessText({ linkToSend: link }), { parse_mode: 'HTML', disable_web_page_preview: true });
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_ID, message_id: query.message.message_id });
                await bot.sendMessage(ADMIN_ID, `ℹ️ У пользователя ${userId} уже есть закреплённая ссылка. Повторно отправил её без списания новой ссылки из пула.`);
                return;
            }

            link = await reserveFreeLink();
            if (!link) {
                await bot.sendMessage(ADMIN_ID, `⚠️ Нет свободных ссылок для пользователя ${userId}. Добавьте ссылки через /addlink <url>.`);
                return;
            }

            user = {
                id: userId,
                telegramId: userId,
                username: user?.username || '',
                firstName: user?.firstName || '',
                lastName: user?.lastName || '',
                languageCode: user?.languageCode || '',
                purchases: 1,
                personalLink: link,
                active: true,
                createdAt: user?.createdAt || new Date().toISOString(),
                firstPaidAt: user?.firstPaidAt || new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            await saveUser(user);
            await addPayment({ user: userId, amount: price, date: new Date().toISOString() });

            const linkToSend = link;

            await bot.sendMessage(userId, buildClientAccessText({ linkToSend }), { parse_mode: 'HTML', disable_web_page_preview: true });
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_ID, message_id: query.message.message_id });
            await bot.sendMessage(ADMIN_ID, `✅ Оригинальная ссылка выдана пользователю ${userId}. Ссылка удалена из пула.`);
            return;
        }

        // АДМИН ОТКЛОНИЛ
        if (query.data.startsWith('reject_')) {
            if (query.from.id !== ADMIN_ID) return;
            const userId = parseInt(query.data.split('_')[1]);
            await bot.sendMessage(userId, '❌ Платёж не подтверждён. Пожалуйста, проверьте сумму, кошелёк и попробуйте отправить заявку ещё раз.');
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_ID, message_id: query.message.message_id });
            await bot.sendMessage(ADMIN_ID, `❌ Заявка пользователя ${userId} отклонена.`);
            return;
        }

    } catch (error) {
        console.error('Ошибка в callback_query:', error.message);
    }
});

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const profile = profileFromTelegram(msg.from);
    const draft = reviewDrafts.get(profile.id);
    if (!draft) return;

    const text = msg.text.trim();

    if (text.length < 10) {
        await bot.sendMessage(msg.chat.id, '⭐ Напишите чуть подробнее: минимум 10 символов. Например, что понравилось в связи, запуске или приватности.');
        return;
    }

    if (text.length > 900) {
        await bot.sendMessage(msg.chat.id, '⭐ Отзыв получился слишком длинным. Пожалуйста, уложитесь до 900 символов.');
        return;
    }

    const user = await getUser(profile.id);
    const eligibility = reviewEligibility(user);
    if (!eligibility.ok) {
        reviewDrafts.delete(profile.id);
        await bot.sendMessage(msg.chat.id, buildReviewStartText(user), { parse_mode: 'HTML' });
        return;
    }

    const review = {
        id: `${Date.now()}_${profile.id}`,
        userId: profile.id,
        profile,
        displayName: fullName(profile),
        rating: draft.rating,
        text,
        status: 'pending',
        createdAt: new Date().toISOString()
    };

    await addReview(review);
    reviewDrafts.delete(profile.id);

    await bot.sendMessage(
        msg.chat.id,
        [
            '✅ <b>Отзыв отправлен на модерацию</b>',
            '',
            'Спасибо за обратную связь. После проверки администратор сможет опубликовать его в блоке отзывов.'
        ].join('\n'),
        { parse_mode: 'HTML' }
    );

    await bot.sendMessage(
        ADMIN_ID,
        buildReviewModerationText(review),
        {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Опубликовать', callback_data: `review_approve_${review.id}` },
                        { text: '❌ Отклонить', callback_data: `review_reject_${review.id}` }
                    ],
                    [{ text: '💬 Написать пользователю', url: profileUrl(profile) }]
                ]
            }
        }
    );
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
        '💬 /support — контакт поддержки',
        '⭐ /reviews — блок отзывов',
        '➕ /addlink &lt;url&gt; — добавить ссылку'
    ].join('\n'), { parse_mode: 'HTML' });
});

bot.onText(/\/support/, async (msg) => {
    await sendPhotoMessage(msg.chat.id, photoSupport, buildSupportText(), {
        inline_keyboard: [
            [{ text: '💬 Написать в поддержку', url: `https://t.me/${supportUsername}` }]
        ]
    });
});

bot.onText(/\/reviews/, async (msg) => {
    const db = await readDB();
    await sendPhotoMessage(msg.chat.id, photoReviews, buildPublicReviewsText(db.reviews), {
        inline_keyboard: [
            [{ text: '⭐ Оставить отзыв', callback_data: 'leave_review' }],
            [{ text: '💎 Купить доступ', callback_data: 'buy' }],
            [{ text: '💬 Поддержка', url: `https://t.me/${supportUsername}` }]
        ]
    });
});

bot.onText(/\/links/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const links = await getLinks();
    const free = links.filter(l => l.status === 'free').length;
    const details = links.slice(0, 20).map((link, index) => {
        return `${index + 1}. 🟢 free\n   ${escapeHtml(link.url)}`;
    });

    await bot.sendMessage(ADMIN_ID, [
        '📦 <b>Пул ссылок</b>',
        '',
        `🟢 Свободно: ${free}`,
        `📊 Всего: ${links.length}`,
        '',
        ...details
    ].join('\n'), { parse_mode: 'HTML' });
});

bot.onText(/\/users/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const db = await readDB();
    const users = db.users.filter(u => Number(u.purchases || u.monthsPaid || 0) > 0);
    if (!users.length) return bot.sendMessage(ADMIN_ID, '👥 Клиентов с подтверждёнными оплатами пока нет.');

    let text = '👥 <b>Клиенты VOIDLINK X</b>\n\n';
    users.forEach((u, i) => {
        const telegramId = u.telegramId || u.id;
        const username = u.username ? `@${u.username}` : 'не указан';
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'не указано';
        const status = 'ссылка выдана';
        text += `${i + 1}. 👤 Клиент\n`;
        text += `🆔 Telegram ID: <code>${telegramId}</code>\n`;
        text += `🔗 Username: ${escapeHtml(username)}\n`;
        text += `📝 Имя: ${escapeHtml(name)}\n`;
        text += `💎 Покупок: ${u.purchases || u.monthsPaid || 1}\n`;
        text += `🔗 Ссылка: ${escapeHtml(u.personalLink || 'нет')}\n`;
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
    await saveLinks(links);
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
        'VOIDLINK X — приватная браузерная WebRTC/P2P-система с персональными ссылками и ручной проверкой оплаты.',
        'После подтверждения вы получаете оригинальную рабочую ссылку из ограниченного пула.'
    ].join('\n');

    try {
        await bot.setMyShortDescription({ short_description: 'Твой личный канал связи: приватный WebRTC/P2P-доступ VOIDLINK X.' });
        await bot.setMyDescription({ description });
        await bot.setMyCommands([
            { command: 'start', description: '🛰 Открыть VOIDLINK X' },
            { command: 'support', description: '💬 Поддержка' },
            { command: 'reviews', description: '⭐ Отзывы' }
        ]);
        await bot.setMyCommands([
            { command: 'start', description: '🛰 Открыть VOIDLINK X' },
            { command: 'support', description: '💬 Поддержка' },
            { command: 'reviews', description: '⭐ Отзывы' },
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
}

// --- ЗАПУСК СЕРВЕРА (только для Railway, вебхук не используется) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`VOIDLINK X BOT запущен на порту ${PORT}`);
    console.log('Бот работает в режиме ручного подтверждения платежей');
});

app.get('/', (req, res) => {
    res.json({ ok: true, service: 'VOIDLINK X BOT' });
});

startBot().catch((error) => {
    console.error('Не удалось запустить бота:', error.message);
    process.exitCode = 1;
});
