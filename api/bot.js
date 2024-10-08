const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const winston = require('winston');
require('dotenv').config();
const { celebrate, Joi, errors } = require('celebrate');

// Validate required environment variables
const requiredEnvVars = ['BOT_TOKEN', 'WEB_APP_URL', 'HOMEPAGE_URL', 'TG_ID'];
requiredEnvVars.forEach((varName) => {
    if (!process.env[varName]) {
        throw new Error(`Environment variable ${varName} is required`);
    }
});

const app = express();
const webAppUrl = process.env.WEB_APP_URL;

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: webAppUrl }));
app.use(helmet());

// Logger setup with Winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple(),
    }));
}

// Initialize Telegram Bot
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Handle incoming messages with switch-case
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.toLowerCase();

    switch(text) {
        case '/start':
            await sendStartMessage(chatId);
            break;
        case '/form':
            await sendFormMessage(chatId);
            break;
        case '/shop':
            await sendShopMessage(chatId);
            break;
        default:
            await bot.sendMessage(chatId, 'Невідома команда. Спробуйте знову.');
    }

    if (msg?.web_app_data?.data) {
        await handleWebAppData(msg);
    }
});

// Matches /form
async function sendFormMessage(chatId) {
    await bot.sendMessage(chatId, 'Щоб відкрити форму, будь ласка, натисніть на кнопку нижче:', {
        reply_markup: {
            keyboard: [
                [
                    { text: 'Відкрити форму', web_app: { url: `${webAppUrl}/form` } }
                ]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    }).catch((error) => {
        logger.error('Error sending form message:', error);
    });
}

// Matches /shop
async function sendShopMessage(chatId) {
    await bot.sendMessage(chatId, 'Щоб перейти до нашого магазину, натисніть кнопку нижче:', {
        reply_markup: {
            keyboard: [
                [
                    { text: 'Замовити сайт', web_app: { url: webAppUrl } }
                ]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    }).catch((error) => {
        logger.error('Error sending shop message:', error);
    });
}

// Send a welcome message with custom keyboard options
async function sendStartMessage(chatId) {
    await bot.sendMessage(chatId, 'Заходьте на наш сайт!', {
        reply_markup: {
            keyboard: [
                [
                    { text: 'Замовити сайт', web_app: { url: webAppUrl } },
                    { text: 'Залишити заявку', web_app: { url: `${webAppUrl}/form` } }
                ]
            ]
        }
    }).catch((error) => {
        logger.error('Error sending start message:', error);
    });
}

// Handle data received from a web app via the Telegram bot
async function handleWebAppData(msg) {
    const chatId = msg.chat.id;
    try {
        const data = JSON.parse(msg.web_app_data.data);
        logger.info(`Received data from chatId ${chatId}:`, data);

        await retrySendMessage(chatId, `Дякую за зворотній зв'язок!, Ваш chatId: ${chatId}`);
        await retrySendMessage(process.env.TG_ID, `Нова заявка: ${data.email}, ${data.number}, ${data.name}`);
        await sendFollowUpMessage(chatId);
    } catch (error) {
        logger.error('Error handling web app data', error);
    }
}

// Retry sending a message with exponential backoff
async function retrySendMessage(chatId, message, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await bot.sendMessage(chatId, message);
        } catch (error) {
            logger.error('Error sending message', error);
            if (i === retries - 1) throw error; // Last attempt, rethrow the error
            await delay(1000 * (i + 1)); // Exponential backoff
        }
    }
}

// Send a follow-up message after a delay
async function sendFollowUpMessage(chatId) {
    try {
        await delay(3000);
        await bot.sendMessage(chatId, `
            Всю інформацію Ви отримаєте у цьому чаті: @financial_grammarly,
            а поки наш менеджер займається обробкою Вашої заявки,
            завітайте на наш сайт! ${process.env.HOMEPAGE_URL}
        `);
    } catch (error) {
        logger.error('Error sending follow-up message', error);
    }
}

// Delay execution for a specified number of milliseconds
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Input validation for /web-data endpoint
app.post('/web-data', celebrate({
    body: Joi.object().keys({
        queryId: Joi.string().required(),
        products: Joi.array().items(Joi.object().keys({
            title: Joi.string().required()
        })),
        totalPrice: Joi.number().required(),
    })
}), async (req, res) => {
    const { queryId, products, totalPrice } = req.body;
    try {
        await bot.answerWebAppQuery(queryId, {
            type: 'article',
            id: queryId,
            title: 'Успішна купівля',
            input_message_content: {
                message_text: `Вітаю зі зверненням, ви купили товар на суму ${totalPrice}, ${products.map(item => item.title).join(', ')}`
            }
        });
        return res.status(200).json({});
    } catch (error) {
        logger.error('Error in /web-data endpoint', error);
        await bot.answerWebAppQuery(queryId, {
            type: 'article',
            id: queryId,
            title: 'НЕ успішна купівля',
            input_message_content: {
                message_text: `Вийшла помилка з придбанням товару на сумму ${totalPrice}, ${products.map(item => item.title).join(', ')}`
            }
        });
        return res.status(500).json({ message: 'Internal Server Error' });
    }
});

// GET / endpoint
app.get('/', (req, res) => {
    return res.status(200).json({
        message: 'Welcome to the Telegram Bot API!',
        homepage: process.env.HOMEPAGE_URL,
        webAppUrl: webAppUrl
    });
});

// Global error handler
app.use(errors());  // celebrate error handler
app.use((err, req, res, next) => {
    logger.error('Unhandled error', err);
    res.status(500).json({ message: 'Internal Server Error' });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server started on PORT ${PORT}`));

module.exports = app;