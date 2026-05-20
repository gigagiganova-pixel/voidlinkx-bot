const dotenvResult = require('dotenv').config();
const fileEnv = dotenvResult.parsed || {};
['BOT_TOKEN', 'ADMIN_ID', 'ADMIN_IDS', 'PRICE', 'PAYMENT_NET_AMOUNT', 'REGULAR_PRICE', 'DISCOUNT_UNTIL_TEXT', 'PUBLIC_URL', 'CRYPTO_SECRET', 'YOOMONEY_WALLET', 'BOT_USERNAME', 'SUPPORT_USERNAME'].forEach((key) => {
    if (!process.env[key] && fileEnv[key]) {
        process.env[key] = fileEnv[key];
    }
});
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');
const fs = require('fs');

const { getUser, saveUser, addPayment, readDB, writeDB } = require('./utils/db');
const { getLinks, saveLinks, reserveFreeLink } = require('./utils/links');

// --- НАСТРОЙКИ ---
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const defaultAdminIds = [964138741, 1895742817, 7951751281];
const adminIds = Array.from(new Set([
    ...(process.env.ADMIN_IDS || process.env.ADMIN_ID || '')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter(Boolean),
    ...defaultAdminIds
]));
const ADMIN_ID = adminIds[0];
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const photoStart = path.resolve(__dirname, 'assets/start.jpg');
const photoAbout = path.resolve(__dirname, 'assets/about.jpg');
const photoPayment = path.resolve(__dirname, 'assets/payment.jpg');
const photoSupport = path.resolve(__dirname, 'assets/support.jpg');
const photoReviews = path.resolve(__dirname, 'assets/reviews.jpg');
const photoReferral = path.resolve(__dirname, 'assets/referral.jpg');

const price = process.env.PRICE || '500';
const paymentGrossAmount = Number(price);
const paymentNetAmount = Number(process.env.PAYMENT_NET_AMOUNT || (paymentGrossAmount * 0.97).toFixed(2));
const paymentFeeAmount = Number((paymentGrossAmount - paymentNetAmount).toFixed(2));
const regularPrice = process.env.REGULAR_PRICE || '500';
const discountUntilText = process.env.DISCOUNT_UNTIL_TEXT || 'примерно через неделю';
const referralPercent = 10;
const referralCommission = Math.round(Number(price) * referralPercent / 100);
const botUsername = (process.env.BOT_USERNAME || 'voidlinkx_bot').replace(/^@/, '');
const supportUsername = (process.env.SUPPORT_USERNAME || 'vdx_support').replace(/^@/, '');
let pollingConflictShown = false;
const reviewDrafts = new Map();
const referralDrafts = new Map();
const broadcastDrafts = new Set();
const photoFileIdCache = new Map();

const MAIN_KEYBOARD = {
    inline_keyboard: [
        [{ text: '💎 Купить доступ', callback_data: 'buy' }],
        [
            { text: '🛡 О проекте', callback_data: 'about' },
            { text: '⭐ Отзывы', callback_data: 'reviews' }
        ],
        [{ text: '🤝 Реферальная программа', callback_data: 'referral' }],
        [{ text: '💬 Поддержка', callback_data: 'support' }]
    ]
};

function actionKeyboard(options = {}) {
    const {
        buy = true,
        support = true,
        reviews = false,
        leaveReview = false,
        referral = false,
        supportText = '💬 Поддержка'
    } = options;

    const rows = [];

    if (leaveReview) {
        rows.push([{ text: '⭐ Оставить отзыв', callback_data: 'leave_review' }]);
    }

    if (reviews) {
        rows.push([{ text: '⭐ Отзывы', callback_data: 'reviews' }]);
    }

    if (buy) {
        rows.push([{ text: '💎 Купить доступ', callback_data: 'buy' }]);
    }

    if (referral) {
        rows.push([{ text: '🤝 Реферальная программа', callback_data: 'referral' }]);
    }

    if (support) {
        rows.push([{ text: supportText, url: `https://t.me/${supportUsername}` }]);
    }

    return { inline_keyboard: rows };
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function isAdmin(id) {
    return adminIds.includes(Number(id));
}

async function sendToAdmins(text, options = {}) {
    const results = await Promise.allSettled(
        adminIds.map((adminId) => bot.sendMessage(adminId, text, options))
    );

    return results;
}

function activityStats(users = []) {
    return {
        total: users.length
    };
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

function buildPaymentUrl(profileId) {
    const wallet = process.env.YOOMONEY_WALLET;
    if (!wallet) return null;

    const params = new URLSearchParams({
        receiver: wallet,
        'quickpay-form': 'small',
        targets: 'VOIDLINK X',
        sum: String(price),
        label: String(profileId),
        successURL: `https://t.me/${botUsername}`
    });

    return `https://yoomoney.ru/quickpay/confirm.xml?${params.toString()}`;
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

function buildPriceLine() {
    if (String(price) === String(regularPrice)) {
        return `💎 <b>Стоимость:</b> ${escapeHtml(price)} ₽`;
    }

    const discount = Math.max(0, Number(regularPrice) - Number(price));
    return [
        `💎 <b>Стоимость сейчас:</b> ${escapeHtml(price)} ₽`,
        `🔥 Временная скидка: -${discount || 50} ₽. ${escapeHtml(discountUntilText)} цена вернётся к ${escapeHtml(regularPrice)} ₽.`
    ].join('\n');
}

function formatMoney(value) {
    return Number(value || 0).toFixed(2).replace(/\.00$/, '');
}

function normalizeUserLinks(user = {}) {
    if (!user) {
        return [];
    }

    if (Array.isArray(user.links)) {
        return user.links;
    }

    if (user.personalLink) {
        return [{
            url: user.personalLink,
            issuedAt: user.firstPaidAt || user.createdAt || new Date().toISOString()
        }];
    }

    return [];
}

async function upsertUserProfile(profile, options = {}) {
    if (!profile.id) return null;

    const existing = await getUser(profile.id);
    const now = new Date().toISOString();
    const referredBy = options.referredBy && Number(options.referredBy) !== profile.id
        ? Number(options.referredBy)
        : existing?.referredBy || null;
    const user = {
        id: profile.id,
        telegramId: profile.id,
        username: profile.username || existing?.username || '',
        firstName: profile.firstName || existing?.firstName || '',
        lastName: profile.lastName || existing?.lastName || '',
        languageCode: profile.languageCode || existing?.languageCode || '',
        purchases: existing?.purchases || existing?.monthsPaid || normalizeUserLinks(existing).length,
        links: normalizeUserLinks(existing),
        personalLink: existing?.personalLink || null,
        referredBy,
        referral: existing?.referral || null,
        active: Boolean(existing?.active),
        createdAt: existing?.createdAt || now,
        lastSeenAt: now,
        lastAction: options.action || existing?.lastAction || 'activity',
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
        buildPriceLine()
    ].join('\n');
}

function buildAboutText() {
    return [
        '🛡 <b>VOIDLINK X: личный канал связи</b>',
        '',
        'VOIDLINK X работает через WebRTC: соединение создаётся напрямую между участниками, а ссылка выдаётся персонально после ручной проверки оплаты.',
        '',
        '<b>Как устроен доступ:</b>',
        `${buildPriceLine().replace(/<[^>]+>/g, '')} — личный канал связи из ограниченного пула.`,
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
        buildPriceLine(),
        '',
        '1. Нажмите кнопку оплаты.',
        '2. После перевода вернитесь в бот.',
        '3. Нажмите «Я оплатил».',
        '4. Администратор проверит платёж и выдаст оригинальную рабочую ссылку.',
        '',
        '⏱ Обычно проверка занимает 5-15 минут.'
    ].join('\n');
}

function buildSoldOutText() {
    return [
        '⌛ <b>Свободные каналы временно закончились</b>',
        '',
        'Сейчас все личные ссылки из пула разобраны.',
        '',
        '🔄 Пул обновляется два раза в день:',
        '• 11:00 по МСК',
        '• 23:00 по МСК',
        '',
        'Если вы уже оплатили или хотите закрепить место, напишите в поддержку.'
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

function referralLink(userId) {
    return `https://t.me/${botUsername}?start=ref_${userId}`;
}

function normalizeReferral(referral = {}) {
    if (!referral) {
        referral = {};
    }

    return {
        active: Boolean(referral.active),
        details: referral.details || '',
        balance: Number(referral.balance || 0),
        totalEarned: Number(referral.totalEarned || 0),
        totalPaidOut: Number(referral.totalPaidOut || 0),
        joinedAt: referral.joinedAt || null
    };
}

function buildReferralIntroText() {
    return [
        '🤝 <b>Реферальная программа VOIDLINK X</b>',
        '',
        `Приглашайте людей по личной ссылке и получайте <b>${referralPercent}%</b> с каждой подтверждённой покупки.`,
        '',
        buildPriceLine(),
        `💰 Начисление за одну покупку: ${referralCommission} ₽`,
        '',
        '<b>Как это работает:</b>',
        '1. Вы регистрируете реквизиты для выплат.',
        '2. Бот выдаёт вашу личную реферальную ссылку.',
        '3. Друг переходит по ней и покупает доступ.',
        '4. После подтверждения оплаты комиссия сразу попадает на ваш баланс.',
        '5. Вы запрашиваете вывод, а админ вручную переводит деньги и подтверждает выплату.',
        '',
        'Для подключения понадобится одним сообщением отправить ФИО, телефон и банк.'
    ].join('\n');
}

function buildReferralDetailsPrompt() {
    return [
        '📝 <b>Регистрация партнёра</b>',
        '',
        'Отправьте реквизиты одним сообщением в таком формате:',
        '',
        '<code>Иванов Иван',
        '+7 900 000-00-00',
        'Сбербанк</code>',
        '',
        'Эти данные увидит только админ при запросе выплаты.'
    ].join('\n');
}

function buildReferralCabinetText(user) {
    const referral = normalizeReferral(user?.referral);
    const invitedCount = Number(user?.referralInvitedCount || 0);

    return [
        '🤝 <b>Партнёрский кабинет VOIDLINK X</b>',
        '',
        `💰 <b>Баланс к выводу:</b> ${referral.balance} ₽`,
        `📈 <b>Всего начислено:</b> ${referral.totalEarned} ₽`,
        `✅ <b>Выплачено:</b> ${referral.totalPaidOut} ₽`,
        `👥 <b>Покупок по ссылке:</b> ${invitedCount}`,
        '',
        '<b>Ваша ссылка:</b>',
        referralLink(user.id),
        '',
        `Комиссия: ${referralPercent}% с подтверждённой покупки (${referralCommission} ₽ сейчас).`
    ].join('\n');
}

function buildWithdrawalAdminText(withdrawal, user) {
    const referral = normalizeReferral(user?.referral);
    return [
        '💸 <b>Новый запрос на вывод</b>',
        '',
        adminProfileText(user),
        '',
        `💰 <b>Сумма:</b> ${withdrawal.amount} ₽`,
        '',
        '<b>Реквизиты:</b>',
        escapeHtml(referral.details || 'не указаны')
    ].join('\n');
}

function buildPaymentRequestAdminText(request, profile) {
    const refLine = request.referredBy
        ? `🤝 <b>Реферал от:</b> <code>${request.referredBy}</code>`
        : '🤝 <b>Реферал:</b> нет';

    return [
        '💰 <b>Новая заявка на оплату</b>',
        '',
        adminProfileText(profile),
        '',
        `💎 <b>Сумма:</b> ${escapeHtml(price)} ₽`,
        `🏷 <b>Метка ЮMoney:</b> <code>${profile.id}</code>`,
        refLine,
        `🧾 <b>ID заявки:</b> <code>${request.id}</code>`,
        '',
        '🧾 Проверьте ЮMoney и подтвердите доступ.'
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
        '🔒 Сохраните её в надёжном месте. Эта ссылка удалена из общего пула и закреплена за вашей покупкой.'
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

async function sendStartMessage(chatId) {
    await sendPhotoMessage(chatId, photoStart, buildStartText(), MAIN_KEYBOARD);
}

async function hasFreeLinks() {
    const links = await getLinks();
    return links.some((link) => link.status === 'free');
}

async function notifyAdminError(context, error) {
    if (!ADMIN_ID) return;

    try {
        await sendToAdmins(
            [
                '⚠️ <b>Ошибка бота</b>',
                '',
                `<b>Где:</b> ${escapeHtml(context)}`,
                `<b>Причина:</b> ${escapeHtml(error?.message || error)}`
            ].join('\n'),
            { parse_mode: 'HTML' }
        );
    } catch (notifyError) {
        console.error('Не удалось отправить ошибку админу:', notifyError.message);
    }
}

async function addReview(review) {
    const db = await readDB();
    db.reviews.push(review);
    await writeDB(db);
}

async function updateReviewStatus(reviewId, status) {
    const db = await readDB();
    const review = db.reviews.find((item) => item.id === reviewId);

    if (!review || review.status !== 'pending') {
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

async function createPaymentRequest(profile) {
    const db = await readDB();
    const user = db.users.find((item) => item.id === Number(profile.id));
    const request = {
        id: `${Date.now()}_${profile.id}`,
        userId: Number(profile.id),
        profile,
        amount: Number(price),
        referredBy: user?.referredBy || null,
        status: 'pending',
        createdAt: new Date().toISOString()
    };

    db.paymentRequests.push(request);
    await writeDB(db);
    return request;
}

async function getPendingPaymentRequest(requestId) {
    const db = await readDB();
    return db.paymentRequests.find((item) => item.id === requestId && item.status === 'pending') || null;
}

async function updatePaymentRequest(requestId, status, adminId) {
    const db = await readDB();
    const request = db.paymentRequests.find((item) => item.id === requestId);

    if (!request || request.status !== 'pending') {
        return null;
    }

    request.status = status;
    request.adminId = Number(adminId);
    request.reviewedAt = new Date().toISOString();
    await writeDB(db);
    return request;
}

async function registerReferralPartner(userId, details) {
    const user = await getUser(userId);
    const now = new Date().toISOString();
    const referral = normalizeReferral(user?.referral);
    const baseUser = user || { id: Number(userId), telegramId: Number(userId), createdAt: now };

    const updatedUser = {
        ...baseUser,
        id: Number(userId),
        telegramId: Number(userId),
        referral: {
            ...referral,
            active: true,
            details,
            joinedAt: referral.joinedAt || now
        },
        updatedAt: now
    };

    await saveUser(updatedUser);
    return updatedUser;
}

async function creditReferral(buyer) {
    const referrerId = Number(buyer?.referredBy);
    if (!referrerId || referrerId === Number(buyer?.id)) {
        return null;
    }

    const referrer = await getUser(referrerId);
    if (!referrer?.referral?.active) {
        return null;
    }

    const db = await readDB();
    const referral = normalizeReferral(referrer.referral);
    const commission = referralCommission;

    referral.balance += commission;
    referral.totalEarned += commission;

    referrer.referral = referral;
    referrer.referralInvitedCount = Number(referrer.referralInvitedCount || 0) + 1;
    referrer.updatedAt = new Date().toISOString();

    const userIndex = db.users.findIndex((item) => item.id === Number(referrer.id));
    if (userIndex >= 0) {
        db.users[userIndex] = referrer;
    }

    db.referralEarnings.push({
        id: `${Date.now()}_${buyer.id}_${referrerId}`,
        referrerId,
        buyerId: Number(buyer.id),
        amount: commission,
        percent: referralPercent,
        purchaseAmount: Number(price),
        createdAt: new Date().toISOString()
    });

    await writeDB(db);
    return { referrer, amount: commission };
}

async function createWithdrawal(userId) {
    const db = await readDB();
    const user = db.users.find((item) => item.id === Number(userId));
    const referral = normalizeReferral(user?.referral);

    if (!user || !referral.active || referral.balance <= 0) {
        return null;
    }

    const amount = referral.balance;
    referral.balance = 0;
    user.referral = referral;
    user.updatedAt = new Date().toISOString();

    const withdrawal = {
        id: `${Date.now()}_${userId}`,
        userId: Number(userId),
        amount,
        status: 'pending',
        createdAt: new Date().toISOString()
    };

    db.withdrawals.push(withdrawal);
    const userIndex = db.users.findIndex((item) => item.id === Number(userId));
    db.users[userIndex] = user;
    await writeDB(db);

    return { withdrawal, user };
}

async function updateWithdrawal(withdrawalId, status, adminId) {
    const db = await readDB();
    const withdrawal = db.withdrawals.find((item) => item.id === withdrawalId);

    if (!withdrawal || withdrawal.status !== 'pending') {
        return null;
    }

    const user = db.users.find((item) => item.id === Number(withdrawal.userId));
    const referral = normalizeReferral(user?.referral);

    withdrawal.status = status;
    withdrawal.adminId = Number(adminId);
    withdrawal.reviewedAt = new Date().toISOString();

    if (status === 'paid') {
        referral.totalPaidOut += Number(withdrawal.amount);
    }

    if (status === 'rejected') {
        referral.balance += Number(withdrawal.amount);
    }

    if (user) {
        user.referral = referral;
        user.updatedAt = withdrawal.reviewedAt;
    }

    await writeDB(db);
    return { withdrawal, user };
}

async function broadcastToUsers(text) {
    const db = await readDB();
    const recipients = db.users
        .map((user) => Number(user.id))
        .filter((id) => id && !isAdmin(id));

    const uniqueRecipients = [...new Set(recipients)];
    const results = await Promise.allSettled(
        uniqueRecipients.map((id) => bot.sendMessage(id, text, { parse_mode: 'HTML', disable_web_page_preview: true }))
    );

    return {
        total: uniqueRecipients.length,
        sent: results.filter((item) => item.status === 'fulfilled').length,
        failed: results.filter((item) => item.status === 'rejected').length
    };
}

// --- КОМАНДА /start ---
bot.onText(/^\/start(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        const startArg = msg.text?.split(/\s+/)[1] || '';
        const refMatch = startArg.match(/^ref_(\d+)$/);
        const referredBy = refMatch ? Number(refMatch[1]) : null;
        await upsertUserProfile(profileFromTelegram(msg.from), { referredBy, action: 'start' });
        await sendStartMessage(chatId);
    } catch (error) {
        console.error('Ошибка в /start:', error.message);
        await notifyAdminError(`/start от ${msg.from?.id || chatId}`, error);
    }
});

// --- ОБРАБОТКА КНОПОК ---
bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    try {
        await bot.answerCallbackQuery(query.id).catch((error) => {
            console.error('Не удалось ответить на callback:', error.message);
        });
        const profile = profileFromTelegram(query.from);
        await upsertUserProfile(profile, { action: `button:${query.data}` });

        if (query.data === 'admin_broadcast') {
            if (!isAdmin(query.from.id)) return;
            broadcastDrafts.add(query.from.id);
            await bot.sendMessage(
                chatId,
                [
                    '📣 <b>Рассылка</b>',
                    '',
                    'Отправьте следующим сообщением текст, который нужно разослать всем пользователям бота.',
                    '',
                    'HTML-разметка поддерживается. Для отмены отправьте /cancel.'
                ].join('\n'),
                { parse_mode: 'HTML' }
            );
            return;
        }

        // КНОПКА: КУПИТЬ ДОСТУП
        if (query.data === 'buy') {
            await upsertUserProfile(profile);

            if (!(await hasFreeLinks())) {
                await sendPhotoMessage(
                    chatId,
                    photoPayment,
                    buildSoldOutText(),
                    actionKeyboard({ buy: false, reviews: true, supportText: '💬 Написать в поддержку' })
                );
                return;
            }

            const payUrl = buildPaymentUrl(profile.id);
            const keyboard = [
                [{ text: '✅ Я оплатил', callback_data: 'check_payment' }],
                [{ text: '💬 Поддержка', url: `https://t.me/${supportUsername}` }]
            ];

            if (payUrl) {
                keyboard.unshift([{ text: '💳 Перейти к оплате', url: payUrl }]);
            } else {
                await notifyAdminError('кнопка buy', new Error('YOOMONEY_WALLET не задан'));
            }
            
            await sendPaymentMessage(chatId, buildPaymentText(), {
                inline_keyboard: keyboard
            });
            return;
        }

        // КНОПКА: О ПРОЕКТЕ
        if (query.data === 'about') {
            await sendPhotoMessage(chatId, photoAbout, buildAboutText(), actionKeyboard({ referral: true }));
            return;
        }

        // КНОПКА: ОТЗЫВЫ
        if (query.data === 'reviews') {
            const db = await readDB();
            await sendPhotoMessage(chatId, photoReviews, buildPublicReviewsText(db.reviews), {
                inline_keyboard: actionKeyboard({ leaveReview: true, referral: true }).inline_keyboard
            });
            return;
        }

        // КНОПКА: РЕФЕРАЛЬНАЯ ПРОГРАММА
        if (query.data === 'referral') {
            const user = await upsertUserProfile(profile);
            const referral = normalizeReferral(user?.referral);

            if (referral.active) {
                await sendPhotoMessage(chatId, photoReferral, buildReferralCabinetText(user), {
                    inline_keyboard: [
                        [{ text: '💸 Запросить вывод', callback_data: 'referral_withdraw' }],
                        [{ text: '💎 Купить доступ', callback_data: 'buy' }],
                        [{ text: '💬 Поддержка', url: `https://t.me/${supportUsername}` }]
                    ]
                });
                return;
            }

            await sendPhotoMessage(chatId, photoReferral, buildReferralIntroText(), {
                inline_keyboard: [
                    [{ text: '🤝 Стать партнёром', callback_data: 'referral_join' }],
                    [{ text: '💎 Купить доступ', callback_data: 'buy' }],
                    [{ text: '💬 Поддержка', url: `https://t.me/${supportUsername}` }]
                ]
            });
            return;
        }

        if (query.data === 'referral_join') {
            await upsertUserProfile(profile);
            referralDrafts.set(profile.id, { createdAt: new Date().toISOString() });
            await bot.sendMessage(chatId, buildReferralDetailsPrompt(), { parse_mode: 'HTML' });
            return;
        }

        if (query.data === 'referral_withdraw') {
            const result = await createWithdrawal(profile.id);

            if (!result) {
                const user = await getUser(profile.id);
                await bot.sendMessage(
                    chatId,
                    [
                        '💸 <b>Вывод пока недоступен</b>',
                        '',
                        'На партнёрском балансе нет средств для вывода.',
                        '',
                        user?.referral?.active ? buildReferralCabinetText(user) : 'Сначала подключите реферальную программу.'
                    ].join('\n'),
                    { parse_mode: 'HTML', disable_web_page_preview: true }
                );
                return;
            }

            const { withdrawal, user } = result;
            await bot.sendMessage(chatId, `✅ Запрос на вывод ${withdrawal.amount} ₽ отправлен админам. После выплаты вы получите уведомление.`);
            await sendToAdmins(
                buildWithdrawalAdminText(withdrawal, user),
                {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Выплачено', callback_data: `payout_approve_${withdrawal.id}` },
                                { text: '❌ Отклонить', callback_data: `payout_reject_${withdrawal.id}` }
                            ],
                            [{ text: '💬 Написать партнёру', url: profileUrl(profile) }]
                        ]
                    }
                }
            );
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
            if (!isAdmin(query.from.id)) return;
            const reviewId = query.data.replace('review_approve_', '');
            const review = await updateReviewStatus(reviewId, 'approved');

            if (!review) {
                await bot.sendMessage(chatId, '⚠️ Отзыв не найден.');
                return;
            }

            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            await sendToAdmins(`✅ Отзыв опубликован: ${stars(review.rating)} от ${review.displayName}`);
            await bot.sendMessage(review.userId, '✅ Спасибо! Ваш отзыв прошёл модерацию и опубликован в блоке отзывов.');
            return;
        }

        // АДМИН: ОТКЛОНИТЬ ОТЗЫВ
        if (query.data.startsWith('review_reject_')) {
            if (!isAdmin(query.from.id)) return;
            const reviewId = query.data.replace('review_reject_', '');
            const review = await updateReviewStatus(reviewId, 'rejected');

            if (!review) {
                await bot.sendMessage(chatId, '⚠️ Отзыв не найден.');
                return;
            }

            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            await sendToAdmins(`❌ Отзыв отклонён: ${stars(review.rating)} от ${review.displayName}`);
            return;
        }

        // АДМИН: ПОДТВЕРДИТЬ/ОТКЛОНИТЬ ВЫПЛАТУ ПАРТНЁРУ
        if (query.data.startsWith('payout_approve_')) {
            if (!isAdmin(query.from.id)) return;
            const withdrawalId = query.data.replace('payout_approve_', '');
            const result = await updateWithdrawal(withdrawalId, 'paid', query.from.id);

            if (!result) {
                await bot.sendMessage(chatId, '⚠️ Запрос на вывод уже обработан или не найден.');
                return;
            }

            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            await bot.sendMessage(result.user.id, `✅ Выплата ${result.withdrawal.amount} ₽ отправлена. Спасибо за участие в партнёрской программе VOIDLINK X.`);
            await sendToAdmins(`✅ Выплата ${result.withdrawal.amount} ₽ партнёру ${result.user.id} отмечена как отправленная.`);
            return;
        }

        if (query.data.startsWith('payout_reject_')) {
            if (!isAdmin(query.from.id)) return;
            const withdrawalId = query.data.replace('payout_reject_', '');
            const result = await updateWithdrawal(withdrawalId, 'rejected', query.from.id);

            if (!result) {
                await bot.sendMessage(chatId, '⚠️ Запрос на вывод уже обработан или не найден.');
                return;
            }

            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            await bot.sendMessage(result.user.id, `❌ Запрос на вывод ${result.withdrawal.amount} ₽ отклонён. Сумма возвращена на партнёрский баланс.`);
            await sendToAdmins(`❌ Запрос на вывод ${result.withdrawal.amount} ₽ партнёра ${result.user.id} отклонён.`);
            return;
        }

        // КНОПКА: ПОДДЕРЖКА
        if (query.data === 'support') {
            await sendPhotoMessage(chatId, photoSupport, buildSupportText(), {
                inline_keyboard: [
                    [{ text: '💬 Написать в поддержку', url: `https://t.me/${supportUsername}` }],
                    [{ text: '💎 Купить доступ', callback_data: 'buy' }],
                    [{ text: '🤝 Реферальная программа', callback_data: 'referral' }]
                ]
            });
            return;
        }

        // ПОЛЬЗОВАТЕЛЬ НАЖАЛ "Я ОПЛАТИЛ"
        if (query.data === 'check_payment') {
            const user = await upsertUserProfile(profile);

            if (!(await hasFreeLinks())) {
                await sendPhotoMessage(
                    chatId,
                    photoPayment,
                    buildSoldOutText(),
                    actionKeyboard({ buy: false, reviews: true, supportText: '💬 Написать в поддержку' })
                );
                await sendToAdmins(
                    `⚠️ Пользователь ${profile.id} нажал «Я оплатил», но пул ссылок пуст. Проверьте оплату и добавьте ссылки через /addlink <url>.`
                );
                return;
            }

            const request = await createPaymentRequest(profile);
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '✅ Подтвердить', callback_data: `confirm_${request.id}` },
                        { text: '❌ Отклонить', callback_data: `reject_${request.id}` }
                    ],
                    [{ text: '💬 Написать пользователю', url: profileUrl(profile) }]
                ]
            };
            
            await sendToAdmins(
                buildPaymentRequestAdminText(request, { ...profile, referredBy: user?.referredBy }),
                { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true }
            );
            
            await bot.sendMessage(profile.id, '✅ Заявка отправлена администратору. Доступ будет выдан после ручной проверки платежа, обычно в течение 5-15 минут.');
            return;
        }

        // АДМИН ПОДТВЕРДИЛ
        if (query.data.startsWith('confirm_')) {
            if (!isAdmin(query.from.id)) return;
            const requestId = query.data.replace('confirm_', '');
            const request = await getPendingPaymentRequest(requestId);

            if (!request) {
                await bot.sendMessage(chatId, '⚠️ Заявка уже обработана или не найдена.');
                return;
            }

            const userId = Number(request.userId);
            
            let user = await getUser(userId);
            const link = await reserveFreeLink();
            if (!link) {
                await sendToAdmins(`⚠️ Нет свободных ссылок для пользователя ${userId}. Добавьте ссылки через /addlink <url>.`);
                await bot.sendMessage(
                    userId,
                    buildSoldOutText(),
                    { parse_mode: 'HTML', reply_markup: actionKeyboard({ buy: false, supportText: '💬 Написать в поддержку' }) }
                );
                return;
            }

            await updatePaymentRequest(requestId, 'approved', query.from.id);

            const existingLinks = normalizeUserLinks(user);
            const issuedAt = new Date().toISOString();
            const userLinks = [
                ...existingLinks,
                { url: link, issuedAt }
            ];

            user = {
                id: userId,
                telegramId: userId,
                username: user?.username || '',
                firstName: user?.firstName || '',
                lastName: user?.lastName || '',
                languageCode: user?.languageCode || '',
                purchases: userLinks.length,
                links: userLinks,
                personalLink: userLinks[0]?.url || link,
                referredBy: user?.referredBy || request.referredBy || null,
                referral: user?.referral || null,
                active: true,
                createdAt: user?.createdAt || issuedAt,
                firstPaidAt: user?.firstPaidAt || issuedAt,
                updatedAt: issuedAt
            };

            await saveUser(user);
            await addPayment({
                user: userId,
                amount: paymentGrossAmount,
                netAmount: paymentNetAmount,
                feeAmount: paymentFeeAmount,
                requestId,
                referredBy: user.referredBy || null,
                date: new Date().toISOString()
            });
            const referralCredit = await creditReferral(user);

            const linkToSend = link;

            await bot.sendMessage(userId, buildClientAccessText({ linkToSend }), { parse_mode: 'HTML', disable_web_page_preview: true });
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            await sendToAdmins(`✅ Оригинальная ссылка выдана пользователю ${userId}. Покупок у клиента: ${userLinks.length}. Ссылка удалена из пула.`);

            if (referralCredit) {
                await bot.sendMessage(
                    referralCredit.referrer.id,
                    `💰 По вашей реферальной ссылке подтверждена покупка. Начислено ${referralCredit.amount} ₽. Баланс: ${referralCredit.referrer.referral.balance} ₽.`
                );
                await sendToAdmins(`🤝 Реферальное начисление: ${referralCredit.amount} ₽ партнёру ${referralCredit.referrer.id} за покупку ${userId}.`);
            }
            return;
        }

        // АДМИН ОТКЛОНИЛ
        if (query.data.startsWith('reject_')) {
            if (!isAdmin(query.from.id)) return;
            const requestId = query.data.replace('reject_', '');
            const request = await updatePaymentRequest(requestId, 'rejected', query.from.id);

            if (!request) {
                await bot.sendMessage(chatId, '⚠️ Заявка уже обработана или не найдена.');
                return;
            }

            const userId = Number(request.userId);
            await bot.sendMessage(userId, '❌ Платёж не подтверждён. Пожалуйста, проверьте сумму, кошелёк и попробуйте отправить заявку ещё раз.');
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            await sendToAdmins(`❌ Заявка пользователя ${userId} отклонена.`);
            return;
        }

    } catch (error) {
        console.error('Ошибка в callback_query:', error.message);
        await notifyAdminError(`callback ${query.data || 'unknown'} от ${query.from?.id || chatId}`, error);
    }
});

bot.on('message', async (msg) => {
    const profile = profileFromTelegram(msg.from);
    await upsertUserProfile(profile, { action: msg.text?.startsWith('/') ? msg.text.split(/\s+/)[0] : 'message' });

    if (!msg.text || msg.text.startsWith('/')) return;

    if (isAdmin(profile.id) && broadcastDrafts.has(profile.id)) {
        const text = msg.text.trim();

        if (text.length < 2) {
            await bot.sendMessage(msg.chat.id, '📣 Сообщение слишком короткое. Отправьте текст рассылки или /cancel.');
            return;
        }

        broadcastDrafts.delete(profile.id);
        const result = await broadcastToUsers(text);
        await bot.sendMessage(
            msg.chat.id,
            `✅ Рассылка завершена.\n\nПолучателей: ${result.total}\nОтправлено: ${result.sent}\nОшибок: ${result.failed}`
        );
        return;
    }

    const referralDraft = referralDrafts.get(profile.id);
    if (referralDraft) {
        const details = msg.text.trim();

        if (details.length < 15) {
            await bot.sendMessage(msg.chat.id, '📝 Напишите чуть подробнее: ФИО, телефон и банк одним сообщением.');
            return;
        }

        const user = await registerReferralPartner(profile.id, details);
        referralDrafts.delete(profile.id);

        await bot.sendMessage(
            msg.chat.id,
            [
                '✅ <b>Партнёрская программа подключена</b>',
                '',
                'Ваша личная ссылка готова:',
                referralLink(profile.id),
                '',
                'Все начисления будут отображаться в партнёрском кабинете.'
            ].join('\n'),
            {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🤝 Открыть кабинет', callback_data: 'referral' }],
                        [{ text: '💬 Поддержка', url: `https://t.me/${supportUsername}` }]
                    ]
                }
            }
        );
        await sendToAdmins(`🤝 Новый партнёр: ${profile.id}\n\n${escapeHtml(details)}`, { parse_mode: 'HTML' });
        return;
    }

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

    await sendToAdmins(
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
    if (!isAdmin(msg.chat.id)) return;
    await bot.sendMessage(msg.chat.id, [
        '🛰 <b>VOIDLINK X ADMIN</b>',
        '',
        '📦 /links — статус пула ссылок',
        '👥 /users — клиенты и Telegram ID',
        '💰 /stats — финансы',
        '🤝 /affiliates — партнёры и выплаты',
        '📣 /broadcast — рассылка',
        '💬 /support — контакт поддержки',
        '⭐ /reviews — блок отзывов',
        '➕ /addlink &lt;url&gt; — добавить ссылку'
    ].join('\n'), {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📣 Сделать рассылку', callback_data: 'admin_broadcast' }]
            ]
        }
    });
});

bot.onText(/\/support/, async (msg) => {
    await sendPhotoMessage(
        msg.chat.id,
        photoSupport,
        buildSupportText(),
        actionKeyboard({ referral: true, supportText: '💬 Написать в поддержку' })
    );
});

bot.onText(/\/reviews/, async (msg) => {
    const db = await readDB();
    await sendPhotoMessage(
        msg.chat.id,
        photoReviews,
        buildPublicReviewsText(db.reviews),
        actionKeyboard({ leaveReview: true, referral: true })
    );
});

bot.onText(/\/cancel/, async (msg) => {
    if (!isAdmin(msg.chat.id)) return;
    broadcastDrafts.delete(msg.chat.id);
    await bot.sendMessage(msg.chat.id, '✅ Действие отменено.');
});

bot.onText(/\/broadcast(?:\s+([\s\S]+))?/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return;
    const text = match?.[1]?.trim();

    if (!text) {
        broadcastDrafts.add(msg.chat.id);
        await bot.sendMessage(
            msg.chat.id,
            '📣 Отправьте следующим сообщением текст рассылки. Для отмены: /cancel.'
        );
        return;
    }

    const result = await broadcastToUsers(text);
    await bot.sendMessage(
        msg.chat.id,
        `✅ Рассылка завершена.\n\nПолучателей: ${result.total}\nОтправлено: ${result.sent}\nОшибок: ${result.failed}`
    );
});

bot.onText(/\/referral/, async (msg) => {
    const profile = profileFromTelegram(msg.from);
    const user = await upsertUserProfile(profile);
    const referral = normalizeReferral(user?.referral);

    if (referral.active) {
        await sendPhotoMessage(msg.chat.id, photoReferral, buildReferralCabinetText(user), {
            inline_keyboard: [
                [{ text: '💸 Запросить вывод', callback_data: 'referral_withdraw' }],
                [{ text: '💎 Купить доступ', callback_data: 'buy' }],
                [{ text: '💬 Поддержка', url: `https://t.me/${supportUsername}` }]
            ]
        });
        return;
    }

    await sendPhotoMessage(msg.chat.id, photoReferral, buildReferralIntroText(), {
        inline_keyboard: [
            [{ text: '🤝 Стать партнёром', callback_data: 'referral_join' }],
            [{ text: '💎 Купить доступ', callback_data: 'buy' }],
            [{ text: '💬 Поддержка', url: `https://t.me/${supportUsername}` }]
        ]
    });
});

bot.onText(/\/links/, async (msg) => {
    if (!isAdmin(msg.chat.id)) return;
    const links = await getLinks();
    const free = links.filter(l => l.status === 'free').length;
    const details = links.slice(0, 20).map((link, index) => {
        return `${index + 1}. 🟢 free\n   ${escapeHtml(link.url)}`;
    });

    await bot.sendMessage(msg.chat.id, [
        '📦 <b>Пул ссылок</b>',
        '',
        `🟢 Свободно: ${free}`,
        `📊 Всего: ${links.length}`,
        '🔄 Обновление пула: 11:00 и 23:00 по МСК',
        '',
        ...details
    ].join('\n'), { parse_mode: 'HTML' });
});

bot.onText(/\/users/, async (msg) => {
    if (!isAdmin(msg.chat.id)) return;
    const db = await readDB();
    const users = db.users.filter(u => normalizeUserLinks(u).length > 0 || Number(u.purchases || u.monthsPaid || 0) > 0);
    if (!users.length) return bot.sendMessage(msg.chat.id, '👥 Клиентов с подтверждёнными оплатами пока нет.');

    let text = '👥 <b>Клиенты VOIDLINK X</b>\n\n';
    users.forEach((u, i) => {
        const telegramId = u.telegramId || u.id;
        const username = u.username ? `@${u.username}` : 'не указан';
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'не указано';
        const userLinks = normalizeUserLinks(u);
        const status = 'ссылка выдана';
        text += `${i + 1}. 👤 Клиент\n`;
        text += `🆔 Telegram ID: <code>${telegramId}</code>\n`;
        text += `🔗 Username: ${escapeHtml(username)}\n`;
        text += `📝 Имя: ${escapeHtml(name)}\n`;
        text += `💎 Покупок: ${userLinks.length || u.purchases || u.monthsPaid || 1}\n`;
        userLinks.forEach((link, linkIndex) => {
            const issued = link.issuedAt ? ` (${new Date(link.issuedAt).toLocaleDateString('ru-RU')})` : '';
            text += `🔗 #${linkIndex + 1}: ${escapeHtml(link.url)}${issued}\n`;
        });
        text += `🛡 Статус: ${status}\n\n`;
    });
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.onText(/\/affiliates/, async (msg) => {
    if (!isAdmin(msg.chat.id)) return;
    const db = await readDB();
    const partners = db.users.filter((user) => user.referral?.active);
    const pending = db.withdrawals.filter((item) => item.status === 'pending');

    if (!partners.length && !pending.length) {
        await bot.sendMessage(msg.chat.id, '🤝 Партнёров и активных заявок на вывод пока нет.');
        return;
    }

    let text = '🤝 <b>Партнёрская программа</b>\n\n';

    if (partners.length) {
        text += '<b>Партнёры:</b>\n';
        partners.forEach((user, index) => {
            const referral = normalizeReferral(user.referral);
            const username = user.username ? `@${user.username}` : 'не указан';
            text += `${index + 1}. <code>${user.id}</code> | ${escapeHtml(username)}\n`;
            text += `   Баланс: ${referral.balance} ₽ | начислено: ${referral.totalEarned} ₽ | выплачено: ${referral.totalPaidOut} ₽\n`;
        });
        text += '\n';
    }

    if (pending.length) {
        text += '<b>Ожидают выплаты:</b>\n';
        pending.forEach((item, index) => {
            text += `${index + 1}. <code>${item.userId}</code> — ${item.amount} ₽ | <code>${item.id}</code>\n`;
        });
    }

    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg.chat.id)) return;
    const db = await readDB();
    const grossTotal = db.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const netTotal = db.payments.reduce((sum, p) => sum + Number(p.netAmount ?? p.amount ?? 0), 0);
    const feeTotal = db.payments.reduce((sum, p) => {
        const gross = Number(p.amount || 0);
        const net = Number(p.netAmount ?? gross);
        return sum + Number(p.feeAmount ?? (gross - net));
    }, 0);
    const referralTotal = db.referralEarnings.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const pendingWithdrawals = db.withdrawals
        .filter((item) => item.status === 'pending')
        .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const activity = activityStats(db.users);
    await bot.sendMessage(msg.chat.id, [
        '💰 <b>Финансы</b>',
        '',
        `💎 Продажи: ${formatMoney(grossTotal)} ₽`,
        `💳 Получено после комиссии: ${formatMoney(netTotal)} ₽`,
        `🏦 Комиссия платежки: ${formatMoney(feeTotal)} ₽`,
        `🧾 Транзакций: ${db.payments.length}`,
        `🤝 Реферальных начислений: ${formatMoney(referralTotal)} ₽`,
        `💸 Ожидают выплаты: ${formatMoney(pendingWithdrawals)} ₽`,
        '',
        '📊 <b>Активность бота</b>',
        `👥 Всего открывали/нажимали: ${activity.total}`
    ].join('\n'), { parse_mode: 'HTML' });
});

bot.onText(/\/addlink (.+)/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return;
    const newUrl = match[1];
    const links = await getLinks();
    links.push({ url: newUrl, status: 'free' });
    await saveLinks(links);
    await bot.sendMessage(msg.chat.id, `✅ Ссылка добавлена в пул:\n${newUrl}`);
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
            { command: 'reviews', description: '⭐ Отзывы' },
            { command: 'referral', description: '🤝 Реферальная программа' }
        ]);
        const adminCommands = [
            { command: 'start', description: '🛰 Открыть VOIDLINK X' },
            { command: 'support', description: '💬 Поддержка' },
            { command: 'reviews', description: '⭐ Отзывы' },
            { command: 'referral', description: '🤝 Реферальная программа' },
            { command: 'admin', description: '🛠 Админ-панель' },
            { command: 'links', description: '📦 Пул ссылок' },
            { command: 'users', description: '👥 Клиенты' },
            { command: 'stats', description: '💰 Финансы' },
            { command: 'affiliates', description: '🤝 Партнёры' },
            { command: 'broadcast', description: '📣 Рассылка' }
        ];

        for (const adminId of adminIds) {
            await bot.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: adminId } });
        }
    } catch (error) {
        console.error('Не удалось обновить описание бота:', error.message);
    }
}

async function startBot() {
    if (!process.env.BOT_TOKEN) {
        throw new Error('BOT_TOKEN не задан в .env');
    }

    if (!ADMIN_ID) {
        throw new Error('ADMIN_ID/ADMIN_IDS не задан или не является числом');
    }

    await bot.deleteWebHook({ drop_pending_updates: true });
    await bot.startPolling({ restart: true });
    await configureBotProfile();
}

// --- ЗАПУСК СЕРВЕРА (только для Railway, вебхук не используется) ---
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
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
