const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrImage = require('qrcode');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');
const ytScraper = require('@vreden/youtube_scraper');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

ffmpeg.setFfmpegPath(ffmpegPath);
const execFileAsync = promisify(execFile);

const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(DATA_DIR, { recursive: true });

const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const OWNERLOCK_FILE = path.join(DATA_DIR, 'ownerlock.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedules.json');
const AUTH_DATA_PATH = path.resolve(process.env.AUTH_DATA_PATH || path.join(DATA_DIR, '.wwebjs_auth'));
const YOUTUBE_COOKIES_FILE = path.resolve(process.env.YOUTUBE_COOKIES_FILE || path.join(DATA_DIR, 'youtube-cookies.txt'));
const YT_DLP_PROXY_DIRECT_FALLBACK = process.env.YT_DLP_PROXY_DIRECT_FALLBACK !== 'false';
const COBALT_API_URL = String(process.env.COBALT_API_URL || '').trim().replace(/\/+$/, '');
const SCHEDULE_UTC_OFFSET_HOURS = 3;
const SCHEDULE_TIMEZONE_LABEL = 'Africa/Nairobi';
const AUDIO_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const WELCOME_MODE_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_AUDIO_BYTES = 100 * 1024;
const MIN_VIDEO_BYTES = 500 * 1024;
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_MB || 45) * 1024 * 1024;
const YT_DLP_VIDEO_HEIGHT = Number(process.env.YT_DLP_VIDEO_HEIGHT || 360);
const HOSTING_PROMO = 'For bot hosting call +254 772 418884.';
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)
  ? process.env.PUPPETEER_EXECUTABLE_PATH
  : undefined;
const PAIRING_PHONE_NUMBER = String(process.env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, '');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const INVITE_DEFAULT_LIMIT = 50;
const INVITE_MAX_PER_RUN = 50;
const INVITE_DIRECT_BATCH_SIZE = 3;
const INVITE_DIRECT_BATCH_DELAY_MS = 45000;
const INVITE_DM_DELAY_MS = 15000;
const INVITE_COOLDOWN_MS = 72 * HOUR_MS;
const SESSION_BROADCAST_DELAY_MS = 2500;
const DEFAULT_GHOST_STATUS_INTERVAL_MS = 2 * HOUR_MS;
const MIN_GHOST_STATUS_INTERVAL_MS = 5 * 60 * 1000;
const MAX_STATUS_CACHE = 200;
const PLAN_REMINDER_INTERVAL_MS = HOUR_MS;
const PLAN_REMINDER_THRESHOLDS = [
  { key: '3d', label: '3 days', ms: 3 * DAY_MS },
  { key: '1d', label: '1 day', ms: DAY_MS },
  { key: '6h', label: '6 hours', ms: 6 * HOUR_MS }
];
const MOODS = ['normal', 'flirty', 'soft', 'teasing', 'clingy', 'jealous', 'sweet', 'sassy', 'savage', 'romantic', 'funny', 'loyal', 'rude', 'shy', 'dramatic', 'girlfriend', 'bestie'];
const MOOD_COMMANDS = MOODS.filter(mood => mood !== 'normal').map(mood => `.mood ${mood} on/off`);

function load(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return def;
  }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let memory = load(MEMORY_FILE, {
  users: {},
  groups: {},
  sessions: {},
  warns: {},
  savedContacts: {},
  inviteOptIns: {},
  inviteHistory: {},
  botAdmins: { global: {}, groups: {} }
});

let sessions = load(SESSION_FILE, { sessions: ['main'] });
let ownerlock = load(OWNERLOCK_FILE, { enabled: false, owners: [] });
if (!Array.isArray(ownerlock.owners)) ownerlock.owners = [];
ownerlock.enabled = Boolean(ownerlock.enabled);
let schedules = load(SCHEDULE_FILE, { schedules: [] });
if (!Array.isArray(schedules.schedules)) schedules.schedules = [];

function normalizeRuntimeState() {
  if (!memory.users) memory.users = {};
  if (!memory.groups) memory.groups = {};
  if (!memory.sessions) memory.sessions = {};
  if (!memory.warns) memory.warns = {};
  if (!memory.savedContacts || Array.isArray(memory.savedContacts)) memory.savedContacts = {};
  if (!memory.inviteOptIns || Array.isArray(memory.inviteOptIns)) memory.inviteOptIns = {};
  if (!memory.inviteHistory || Array.isArray(memory.inviteHistory)) memory.inviteHistory = {};
  if (!memory.botAdmins || Array.isArray(memory.botAdmins)) memory.botAdmins = {};
  if (!memory.botAdmins.global || Array.isArray(memory.botAdmins.global)) memory.botAdmins.global = {};
  if (!memory.botAdmins.groups || Array.isArray(memory.botAdmins.groups)) memory.botAdmins.groups = {};
  if (!Array.isArray(sessions.sessions)) sessions.sessions = ['main'];
  if (!sessions.sessions.length) sessions.sessions = ['main'];
  if (!Array.isArray(ownerlock.owners)) ownerlock.owners = [];
  ownerlock.enabled = Boolean(ownerlock.enabled);
  if (ownerlock.primaryOwner && !ownerlock.owners.includes(ownerlock.primaryOwner)) {
    ownerlock.owners.unshift(ownerlock.primaryOwner);
  }
  if (!Array.isArray(schedules.schedules)) schedules.schedules = [];
}

normalizeRuntimeState();

const clients = {};
const trackedMessages = {};
const spamBuckets = {};
const lastAutoWarn = {};
const messageCache = {};
const botStartedAt = Date.now();
const botLogs = [];
const games = {};
const lastSessionQr = {};
const scheduleIntervals = {};
const planReminderIntervals = {};
const ghostStatusIntervals = {};
const restartTimers = {};
const statusMessageCache = {};
const pairingRequests = {};
let shuttingDown = false;
const processedMessages = new Set();
const botDeletedMessageIds = new Set();

const BADWORDS_VERSION = 4;
const DEFAULT_BADWORDS = [
  'fuck',
  'fucking',
  'fucker',
  'motherfucker',
  'mf',
  'shit',
  'bullshit',
  'bitch',
  'son of a bitch',
  'bitches',
  'asshole',
  'ass',
  'dumbass',
  'jackass',
  'bastard',
  'damn',
  'bloody',
  'dick',
  'dickhead',
  'prick',
  'cock',
  'pussy',
  'cunt',
  'whore',
  'slut',
  'hoe',
  'thot',
  'porn',
  'sex',
  'nude',
  'nudes',
  'naked',
  'jerk',
  'retard',
  'moron',
  'idiot',
  'stupid',
  'fool',
  'loser',
  'trash',
  'garbage',
  'scumbag',
  'scammer',
  'fraudster',
  'kill yourself',
  'kys',
  'suck my',
  'eat shit',
  'nonsense',
  'shenzi',
  'umbwa',
  'mbwa',
  'fala',
  'fala wewe',
  'mjinga',
  'mjinga sana',
  'mpumbavu',
  'pumbavu',
  'puuzi',
  'mshenzi',
  'ngombe',
  "ng'ombe",
  'ngombe wewe',
  'kichwa maji',
  'kinyonga',
  'matako',
  'kuma',
  'kumamako',
  'kuma yako',
  'kumamake',
  'kumamamako',
  'kumbavu',
  'mamako',
  'nyoko',
  'nyokonyoko',
  'mkundu',
  'mavi',
  'mavi ya kuku',
  'kinyesi',
  'malaya',
  'kahaba',
  'mkora',
  'ngono',
  'uchi',
  'tombwa',
  'kutombana',
  'tomba',
  'nyonya',
  'kunyonya',
  'nyeto',
  'punyeto',
  'mkundu',
  'shoga',
  'firauni',
  'msenge',
  'takataka',
  'enda huko',
  'enda zako',
  'nyamaza',
  'nyamaza wewe',
  'shetani',
  'laana',
  'scam',
  'conman',
  'fraud',
  'thief',
  'mwizi',
  'wezi',
  'tapeli',
  'matapeli',
  'upumbavu',
  'ujinga',
  'mavi wewe',
  'kuma wewe',
  'umbwa wewe',
  'fala wewe',
  'mjinga wewe',
  'pumbavu wewe',
  'malaya wewe',
  'kahaba wewe',
  'fuck you',
  'shut up',
  'go to hell',
  'son of a bitch',
  'piece of shit'
];

const SALE_KEYWORDS = [
  'sell',
  'selling',
  'sold',
  'sale',
  'sales',
  'for sale',
  'on sale',
  'available',
  'available now',
  'stock',
  'in stock',
  'out of stock',
  'restock',
  'new stock',
  'selling cheap',
  'cheap',
  'cheap price',
  'offer',
  'offers',
  'deal',
  'deals',
  'discount',
  'promo',
  'promotion',
  'price',
  'pricing',
  'cost',
  'how much',
  'how much is it',
  'dm for price',
  'inbox for price',
  'negotiable',
  'fixed price',
  'last price',
  'wholesale',
  'retail',
  'supplier',
  'vendor',
  'buyer',
  'buying',
  'buy',
  'purchase',
  'order',
  'ordering',
  'book',
  'booking',
  'reserve',
  'delivery',
  'deliver',
  'shipping',
  'ship',
  'pickup',
  'pay',
  'payment',
  'paid',
  'deposit',
  'balance',
  'mpesa',
  'm-pesa',
  'till',
  'paybill',
  'send money',
  'trade',
  'trading',
  'swap',
  'exchange',
  'account for sale',
  'acc for sale',
  'login',
  'credentials',
  'nauza',
  'kuuza',
  'uza',
  'uzaa',
  'anauza',
  'tunauza',
  'mnauza',
  'unauza',
  'ninauza',
  'inauzwa',
  'zinauzwa',
  'linauzwa',
  'yanauzwa',
  'imeuzwa',
  'zimeuzwa',
  'bei',
  'bei gani',
  'bei yake',
  'bei ni',
  'ngapi',
  'ni ngapi',
  'pesa ngapi',
  'unatoa ngapi',
  'toa offer',
  'ofa',
  'ofa poa',
  'dili',
  'dili poa',
  'biashara',
  'fanya biashara',
  'mteja',
  'wateja',
  'customer',
  'mzigo',
  'mzigo iko',
  'mzigo mpya',
  'stoki',
  'iko stock',
  'iko available',
  'iko',
  'ziko',
  'niko nazo',
  'nazo',
  'kuna',
  'niko na',
  'niko nayo',
  'nataka kuuza',
  'nataka buyer',
  'mnunuzi',
  'nunua',
  'kununua',
  'nanunua',
  'nataka kununua',
  'chukua',
  'chukueni',
  'chukua hii',
  'bookia',
  'weka order',
  'oda',
  'agiza',
  'kuagiza',
  'dilivari',
  'leta',
  'tuma',
  'kutuma',
  'send',
  'malipo',
  'lipa',
  'kulipa',
  'lipia',
  'nimelipa',
  'weka deposit',
  'tuma pesa',
  'nitumie pesa',
  'lipa na mpesa',
  'escrow',
  'admin escrow',
  'kubadilisha',
  'badilishana',
  'ku trade',
  'kubuy',
  'kusell',
  'kuswap',
  'kuuzia'
];

function logLine(text) {
  const line = `[${new Date().toISOString()}] ${text}`;
  botLogs.push(line);
  if (botLogs.length > 200) botLogs.shift();
  console.log(line);
}

async function deleteAsBot(msg) {
  const id = msg && msg.id && msg.id._serialized;
  if (id) {
    botDeletedMessageIds.add(id);
    if (botDeletedMessageIds.size > 2000) botDeletedMessageIds.clear();
  }
  return msg.delete(true).catch(() => {});
}

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function senderId(msg) {
  const from = msg.from || '';
  if (from.includes('@g.us')) return msg.author || from;
  return msg.fromMe && msg.to ? msg.to : from;
}

function chatId(msg) {
  return msg.fromMe && msg.to ? msg.to : msg.from;
}

function activeSenderId(msg) {
  return msg.fromMe && msg.__botId ? msg.__botId : senderId(msg);
}

function knownBotIds() {
  const ids = new Set([ownerlock.primaryOwner].filter(Boolean));
  for (const item of Object.values(memory.sessions || {})) {
    if (item && item.botId) ids.add(item.botId);
  }
  return ids;
}

function isKnownBotId(id) {
  return Boolean(id && knownBotIds().has(id));
}

async function primaryBotIsInGroup(msg, currentBotId) {
  const chat = await msg.getChat().catch(() => null);
  return primaryBotIsInChat(chat, currentBotId);
}

function primaryBotIsInChat(chat, currentBotId) {
  const primaryId = ownerlock.primaryOwner || (memory.sessions.main && memory.sessions.main.botId);
  if (!primaryId || primaryId === currentBotId) return false;
  if (!chat || !chat.isGroup || !Array.isArray(chat.participants)) return false;
  return chat.participants.some(participant => participant.id && participant.id._serialized === primaryId);
}

function fallbackYoutubeReply(kind, video, reason = '') {
  const label = kind === 'video' ? 'Video' : 'Song';
  return `${label} download failed${reason ? `: ${reason}` : ''}\n\n` +
    `Here is the link instead:\n` +
    `Title: ${video.title}\n` +
    `Channel: ${video.author && video.author.name ? video.author.name : 'Unknown'}\n` +
    `Duration: ${video.timestamp || 'Unknown'}\n` +
    `Link: ${video.url}`;
}

function saveOwnerlock() {
  save(OWNERLOCK_FILE, ownerlock);
}

function saveSchedules() {
  save(SCHEDULE_FILE, schedules);
}

function stopScheduleLoop(sessionNameValue) {
  if (!scheduleIntervals[sessionNameValue]) return;
  clearInterval(scheduleIntervals[sessionNameValue]);
  delete scheduleIntervals[sessionNameValue];
}

function clearSessionRestart(name) {
  if (!restartTimers[name]) return;
  clearTimeout(restartTimers[name]);
  delete restartTimers[name];
}

function scheduleSessionRestart(name, reason, delayMs = 15000) {
  if (shuttingDown || restartTimers[name] || !sessions.sessions.includes(name)) return;
  logLine(`[${name}] reconnect scheduled in ${Math.round(delayMs / 1000)}s: ${reason}`);
  restartTimers[name] = setTimeout(async () => {
    delete restartTimers[name];
    if (shuttingDown || !sessions.sessions.includes(name)) return;
    const current = clients[name];
    if (current) {
      await current.destroy().catch(e => logLine(`[${name}] destroy before reconnect failed: ${e.message}`));
      delete clients[name];
    }
    start(name).catch(e => logLine(`[${name}] reconnect failed: ${e.message}`));
  }, delayMs);
}

function sessionAuthDir(name) {
  return path.join(AUTH_DATA_PATH, `session-${name}`);
}

function removeStaleBrowserLocks(name) {
  const dir = sessionAuthDir(name);
  const lockFile = path.join(dir, 'SingletonLock');
  const socketFile = path.join(dir, 'SingletonSocket');
  const cookieFile = path.join(dir, 'SingletonCookie');
  const devtoolsFile = path.join(dir, 'DevToolsActivePort');

  if (!fs.existsSync(dir)) return;

  let lockTarget = '';
  try {
    lockTarget = fs.readlinkSync(lockFile);
  } catch {}

  const pidMatch = String(lockTarget).match(/-(\d+)$/);
  const pid = pidMatch ? Number(pidMatch[1]) : null;
  const stillRunning = pid ? processExists(pid) : false;
  if (stillRunning) return;

  for (const file of [lockFile, socketFile, cookieFile, devtoolsFile]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }

  if (lockTarget) logLine(`[${name}] removed stale browser lock from saved auth session`);
}

function processExists(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function shutdownGracefully(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logLine(`Graceful shutdown started (${code}). Preserving WhatsApp auth sessions.`);

  for (const name of Object.keys(restartTimers)) clearSessionRestart(name);
  for (const name of Object.keys(scheduleIntervals)) stopScheduleLoop(name);
  for (const name of Object.keys(ghostStatusIntervals)) stopGhostStatusLoop(name);
  for (const name of Object.keys(planReminderIntervals)) {
    clearInterval(planReminderIntervals[name]);
    delete planReminderIntervals[name];
  }

  await Promise.all(Object.entries(clients).map(async ([name, client]) => {
    await client.destroy().catch(e => logLine(`[${name}] graceful destroy failed: ${e.message}`));
    delete clients[name];
  }));

  process.exit(code);
}

function isTrustedOwner(id) {
  return ownerlock.owners.includes(id);
}

function isSessionCommandOwner(msg) {
  return Boolean(msg.fromMe || isTrustedOwner(activeSenderId(msg)));
}

async function requireOwnerAccess(msg) {
  if (isSessionCommandOwner(msg)) return true;
  await msg.reply('Owner lock is ON. This command is restricted.');
  return false;
}

async function requirePrimaryOwnerAccess(msg, botId, sessionNameValue) {
  if (!ownerlock.primaryOwner) return true;
  if (sessionNameValue === 'main' && msg.fromMe) return true;
  if (botId === ownerlock.primaryOwner && msg.fromMe) return true;
  await msg.reply('Only the first deployed bot number can use this command.');
  return false;
}

function ensureBotAdmins() {
  if (!memory.botAdmins || Array.isArray(memory.botAdmins)) memory.botAdmins = {};
  if (!memory.botAdmins.global || Array.isArray(memory.botAdmins.global)) memory.botAdmins.global = {};
  if (!memory.botAdmins.groups || Array.isArray(memory.botAdmins.groups)) memory.botAdmins.groups = {};
  return memory.botAdmins;
}

function groupBotAdmins(groupId) {
  const botAdmins = ensureBotAdmins();
  if (!botAdmins.groups[groupId]) botAdmins.groups[groupId] = {};
  return botAdmins.groups[groupId];
}

function isAllowedBotAdmin(sender, groupId) {
  if (!sender) return false;
  const botAdmins = ensureBotAdmins();
  return Boolean(botAdmins.global[sender] || (groupId && botAdmins.groups[groupId] && botAdmins.groups[groupId][sender]));
}

function canUseGroupAdminCommands(msg, groupId) {
  const sender = activeSenderId(msg);
  return Boolean(isSessionCommandOwner(msg) || isAllowedBotAdmin(sender, groupId));
}

function botAdminScope(rawValue) {
  const raw = String(rawValue || '').trim().toLowerCase();
  return raw.includes(' global ') || raw.endsWith(' global') || raw.startsWith('global ') ? 'global' : 'group';
}

function botAdminTargetFromInput(msg, rawValue) {
  const mentioned = firstMention(msg);
  if (mentioned) return mentioned;
  const clean = String(rawValue || '').replace(/\bglobal\b/ig, '').trim();
  return normalizeNumber(clean);
}

function tag(id) {
  return `@${String(id).split('@')[0]}`;
}

const WELCOME_JOKES = [
  "😂 Hey @username, I told you people to come quickly and see who has joined… now laugh before they start asking for notes!",
  "🤣 Everyone pause! @username has entered like WiFi after bundles are finished.",
  "😂 Hey @username, welcome! We almost started a search party for you.",
  "😭🤣 Look who finally joined… @username came late like school fees balance.",
  "😂 @username just landed in {groupName}. Please behave, important visitor has arrived.",
  "🤣 Hey @username, you entered this group like exam results… everyone is now alert.",
  "😂 Somebody clap! @username has joined {groupName} without even paying entrance fee.",
  "🤣 @username is here! Hide the snacks before they ask for revision materials and tea.",
  "😂 Welcome @username, you joined at the right time… we were just about to become serious.",
  "😭😂 @username has joined. Now the group IQ has increased by 0.5 percent.",
  "🤣 Hey @username, I told them a legend was coming… they thought I was joking.",
  "😂 @username came in quietly like a student entering class after break time.",
  "🤣 Breaking news: @username has joined {groupName}. More updates after this welcome message.",
  "😂 Welcome @username, don’t fear. We only bite during exams.",
  "😭🤣 @username joined and suddenly the group looks more academic.",
  "😂 Hey @username, you finally found us. Google Maps must be proud.",
  "🤣 @username is here! Someone bring notes, assignments, and emotional support.",
  "😂 Welcome @username, this group is like school but with less punishment.",
  "🤣 Hey @username, you joined {groupName}. Your brain has officially accepted the terms and conditions.",
  "😂 @username has arrived. Please no noise, future scholar detected.",
  "😂 Hey @username, I told you people to come quickly and see who just joined… now look at you arriving late like a government project 😭🤣",
  "🤣 Hey @username, the group became quiet immediately you joined… these people fear new members more than exams 😭😂",
  "😂 Hey @username, welcome to {groupName}. Even the admin sat properly after seeing you join 😭🤣",
  "🤣 @username finally joined! Somebody hide unfinished assignments before questions start flying 😂😭",
  "😂 Hey @username, don’t worry… here we only judge people by how fast they send notes 😭🤣",
  "🤣 I told everyone a future billionaire was joining today… then @username entered carrying only vibes 😭😂",
  "😂 @username joined and suddenly everyone remembers they’re students again 😭🤣",
  "🤣 Hey @username, you entered this group like school WiFi… everybody suddenly became active 😭😂",
  "😂 @username just joined {groupName}. Attendance has officially improved 😭🤣",
  "🤣 Hey @username, welcome. The only requirement here is surviving exams and random stress 😂😭",
  "😂 I told these people to welcome @username nicely but they’re just staring like villagers seeing electricity for the first time 😭🤣",
  "🤣 @username joined and now the group looks expensive 😂😭",
  "😂 Hey @username, don’t panic. The confusion in this group is completely normal 😭🤣",
  "🤣 Welcome @username. Here we motivate each other academically… sometimes 😭😂",
  "😂 @username finally arrived. We almost reported you missing to Google Maps 😭🤣",
  "🤣 Hey @username, welcome to {groupName}. Your stress levels are now academically certified 😂😭",
  "😂 @username joined and immediately the group started pretending to be productive 😭🤣",
  "🤣 Welcome @username. Please ignore the chaos, even we don’t understand what happens here 😂😭",
  "😂 Hey @username, I told them a legend was coming but nobody believed me until now 😭🤣",
  "🤣 @username has entered the chat. Somebody bring tea and past papers immediately 😂😭",
  "😂 Welcome @username. In this group we cry, laugh, revise, and repeat 😭🤣",
  "🤣 Hey @username, congratulations. You have successfully upgraded your academic problems 😂😭",
  "😂 @username joined and now everybody is online like free bundles were announced 😭🤣",
  "🤣 Welcome @username. The pressure here is free of charge 😂😭",
  "😂 Hey @username, now that you’re here the group officially has one more future millionaire 😭🤣"
];

const GOODBYE_JOKES = [
  "😂 @username left the group… now who will view messages at 2AM without replying 😭🤣",
  "🤣 Breaking news: @username has escaped from {groupName}. Authorities are still investigating 😭😂",
  "😂 @username left quietly like a student sneaking out after assembly 😭🤣",
  "🤣 @username has left the group. Even the admin is pretending not to care 😂😭",
  "😂 One member down. The electricity bill in {groupName} has reduced 😭🤣",
  "🤣 @username left the group like bundles after opening TikTok 😭😂",
  "😂 @username disappeared faster than motivation during exams 😭🤣",
  "🤣 @username has left. Somebody check if the pressure became too much 😂😭",
  "😂 @username left {groupName}. Now who will ignore assignments professionally 😭🤣",
  "🤣 We tried to stop @username from leaving but the loading circle was faster 😭😂",
  "😂 @username left the group. Peace levels have increased by 2% 😭🤣",
  "🤣 @username escaped before seeing the next CAT timetable 😭😂",
  "😂 @username has left. Even WhatsApp asked 'are you sure?' 😭🤣",
  "🤣 Another soldier has fallen. Goodbye @username 😂😭",
  "😂 @username left like salary after paying rent 😭🤣",
  "🤣 @username has exited the chat. Group confusion remains unchanged 😂😭",
  "😂 @username left suddenly… even Google Maps lost track 😭🤣",
  "🤣 @username saw the academic pressure and said 'I’m fighting for my life' 😭😂",
  "😂 @username has left {groupName}. The drama department is now hiring 😭🤣",
  "🤣 We were about to become successful then @username left 😭😂",
  "😂 @username left the group like someone avoiding contribution money 😭🤣",
  "🤣 @username rage quit the group before exams could humble everyone 😭😂",
  "😂 @username has left. The remaining members will continue suffering together 😭🤣",
  "🤣 @username left so fast even the goodbye message arrived late 😭😂",
  "😂 @username left {groupName}. The vibes will never recover 😭🤣",
  "🤣 Looks like @username finally found peace outside this group 😂😭",
  "😂 @username left like a politician after making promises 😭🤣",
  "🤣 @username has departed. Thank you for using {groupName} airlines 😂😭",
  "😂 @username left without submitting an exit form 😭🤣",
  "🤣 @username has left the battlefield. Remaining students continue fighting 😭😂"
];

const WELCOME_MODE_LABELS = {
  funny_kenyan: 'Funny Kenyan Street',
  education: 'Learning / Education',
  warm: 'Warm Community',
  soft: 'Soft Polite',
  savage_light: 'Savage Light',
  premium: 'Premium / Professional'
};

const WELCOME_MODE_MENU =
`Choose welcome mode:

1. Funny Kenyan Street
2. Learning / Education
3. Warm Community
4. Soft Polite
5. Savage Light
6. Premium / Professional

Reply with the number or mode name.`;

const WELCOME_MODES = {
  funny_kenyan: [
    'Aki @username ameingia {groupName} kama mtu ako na story moto. Karibu bana!',
    '@username ameland. Sasa group imepata network full bars.',
    'Karibu @username. Usikae kimya sana, hapa silent readers wako na screenshots.',
    '@username ndio huyo! Watu waongeze volume, guest amefika.',
    '@username ameingia kama fare imefika M-Pesa. Mood imechange immediately.',
    'Karibu @username. Hapa ni vibes, jokes, na small small wisdom.',
    '@username welcome bana. Ukiona chaos, usishtuke, ni kawaida yetu.',
    '@username amejoin. Admin sasa anajifanya serious.',
    'Karibu sana @username. Hii group ni kama matatu, kila mtu ako na opinion.',
    '@username has entered the chat. Wacha sasa tuanze mambo.',
    '@username ameingia na pressure ya Monday morning.',
    'Welcome @username. Hapa ukichelewa kidogo utapata story imefika season 4.',
    '@username joined quietly, but sisi tumeona. Karibu sana!',
    '@username karibu {groupName}. Usilete drama mingi, kidogo tu ya entertainment.',
    '@username amefika. Wale wa screenshots muwe polite leo.',
    'Karibu @username. Hapa tunacheka kwanza, seriousness baadaye.',
    '@username ameingia group kama mtu amekuja kuchukua notes za maisha.',
    '@username karibu. Kama uko na tea, usiifiche.',
    '@username has joined. Group imepata new character development.',
    'Karibu @username. Feel at home, but usimalize oxygen ya group.',
    '@username ndio huyo. Hapa hakuna pressure, ni vibes na confusion kidogo.',
    '@username ameingia kama notification ya Fuliza.',
    'Welcome @username. Ukiwa lost, just smile and type haha.',
    '@username joined {groupName}. Hii entrance iko na confidence.',
    'Karibu @username. Umeingia group yenye watu wako na maoni kuliko politicians.',
    '@username amefika. Someone bring chai, hii ni visitor important.',
    '@username karibu sana. Hapa tunabonga English, Swahili, Sheng, na stress kidogo.',
    '@username ameingia kama mtu ako na breaking news.',
    'Welcome @username. Group imekuwa active ghafla kama bundles zimeongezwa.',
    '@username karibu. Hapa tunajua kucheka even when life inatuchezea.'
  ],
  education: [
    ...WELCOME_JOKES,
    'Welcome @username. Class has not started, but attendance already looks better.',
    '@username joined {groupName}. Future graduate detected.',
    'Karibu @username. Notes, revision, and small panic are served here daily.',
    '@username joined just in time before the assignment excuse expired.',
    'Welcome @username. Brain loading, please wait.',
    '@username has entered the study zone. Distractions are now under review.',
    'Karibu @username. May your marks rise and your stress reduce.',
    '@username joined. Someone pass the notes before they ask.',
    'Welcome @username. Here we revise seriously, after laughing kidogo.',
    '@username is here. Group average has increased, at least spiritually.',
    'Karibu @username. This is where confusion comes to be explained.',
    '@username joined like a scholar with unfinished assignments.',
    'Welcome @username. If you came for answers, sit near the front.',
    '@username has joined. Even the syllabus felt pressure.',
    'Karibu @username. May your memory cooperate during exams.'
  ],
  warm: [
    'Welcome @username. We are happy to have you here.',
    'Karibu @username. Feel at home in {groupName}.',
    '@username joined. Let us make them feel welcome.',
    'Welcome @username. Good people, good energy, good conversations.',
    'Karibu sana @username. You are among friends here.',
    '@username has joined {groupName}. The circle just got better.',
    'Welcome @username. We grow better when we grow together.',
    '@username is here. New voice, new energy, new connection.',
    'Karibu @username. May this group be useful and peaceful for you.',
    'Welcome @username. Join in when you feel ready.'
  ],
  soft: [
    'Welcome @username. We are pleased to have you here.',
    'Hello @username, welcome to {groupName}.',
    'Welcome @username. Kindly feel free to participate.',
    'Good to have you here, @username.',
    'Welcome @username. We hope this group is helpful to you.',
    'Hello @username. Please feel comfortable here.',
    'Welcome to {groupName}, @username.',
    '@username has joined. Welcome.',
    'Welcome @username. We appreciate your presence.',
    'Hello @username. Thank you for joining.'
  ],
  savage_light: [
    '@username joined. Let us see if they bring wisdom or just screenshots.',
    'Welcome @username. We hope your contribution is stronger than your WiFi.',
    '@username has entered. Group standards are currently under review.',
    'Karibu @username. Please do not reduce the average intelligence.',
    '@username joined with confidence. Evidence is still pending.',
    'Welcome @username. Behave first, impress us later.',
    '@username is here. Everybody act like this group is organized.',
    'Welcome @username. Your probation starts now.',
    '@username joined. Let us hope they read before asking questions.',
    'Karibu @username. Do not panic, we also do not know what is happening.'
  ],
  premium: [
    'Welcome @username to {groupName}. We are pleased to have you here.',
    '@username has joined. Welcome to the community.',
    'Welcome @username. We look forward to your participation.',
    'Hello @username. Thank you for joining {groupName}.',
    'Welcome @username. Please feel free to engage respectfully.',
    '@username is now part of {groupName}. Welcome aboard.',
    'Welcome @username. We are glad to have you with us.',
    'Hello @username. Kindly review the group description when available.',
    'Welcome @username. We value positive and respectful communication.',
    '@username joined successfully. Welcome.'
  ]
};

const GOODBYE_MODES = {
  funny_kenyan: [
    '@username ametoka {groupName} kama mtu ameona contribution message.',
    '@username amehepa. Hii group pressure ilimshika kidogo.',
    '@username has left. Safari salama kwa streets za WhatsApp.',
    '@username ametoka kimya kimya kama mtu wa deni.',
    '@username ameexit kama bundles zimeisha.',
    '@username left the group. Hata admin amebaki akijiuliza maswali.',
    '@username ametoka. Lakini screenshots zake zimebaki kwa history.',
    '@username ameenda kutafuta peace. Tumpe two minutes arudi.',
    'Farewell @username. Ukienda group ingine usiseme tulikustress.',
    '@username left like someone avoiding group work.',
    '@username ametoroka {groupName}. Mission successful.',
    '@username has left. Vibes zimepungua by 2%.',
    '@username ameondoka bila kuaga. Hii tabia tutajadili kesho.',
    '@username ametoka kama mtu ameona exam timetable.',
    'Goodbye @username. Ukipata group calm kuliko hii, tutumie location.',
    '@username has left. Hii ni character development.',
    '@username amehepa before story ifike climax.',
    '@username left quietly. Lakini bot iliona kila kitu.',
    '@username ameenda. Someone check kama ni network ama feelings.',
    '@username ametoka group kama loan app reminder imeingia.',
    'Farewell @username. May your next group have less noise and better admins.',
    '@username left. Sasa nani atakuwa silent reader wetu?',
    '@username ameexit. Group imebaki na wenyewe.',
    '@username has left {groupName}. Hii movie itaendelea bila yeye.',
    '@username ametoka kama mtu amechoka na notifications.',
    '@username left before admin aanze speech.',
    'Goodbye @username. Huku nje WhatsApp streets ni cold, vaa jacket.',
    '@username ameenda kutafuta inner peace. Tunamwish all the best.',
    '@username left. Labda storage ilikuwa inalia.',
    '@username has left. Tutaendelea na kikao bila yeye.'
  ],
  education: [
    ...GOODBYE_JOKES,
    '@username left the study group. The notes remain behind.',
    '@username has left before revision became serious.',
    '@username exited {groupName}. May their GPA stay strong.',
    '@username left like someone avoiding homework.',
    '@username has gone. Assignment pressure remains undefeated.',
    '@username left before the CAT timetable dropped.',
    '@username exited class quietly. Attendance updated.',
    'Farewell @username. May your exams be merciful.',
    '@username has left. The syllabus continues without fear.',
    '@username went offline from learning mode.',
    '@username escaped before group discussion started.',
    '@username left, but the notes are still watching.',
    'Goodbye @username. May success locate you quickly.',
    '@username left before the teacher entered.',
    '@username has exited the revision room.'
  ],
  warm: [
    '@username has left. We wish them well.',
    'Goodbye @username. Thank you for being part of {groupName}.',
    '@username left the group. May good things follow them.',
    'Farewell @username. You are always appreciated.',
    '@username has moved on. Wishing them peace and success.',
    'Goodbye @username. Your time here mattered.',
    '@username exited quietly. We send good energy with them.',
    'Farewell @username. Stay blessed out there.',
    '@username has left {groupName}. We wish them the best.',
    'Goodbye @username. May your next step be good.'
  ],
  soft: [
    '@username has left the group.',
    'Goodbye @username. We wish you well.',
    '@username has exited {groupName}.',
    'Farewell @username. Thank you for being here.',
    '@username has left. Best wishes.',
    'Goodbye @username. Take care.',
    '@username is no longer in the group.',
    'Farewell @username. Wishing you the best.',
    '@username has exited. Thank you.',
    'Goodbye @username. Stay well.'
  ],
  savage_light: [
    '@username left. The group survived.',
    '@username has exited. Peace increased by 1%.',
    '@username left before we could understand their purpose.',
    'Goodbye @username. Your silent reading career was appreciated.',
    '@username escaped. We will pretend we are okay.',
    '@username has left. The investigation is closed.',
    '@username left like they finally read the group rules.',
    'Farewell @username. You tried, maybe.',
    '@username exited. The group confusion remains.',
    '@username left before becoming useful. Painful.'
  ],
  premium: [
    '@username has left {groupName}. We wish them the best.',
    'Thank you @username for being part of the group.',
    '@username has exited. Best wishes moving forward.',
    'Farewell @username. We appreciate your time here.',
    '@username is no longer a member of {groupName}.',
    'Goodbye @username. Wishing you continued success.',
    '@username has left. Thank you for your participation.',
    'Farewell @username. We value the time you spent with us.',
    '@username exited the group. All the best.',
    'Goodbye @username. Stay well and keep progressing.'
  ]
};

function welcomeModeFromInput(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');
  const aliases = {
    '1': 'funny_kenyan',
    funny: 'funny_kenyan',
    funny_kenyan: 'funny_kenyan',
    kenyan: 'funny_kenyan',
    'funny kenyan': 'funny_kenyan',
    'funny kenyan street': 'funny_kenyan',
    'kenyan street': 'funny_kenyan',
    sheng: 'funny_kenyan',
    street: 'funny_kenyan',
    '2': 'education',
    learning: 'education',
    education: 'education',
    'learning education': 'education',
    school: 'education',
    study: 'education',
    '3': 'warm',
    warm: 'warm',
    'warm community': 'warm',
    community: 'warm',
    '4': 'soft',
    soft: 'soft',
    'soft polite': 'soft',
    polite: 'soft',
    '5': 'savage_light',
    savage: 'savage_light',
    savage_light: 'savage_light',
    'savage light': 'savage_light',
    light: 'savage_light',
    '6': 'premium',
    premium: 'premium',
    professional: 'premium',
    'premium professional': 'premium'
  };
  return aliases[clean] || null;
}

function selectedWelcomeTemplates(settings) {
  const mode = WELCOME_MODES[settings.welcomeMode] ? settings.welcomeMode : 'funny_kenyan';
  return WELCOME_MODES[mode] || WELCOME_MODES.funny_kenyan;
}

function selectedGoodbyeTemplates(settings) {
  const mode = GOODBYE_MODES[settings.goodbyeMode] ? settings.goodbyeMode : 'funny_kenyan';
  return GOODBYE_MODES[mode] || GOODBYE_MODES.funny_kenyan;
}

function saveWelcomeModeSelection(settings, selectedMode) {
  settings.welcomeOn = true;
  settings.goodbyeOn = true;
  settings.welcomeMode = selectedMode;
  settings.goodbyeMode = selectedMode;
  settings.pendingWelcomeModeSetup = null;
  save(MEMORY_FILE, memory);
}

function welcomeModeConfirmation(selectedMode) {
  return `Welcome mode set to ${WELCOME_MODE_LABELS[selectedMode]}.\nGoodbye mode has also been set to ${WELCOME_MODE_LABELS[selectedMode]} automatically.`;
}

function isWelcomeModePromptText(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('choose welcome mode') || text.includes('please reply with a valid number or mode name');
}

function clearExpiredWelcomeModeSetup(settings) {
  const pending = settings && settings.pendingWelcomeModeSetup;
  if (!pending) return false;
  if (pending.at && Date.now() - pending.at <= WELCOME_MODE_SETUP_TIMEOUT_MS) return false;
  settings.pendingWelcomeModeSetup = null;
  save(MEMORY_FILE, memory);
  return true;
}

function canCompleteWelcomeModeSetup(msg, groupId, settings, sender) {
  if (clearExpiredWelcomeModeSetup(settings)) return false;
  return Boolean(
    settings &&
    settings.pendingWelcomeModeSetup &&
    (settings.pendingWelcomeModeSetup.by === sender || canUseGroupAdminCommands(msg, groupId))
  );
}

function hostingPromoText() {
  return `\n\n${HOSTING_PROMO}`;
}

function user(id) {
  if (!memory.users) memory.users = {};
  if (!memory.users[id]) memory.users[id] = { nickname: null };
  return memory.users[id];
}

function group(id) {
  if (!memory.groups) memory.groups = {};
  if (!memory.groups[id]) {
    memory.groups[id] = {
      chatbot: false,
      autoreply: false,
      customReplies: [],
      mood: 'normal',
      antilink: false,
      antimention: false,
      antimentionLimit: 5,
      antisale: false,
      antiforeign: false,
      antispam: false,
      spamLimit: 5,
      spamSeconds: 7,
      antibadword: false,
      badwords: [...DEFAULT_BADWORDS],
      antifake: false,
      allowedPrefix: '254',
      antiviewonce: false,
      antiforward: false,
      antisticker: false,
      antimedia: false,
      antidocument: false,
      antidelete: false,
      welcomeOn: true,
      goodbyeOn: true,
      welcomeMode: 'funny_kenyan',
      goodbyeMode: 'funny_kenyan',
      pendingWelcomeModeSetup: null,
      welcome: null,
      goodbye: null,
      bye: null,
      warnLimit: 3,
      muted: {}
    };
  }

  const g = memory.groups[id];
  if (!Array.isArray(g.customReplies)) g.customReplies = [];
  if (!g.mood) g.mood = 'normal';
  if (!g.antimentionLimit) g.antimentionLimit = 5;
  if (!g.spamLimit) g.spamLimit = 5;
  if (!g.spamSeconds) g.spamSeconds = 7;
  if (!Array.isArray(g.badwords)) g.badwords = [];
  g.badwords = [...new Set(g.badwords.map(word => String(word || '').trim().toLowerCase()).filter(Boolean))];
  if (!g.badwords.length) g.badwords = [...DEFAULT_BADWORDS];
  if (Number(g.badwordsVersion || 0) < BADWORDS_VERSION) {
    g.badwords = [...new Set([...g.badwords, ...DEFAULT_BADWORDS])];
    g.badwordsVersion = BADWORDS_VERSION;
  }
  if (!g.allowedPrefix) g.allowedPrefix = '254';
  if (typeof g.welcomeOn !== 'boolean') g.welcomeOn = true;
  if (typeof g.goodbyeOn !== 'boolean') g.goodbyeOn = true;
  if (!WELCOME_MODES[g.welcomeMode]) g.welcomeMode = 'funny_kenyan';
  if (!GOODBYE_MODES[g.goodbyeMode]) g.goodbyeMode = g.welcomeMode || 'funny_kenyan';
  if (g.pendingWelcomeModeSetup && typeof g.pendingWelcomeModeSetup !== 'object') g.pendingWelcomeModeSetup = null;
  if (!g.goodbye && g.bye) g.goodbye = g.bye;
  if (!g.warnLimit) g.warnLimit = 3;
  if (!g.muted) g.muted = {};
  if (typeof g.lastWelcomeJoke !== 'string') g.lastWelcomeJoke = null;
  if (typeof g.lastGoodbyeJoke !== 'string') g.lastGoodbyeJoke = null;
  return g;
}

function sessionSettings(name) {
  if (!memory.sessions) memory.sessions = {};
  if (!memory.sessions[name]) {
    memory.sessions[name] = {
      pm: name === 'main' && typeof memory.pm === 'boolean' ? memory.pm : false,
      mood: 'normal',
      away: false,
      smart: false,
      typing: false,
      autoreact: false,
      autoreactEmoji: '💗',
      statusview: false,
      statuslike: false,
      ghostStatus: false,
      ghostStatusIntervalMs: DEFAULT_GHOST_STATUS_INTERVAL_MS,
      ghostLastSeenMode: 'off',
      ghostLastSeenOffsetMs: 0,
      ghostLastSeenText: null,
      antideleteInbox: false,
      statusReact: '💗',
      online: false,
      autostatus: false,
      statusText: 'Githinji Bot online',
      persona: null,
      createdAt: Date.now(),
      leaseStartedAt: null,
      leaseExpiresAt: null,
      leaseMs: null,
      leaseDays: null,
      leasePaused: false,
      botId: null
    };
    save(MEMORY_FILE, memory);
  }

  if (!memory.sessions[name].mood) memory.sessions[name].mood = 'normal';
  if (!memory.sessions[name].autoreactEmoji) memory.sessions[name].autoreactEmoji = '💗';
  if (!memory.sessions[name].statusReact) memory.sessions[name].statusReact = '💗';
  if (typeof memory.sessions[name].ghostStatus !== 'boolean') memory.sessions[name].ghostStatus = false;
  if (!Number.isFinite(Number(memory.sessions[name].ghostStatusIntervalMs))) {
    memory.sessions[name].ghostStatusIntervalMs = DEFAULT_GHOST_STATUS_INTERVAL_MS;
  }
  memory.sessions[name].ghostStatusIntervalMs = Math.max(
    MIN_GHOST_STATUS_INTERVAL_MS,
    Number(memory.sessions[name].ghostStatusIntervalMs)
  );
  if (!memory.sessions[name].ghostLastSeenMode) memory.sessions[name].ghostLastSeenMode = 'off';
  if (!Number.isFinite(Number(memory.sessions[name].ghostLastSeenOffsetMs))) memory.sessions[name].ghostLastSeenOffsetMs = 0;
  if (typeof memory.sessions[name].antideleteInbox !== 'boolean') memory.sessions[name].antideleteInbox = false;
  if (!memory.sessions[name].createdAt) memory.sessions[name].createdAt = Date.now();
  return memory.sessions[name];
}

function normalizeNumber(raw) {
  const number = String(raw || '').replace(/\D/g, '');
  return number ? `${number}@c.us` : null;
}

function firstMention(msg) {
  return msg.mentionedIds && msg.mentionedIds.length ? msg.mentionedIds[0] : null;
}

function uniqueIds(ids) {
  return [...new Set(ids.filter(Boolean))];
}

function sessionName(raw) {
  return String(raw || '').trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
}

async function requestSessionPairingCode(name, phone) {
  if (pairingRequests[name]) {
    throw new Error(`A pairing request for ${name} is already running. Wait a few seconds and try again.`);
  }

  pairingRequests[name] = true;
  try {
    let lastError = null;
    for (let cycle = 0; cycle < 2; cycle++) {
      const targetClient = await waitForPairingClient(name, cycle > 0);
      if (!targetClient || typeof targetClient.requestPairingCode !== 'function') {
        lastError = new Error('Pairing is not supported by this WhatsApp Web client.');
        break;
      }

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await targetClient.requestPairingCode(phone);
        } catch (e) {
          lastError = e;
          if (isTargetClosedError(e)) break;
          await sleep(3000);
        }
      }

      if (!isTargetClosedError(lastError)) break;
      await restartSessionForPairing(name, lastError.message);
    }

    throw lastError || new Error('Pairing page was not ready.');
  } finally {
    delete pairingRequests[name];
  }
}

async function waitForPairingClient(name, forceRestart = false) {
  if (forceRestart || !clients[name]) {
    if (forceRestart) await restartSessionForPairing(name, 'fresh pairing attempt');
    else start(name);
  }

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const targetClient = clients[name];
    if (targetClient && typeof targetClient.requestPairingCode === 'function') {
      const page = targetClient.pupPage;
      const pageClosed = page && typeof page.isClosed === 'function' && page.isClosed();
      if (!pageClosed && (lastSessionQr[name] || page)) return targetClient;
    }
    await sleep(2000);
  }

  return clients[name];
}

async function restartSessionForPairing(name, reason) {
  clearSessionRestart(name);
  const current = clients[name];
  if (current) {
    await current.destroy().catch(e => logLine(`[${name}] pairing restart cleanup failed: ${e.message}`));
    delete clients[name];
  }
  logLine(`[${name}] restarting session for pairing: ${reason || 'pairing retry'}`);
  await sleep(2000);
  return start(name);
}

function isTargetClosedError(error) {
  const message = String((error && error.message) || error || '').toLowerCase();
  return message.includes('target closed') || message.includes('session closed');
}

function ownerIdFromInput(msg, rawValue) {
  const mentioned = firstMention(msg);
  if (mentioned) return mentioned;
  return normalizeNumber(rawValue);
}

function sessionLeaseStats(name) {
  const session = memory.sessions && memory.sessions[name];
  if (!session) return null;

  const now = Date.now();
  const startedAt = Number(session.leaseStartedAt || session.createdAt || now);
  const expiresAt = Number(session.leaseExpiresAt || 0);
  const totalMs = Number(session.leaseMs || (session.leaseDays ? Number(session.leaseDays) * DAY_MS : 0) || (expiresAt ? Math.max(0, expiresAt - startedAt) : 0));
  const totalDays = Math.ceil(totalMs / DAY_MS);
  const connectedDays = Math.max(0, Math.floor((now - startedAt) / DAY_MS));
  const remainingMs = expiresAt ? Math.max(0, expiresAt - now) : null;
  const remainingDays = remainingMs === null ? null : Math.ceil(remainingMs / DAY_MS);
  const paused = Boolean(session.leasePaused);
  const expired = Boolean(expiresAt && expiresAt <= now);

  return {
    startedAt,
    expiresAt,
    totalMs,
    totalDays,
    connectedDays,
    remainingMs,
    remainingDays,
    paused,
    expired,
    blocked: paused || expired,
    unlimited: !expiresAt && !paused
  };
}

function formatDurationMs(ms) {
  const value = Math.max(0, Number(ms || 0));
  if (value <= 0) return '0 hours';
  if (value >= DAY_MS) {
    const days = Math.ceil(value / DAY_MS);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  const hours = Math.max(1, Math.ceil(value / HOUR_MS));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function sessionLeaseLine(name) {
  const stats = sessionLeaseStats(name);
  if (!stats) return `${name}: missing`;
  if (stats.paused) return `${name}: paused`;
  if (stats.unlimited) return `${name}: unlimited`;
  return `${name}: ${formatDurationMs(stats.remainingMs)} left, connected ${stats.connectedDays} day${stats.connectedDays === 1 ? '' : 's'} (${stats.expired ? 'expired' : 'active'})`;
}

function sessionPlanLabel(name) {
  const stats = sessionLeaseStats(name);
  if (!stats) return 'unknown plan';
  if (stats.paused) return 'paused';
  if (stats.unlimited) return 'unlimited premium';
  return `${formatDurationMs(stats.totalMs)} premium`;
}

function sessionWelcomeText(displayName, name) {
  return `Hurray ${displayName}, you are premium now!

Subscription: ${sessionPlanLabel(name)}

Enjoy Githinji Bot. Use .menu to see commands.`;
}

function subscriptionExpiredText(senderId, status = 'Expired') {
  return `⚠️ SUBSCRIPTION ${status.toUpperCase()}

Hello ${tag(senderId)}, your bot subscription has ended.

Your access to premium bot features has now been paused. To continue enjoying commands, automation, group protection, downloads, AI replies, and other active services, please renew your subscription.

Kindly contact the bot owner/admin to renew and reactivate your access.

⏳ Status: ${status}
🔒 Access: Paused
✅ Renew to continue using the bot.`;
}

function planReminderText(name, stats, threshold) {
  const remaining = threshold ? threshold.label : formatDurationMs(stats.remainingMs);
  return `Githinji Bot subscription reminder\n\n` +
    `Session: ${name}\n` +
    `Remaining: ${remaining}\n\n` +
    `Please renew before it ends to avoid interruption.`;
}

function resetLeaseReminders(session) {
  session.leaseRemindersSent = {};
}

async function sendPlanReminder(client, name, key, threshold, stats) {
  const session = sessionSettings(name);
  if (!session.botId) return;
  if (!session.leaseRemindersSent || Array.isArray(session.leaseRemindersSent)) session.leaseRemindersSent = {};
  if (session.leaseRemindersSent[key]) return;

  await client.sendMessage(session.botId, planReminderText(name, stats, threshold));
  session.leaseRemindersSent[key] = Date.now();
  save(MEMORY_FILE, memory);
}

async function checkPlanReminders(client, name) {
  const stats = sessionLeaseStats(name);
  if (!stats || stats.unlimited || stats.paused || !stats.expiresAt) return;

  if (stats.expired) {
    return sendPlanReminder(client, name, 'expired', null, stats);
  }

  for (const threshold of [...PLAN_REMINDER_THRESHOLDS].reverse()) {
    if (stats.remainingMs <= threshold.ms) {
      return sendPlanReminder(client, name, threshold.key, threshold, stats);
    }
  }
}

function startPlanReminderLoop(client, name) {
  if (planReminderIntervals[name]) return;
  checkPlanReminders(client, name).catch(e => logLine(`Plan reminder check failed (${name}): ${e.message}`));
  planReminderIntervals[name] = setInterval(() => {
    checkPlanReminders(client, name).catch(e => logLine(`Plan reminder check failed (${name}): ${e.message}`));
  }, PLAN_REMINDER_INTERVAL_MS);
}

function parsePlanDays(rawPlan) {
  const plan = String(rawPlan || '').trim().toLowerCase();
  if (!plan) return { days: null, unlimited: false, label: '' };
  if (['unlimited', 'forever', 'lifetime', 'permanent'].includes(plan)) {
    return { ms: null, days: null, unlimited: true, label: 'unlimited' };
  }

  const match = plan.match(/^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days|w|week|weeks|m|mo|month|months|y|year|years)?$/);
  if (!match) return { days: null, unlimited: false, label: plan };

  const amount = Number(match[1]);
  const unit = match[2] || 'd';
  const multipliers = {
    h: HOUR_MS,
    hr: HOUR_MS,
    hrs: HOUR_MS,
    hour: HOUR_MS,
    hours: HOUR_MS,
    d: DAY_MS,
    day: DAY_MS,
    days: DAY_MS,
    w: WEEK_MS,
    week: WEEK_MS,
    weeks: WEEK_MS,
    m: MONTH_MS,
    mo: MONTH_MS,
    month: MONTH_MS,
    months: MONTH_MS,
    y: 365 * DAY_MS,
    year: 365 * DAY_MS,
    years: 365 * DAY_MS
  };
  const displayUnits = {
    h: 'h',
    hr: 'h',
    hrs: 'h',
    hour: 'h',
    hours: 'h',
    d: 'd',
    day: 'd',
    days: 'd',
    w: 'w',
    week: 'w',
    weeks: 'w',
    m: 'm',
    mo: 'm',
    month: 'm',
    months: 'm',
    y: 'y',
    year: 'y',
    years: 'y'
  };
  const ms = amount * (multipliers[unit] || DAY_MS);

  return {
    ms,
    days: Math.ceil(ms / DAY_MS),
    unlimited: false,
    label: `${amount}${displayUnits[unit] || 'd'}`
  };
}

function parseSessionLeaseInput(rawValue) {
  const parts = String(rawValue || '').trim().split(/\s+/).filter(Boolean);
  const name = sessionName(parts[0]);
  const plan = parsePlanDays(parts[1]);
  if (!name) return null;
  return {
    name,
    durationMs: Number.isInteger(plan.ms) && plan.ms > 0 ? plan.ms : null,
    days: Number.isInteger(plan.days) && plan.days > 0 ? plan.days : null,
    unlimited: plan.unlimited,
    planLabel: plan.label
  };
}

function parseSessionDuration(rawValue) {
  const plan = parsePlanDays(rawValue);
  return {
    durationMs: Number.isInteger(plan.ms) && plan.ms > 0 ? plan.ms : null,
    days: Number.isInteger(plan.days) && plan.days > 0 ? plan.days : null,
    planLabel: plan.label
  };
}

function linkedCustomerSessions() {
  return sessions.sessions
    .filter(sessionNameItem => sessionNameItem !== 'main')
    .map(sessionNameItem => [sessionNameItem, sessionSettings(sessionNameItem)])
    .filter(([, item]) => Boolean(item && item.botId));
}

function extendSessionDuration(session, durationMs, days) {
  const now = Date.now();
  const baseExpiry = Math.max(Number(session.leaseExpiresAt || now), now);
  session.leaseStartedAt = session.leaseStartedAt || now;
  session.leaseExpiresAt = baseExpiry + durationMs;
  session.leaseMs = Number(session.leaseMs || 0) + durationMs;
  session.leaseDays = Number(session.leaseDays || 0) + days;
  session.leasePaused = false;
  session.updatedAt = now;
  resetLeaseReminders(session);
}

function safeFileName(name) {
  return String(name || 'song')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'song';
}

function saleKeywordDetected(text) {
  const clean = String(text || '').toLowerCase();
  return SALE_KEYWORDS.find(keyword => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (keyword.includes(' ') || keyword.includes('-')) return clean.includes(keyword);
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(clean);
  }) || null;
}

function antisaleDetailWarning(displayName, keyword, targetId) {
  return `🚫 *STRICT WARNING — DEALING WITHOUT ADMIN APPROVAL IS NOT ALLOWED*

${tag(targetId)} (${displayName})

Your message looks like buying, selling, swapping, payment, delivery, account trading, or any form of deal inside this group.

No mercy on scams here.

Before any deal continues, you MUST involve a group admin as escrow or witness. Do not send money, goods, login details, account access, codes, screenshots, or private information without admin approval.

Anyone trying to trade secretly, rush payments, avoid admins, or move deals to inbox will be treated as suspicious and may be removed from the group without warning.

✅ Deals are allowed ONLY when admins approve.
❌ No admin approval = No deal.
⚠️ Ignore this warning at your own risk.`;
}

function antibadwordWarning(displayName, word, targetId) {
  return `*Anti-Badword Warning*

${tag(targetId)} (${displayName})

That message contains a blocked word: ${word}

Keep the group respectful. Insults, harassment, abusive language, and vulgar words are not allowed here.`;
}

function badwordDetected(g, text) {
  const body = String(text || '').toLowerCase();
  const words = [...new Set([...(g.badwords || []), ...DEFAULT_BADWORDS])];
  return words.find(word => {
    const cleanWord = String(word || '').trim().toLowerCase();
    if (!cleanWord) return false;
    const escaped = cleanWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (cleanWord.includes(' ') || cleanWord.includes("'")) return body.includes(cleanWord);
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(body);
  });
}

function isKenyanNumber(id) {
  return String(id || '').replace(/\D/g, '').startsWith('254');
}

function parseDuration(value) {
  const match = String(value || '').trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return amount * multipliers[unit];
}

function formatDurationShort(ms) {
  const value = Number(ms || 0);
  if (value % DAY_MS === 0) return `${value / DAY_MS}d`;
  if (value % HOUR_MS === 0) return `${value / HOUR_MS}h`;
  if (value % 60000 === 0) return `${value / 60000}m`;
  return `${Math.round(value / 1000)}s`;
}

function formatLocalDateTime(ms) {
  return new Date(ms).toLocaleString('en-KE', {
    timeZone: SCHEDULE_TIMEZONE_LABEL,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function statusSenderId(msg) {
  return (
    msg.author ||
    (msg._data && (
      msg._data.author ||
      msg._data.participant ||
      msg._data.sender ||
      (msg._data.id && (msg._data.id.participant || msg._data.id.remote || msg._data.id.fromMe))
    )) ||
    activeSenderId(msg) ||
    'status@broadcast'
  );
}

function phoneLabel(id) {
  const raw = String(id || '');
  if (raw.endsWith('@lid')) return 'phone hidden by WhatsApp';
  const cleaned = canCleanAsPhoneId(raw) ? cleanPhoneId(raw) : null;
  const number = cleaned ? cleaned.replace('@c.us', '') : '';
  return number ? `+${number}` : safeChatIdLabel(raw);
}

function canCleanAsPhoneId(value) {
  const raw = String(value || '').trim();
  return Boolean(raw && (!raw.includes('@') || raw.endsWith('@c.us') || raw.endsWith('@s.whatsapp.net')));
}

function safeChatIdLabel(id) {
  const raw = String(id || '').trim();
  if (!raw) return 'unknown sender';
  if (raw === 'status@broadcast') return 'status broadcast';
  if (raw.endsWith('@newsletter')) {
    const channelId = raw.replace('@newsletter', '').replace(/\D/g, '');
    return channelId ? `newsletter channel ${channelId}` : 'newsletter channel';
  }
  if (raw.endsWith('@lid')) return 'phone hidden by WhatsApp';
  if (raw.endsWith('@g.us')) return 'group chat';
  return 'unknown sender';
}

async function realPhoneIdFor(client, id) {
  if (!id) return null;

  const directContact = await contactFor(client, id);
  const directNumber = contactNumberId(directContact);
  if (directNumber) return directNumber;

  const lidNumber = await lidPhoneId(client, id);
  if (lidNumber) return lidNumber;

  if (String(id).endsWith('@lid')) return null;
  if (!canCleanAsPhoneId(id)) return null;
  return cleanPhoneId(id);
}

async function identityLabelFor(client, id, options = {}) {
  const realPhoneId = await realPhoneIdFor(client, id);
  const candidates = [...new Set([id, realPhoneId].filter(Boolean))];
  let profileName = null;

  for (const candidate of candidates) {
    const contact = await client.getContactById(candidate).catch(() => null);
    if (!contact) continue;
    const savedName = contact.name || contact.shortName || contact.verifiedName;
    profileName = profileName || contact.pushname;
    const number = (realPhoneId || contactNumberId(contact) || '').replace('@c.us', '');
    if (savedName && options.includePhoneForSaved && number) return `${savedName} (+${number})`;
    if (savedName) return savedName;
    if (number && profileName) return `${profileName} (+${number})`;
    if (number) return `+${number}`;
    if (profileName) return profileName;
  }

  const phone = phoneLabel(realPhoneId || id);
  return profileName ? `${profileName} (${phone})` : phone;
}

function rememberStatusMessage(msg) {
  if (msg.from !== 'status@broadcast' && msg.to !== 'status@broadcast') return;
  const id = msg.id && msg.id._serialized;
  if (!id) return;

  statusMessageCache[id] = {
    id,
    msg,
    sender: statusSenderId(msg),
    hasMedia: Boolean(msg.hasMedia),
    type: msg.type || 'status',
    at: Date.now()
  };

  const keys = Object.keys(statusMessageCache);
  while (keys.length > MAX_STATUS_CACHE) {
    delete statusMessageCache[keys.shift()];
  }
}

function latestStatusEntry(target = null) {
  const wanted = target ? cleanPhoneId(target) : null;
  return Object.values(statusMessageCache)
    .filter(entry => entry && entry.hasMedia && (!wanted || cleanPhoneId(entry.sender) === wanted))
    .sort((a, b) => b.at - a.at)[0] || null;
}

function ghostLastSeenText(session) {
  if (!session || session.ghostLastSeenMode === 'off') return null;
  const at = session.ghostLastSeenMode === 'now'
    ? Date.now()
    : Date.now() + Number(session.ghostLastSeenOffsetMs || 0);
  return `Ghost last seen: ${formatLocalDateTime(at)}`;
}

async function applyGhostLastSeenStatus(client, session, sessionNameValue) {
  const text = ghostLastSeenText(session);
  if (!text) return;
  session.ghostLastSeenText = text;
  await client.setStatus(text).catch(e => {
    logLine(`Ghost last-seen status failed (${sessionNameValue}): ${e.message}`);
  });
}

function stopGhostStatusLoop(name) {
  if (!ghostStatusIntervals[name]) return;
  clearInterval(ghostStatusIntervals[name]);
  delete ghostStatusIntervals[name];
}

async function runGhostStatusView(client, name) {
  const session = sessionSettings(name);
  if (!session.ghostStatus) return;
  if (client.sendSeen) {
    await client.sendSeen('status@broadcast').catch(e => {
      logLine(`Ghost status view failed (${name}): ${e.message}`);
    });
  }
  logLine(`[${name}] ghost status view cycle ran`);
}

function startGhostStatusLoop(client, name) {
  stopGhostStatusLoop(name);
  const session = sessionSettings(name);
  if (!session.ghostStatus) return;
  const intervalMs = Math.max(MIN_GHOST_STATUS_INTERVAL_MS, Number(session.ghostStatusIntervalMs || DEFAULT_GHOST_STATUS_INTERVAL_MS));
  ghostStatusIntervals[name] = setInterval(() => {
    runGhostStatusView(client, name).catch(e => logLine(`Ghost status loop failed (${name}): ${e.message}`));
  }, intervalMs);
  runGhostStatusView(client, name).catch(e => logLine(`Ghost status first run failed (${name}): ${e.message}`));
}

async function saveStatusMediaForCommand(client, msg, raw) {
  let source = null;
  if (msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage().catch(() => null);
    if (quoted && (quoted.from === 'status@broadcast' || quoted.to === 'status@broadcast' || quoted.hasMedia)) {
      source = quoted;
    }
  }

  if (!source) {
    const arg = raw.replace(/^(\.savestatus|\.save\s+status)\s*/i, '').trim();
    const entry = latestStatusEntry(arg || null);
    source = entry && entry.msg;
  }

  if (!source || !source.hasMedia) {
    return msg.reply('No status media found yet. Reply to a status with .savestatus, or wait until the bot sees a media status.');
  }

  const media = await source.downloadMedia().catch(e => {
    logLine(`Save status download failed: ${e.message}`);
    return null;
  });
  if (!media) return msg.reply('I could not download that status media. It may have expired or WhatsApp blocked it.');

  const sourceId = source.id && source.id._serialized;
  const cachedStatus = sourceId ? statusMessageCache[sourceId] : null;
  const ownerId = cachedStatus ? cachedStatus.sender : statusSenderId(source);
  const owner = await identityLabelFor(client, ownerId, { includePhoneForSaved: true });
  media.filename = media.filename || `status-${Date.now()}.${mediaExt(media)}`;
  return msg.reply(media, undefined, { caption: `Saved status from ${owner}` });
}

async function displayNameFor(client, id) {
  const contact = await client.getContactById(id).catch(() => null);
  if (!contact) return tag(id);
  return contact.pushname || contact.name || contact.shortName || contact.verifiedName || tag(id);
}

async function contactFor(client, id) {
  return client.getContactById(id).catch(() => null);
}

function cleanPhoneId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const id = raw
    .replace('@s.whatsapp.net', '@c.us')
    .replace('@lid', '');
  const number = id.replace('@c.us', '').replace(/\D/g, '');
  return number ? `${number}@c.us` : null;
}

function contactNumberId(contact) {
  if (!contact) return null;

  const id = contact.id && contact.id._serialized;
  if (isContactId(id)) return id;

  const phoneId = cleanPhoneId(contact.number);
  if (phoneId && !String(id || '').endsWith('@lid')) return phoneId;

  return null;
}

async function lidPhoneId(client, id) {
  if (!id || !String(id).endsWith('@lid') || typeof client.getContactLidAndPhone !== 'function') return null;

  const pairs = await client.getContactLidAndPhone([id]).catch(() => null);
  const match = Array.isArray(pairs)
    ? pairs.find(item => item && (item.lid === id || item.pn))
    : null;

  return cleanPhoneId(match && match.pn);
}

async function senderLogId(client, msg, fallbackId) {
  const directContact = typeof msg.getContact === 'function'
    ? await msg.getContact().catch(() => null)
    : null;
  const directNumber = contactNumberId(directContact);
  if (directNumber) return phoneLabel(directNumber);

  const lidNumber = await lidPhoneId(client, fallbackId);
  if (lidNumber) return phoneLabel(lidNumber);

  const lookupContact = await contactFor(client, fallbackId);
  const lookupNumber = contactNumberId(lookupContact);
  return lookupNumber ? phoneLabel(lookupNumber) : safeChatIdLabel(fallbackId);
}

function isContactId(id) {
  return /^\d+@c\.us$/.test(String(id || ''));
}

function savedContactList() {
  return Object.values(memory.savedContacts || {}).filter(item => item && isContactId(item.id));
}

function inviteHistoryFor(groupId) {
  if (!memory.inviteHistory || Array.isArray(memory.inviteHistory)) memory.inviteHistory = {};
  if (!memory.inviteHistory[groupId]) memory.inviteHistory[groupId] = {};
  return memory.inviteHistory[groupId];
}

function inviteHistoryLine(entry) {
  if (!entry || !entry.lastAt) return null;
  const action = entry.status || 'attempted';
  const agoMs = Date.now() - Number(entry.lastAt || 0);
  return `${action} ${formatDurationMs(agoMs)} ago`;
}

function parseInviteLimit(text) {
  if (text === '.inviteall') return INVITE_DEFAULT_LIMIT;
  const match = String(text || '').match(/^\.invite(?:\s+(\d+))?$/);
  if (!match) return null;
  const requested = Number(match[1] || INVITE_DEFAULT_LIMIT);
  if (!Number.isFinite(requested) || requested <= 0) return INVITE_DEFAULT_LIMIT;
  return Math.min(Math.floor(requested), INVITE_MAX_PER_RUN);
}

function inviteCandidateList(chat, limit) {
  const groupId = chat.id && chat.id._serialized;
  const now = Date.now();
  const history = inviteHistoryFor(groupId);
  const existingMembers = new Set((chat.participants || []).map(p => p.id && p.id._serialized).filter(Boolean));
  const ownerSet = new Set([ownerlock.primaryOwner, ...ownerlock.owners].filter(Boolean));
  const candidates = [];
  let cooledDown = 0;
  let alreadyInGroup = 0;
  let optedOut = 0;

  for (const item of savedContactList()) {
    if (ownerSet.has(item.id)) continue;
    if (existingMembers.has(item.id)) {
      alreadyInGroup += 1;
      continue;
    }
    if (memory.inviteOptIns && memory.inviteOptIns[item.id] && memory.inviteOptIns[item.id].blocked) {
      optedOut += 1;
      continue;
    }

    const previous = history[item.id];
    if (previous && previous.lastAt && now - Number(previous.lastAt) < INVITE_COOLDOWN_MS) {
      cooledDown += 1;
      continue;
    }

    candidates.push(item);
  }

  return {
    selected: candidates.slice(0, limit),
    eligible: candidates.length,
    cooledDown,
    alreadyInGroup,
    optedOut,
    totalSaved: savedContactList().length
  };
}

async function tryAddParticipantBatch(chat, ids) {
  try {
    const result = await chat.addParticipants(ids);
    if (!result || typeof result !== 'object') {
      return ids.map(id => ({ id, added: true }));
    }

    return ids.map(id => {
      const value = result[id] || result[id.replace('@c.us', '')];
      if (!value) return { id, added: true };
      const code = Number(value.code || value.status || 0);
      return { id, added: code >= 200 && code < 300, code, message: value.message || value.error || '' };
    });
  } catch (e) {
    return ids.map(id => ({ id, added: false, message: e.message }));
  }
}

async function sendInviteLink(client, item, inviteLink, groupName) {
  await client.sendMessage(
    item.id,
    `Hi ${item.name || 'there'}, you are invited to join ${groupName || 'this group'}:\n${inviteLink}`
  );
}

async function runInviteFlow(client, msg, limit) {
  if (!(await requireGroupAdmin(msg))) return;

  const chat = await msg.getChat();
  if (!(await botIsAdmin(client, chat))) {
    return msg.reply('Make the bot a group admin first so it can add people or fetch the invite link.');
  }

  const groupId = chat.id && chat.id._serialized;
  const history = inviteHistoryFor(groupId);
  const code = await chat.getInviteCode();
  const inviteLink = `https://chat.whatsapp.com/${code}`;
  const candidateInfo = inviteCandidateList(chat, limit);
  const selected = candidateInfo.selected;

  if (!selected.length) {
    return msg.reply(
      `No eligible saved contacts right now.\n` +
      `Saved: ${candidateInfo.totalSaved}\n` +
      `Already in group: ${candidateInfo.alreadyInGroup}\n` +
      `Cooling down: ${candidateInfo.cooledDown}\n` +
      `Opted out: ${candidateInfo.optedOut}`
    );
  }

  await msg.reply(
    `Invite run started for ${selected.length}/${candidateInfo.eligible} eligible contacts.\n` +
    `Direct add batch: ${INVITE_DIRECT_BATCH_SIZE}\n` +
    `Add delay: ${Math.round(INVITE_DIRECT_BATCH_DELAY_MS / 1000)}s\n` +
    `Invite link fallback delay: ${Math.round(INVITE_DM_DELAY_MS / 1000)}s\n` +
    `Cooldown: ${Math.round(INVITE_COOLDOWN_MS / HOUR_MS)} hours`
  );

  let added = 0;
  let linked = 0;
  let failed = 0;
  const fallback = [];

  for (let i = 0; i < selected.length; i += INVITE_DIRECT_BATCH_SIZE) {
    const batch = selected.slice(i, i + INVITE_DIRECT_BATCH_SIZE);
    const outcomes = await tryAddParticipantBatch(chat, batch.map(item => item.id));

    for (const outcome of outcomes) {
      const item = batch.find(candidate => candidate.id === outcome.id);
      if (!item) continue;
      if (outcome.added) {
        added += 1;
        history[item.id] = { status: 'added', lastAt: Date.now() };
      } else {
        fallback.push(item);
      }
    }

    save(MEMORY_FILE, memory);
    if (i + INVITE_DIRECT_BATCH_SIZE < selected.length) await sleep(INVITE_DIRECT_BATCH_DELAY_MS);
  }

  for (const item of fallback) {
    try {
      await sendInviteLink(client, item, inviteLink, chat.name);
      linked += 1;
      history[item.id] = { status: 'link-sent', lastAt: Date.now() };
    } catch (e) {
      failed += 1;
      history[item.id] = { status: 'failed', lastAt: Date.now(), error: e.message };
    }

    save(MEMORY_FILE, memory);
    await sleep(INVITE_DM_DELAY_MS);
  }

  return msg.reply(
    `Invite run finished.\n` +
    `Added directly: ${added}\n` +
    `Sent invite link: ${linked}\n` +
    `Failed: ${failed}\n` +
    `Cooling skipped before run: ${candidateInfo.cooledDown}`
  );
}

async function saveGroupContacts(client, chat) {
  if (!memory.savedContacts) memory.savedContacts = {};

  let added = 0;
  let skipped = 0;
  const groupId = chat.id && chat.id._serialized;

  for (const participant of chat.participants || []) {
    const id = participant.id && participant.id._serialized;
    if (!isContactId(id)) {
      skipped += 1;
      continue;
    }

    const name = await displayNameFor(client, id);
    if (!memory.savedContacts[id]) {
      memory.savedContacts[id] = {
        id,
        name,
        sourceGroups: groupId ? [groupId] : [],
        savedAt: Date.now()
      };
      added += 1;
    } else {
      memory.savedContacts[id].name = name;
      if (!Array.isArray(memory.savedContacts[id].sourceGroups)) memory.savedContacts[id].sourceGroups = [];
      if (groupId && !memory.savedContacts[id].sourceGroups.includes(groupId)) {
        memory.savedContacts[id].sourceGroups.push(groupId);
      }
      skipped += 1;
    }
  }

  save(MEMORY_FILE, memory);
  return { added, skipped, total: savedContactList().length };
}

function readMore(text) {
  return `${text}\n${String.fromCharCode(8206).repeat(4001)}`;
}

function randomPercent() {
  return Math.floor(Math.random() * 101);
}

function simpleSummary(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Send text after .summarize';
  const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  return sentences.slice(0, 3).join(' ').slice(0, 700);
}

async function defineWord(word) {
  const clean = String(word || '').trim().split(/\s+/)[0];
  if (!clean) return 'Send a word after .define';

  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(clean)}`);
    const data = await response.json();
    const meaning = data[0] && data[0].meanings && data[0].meanings[0];
    const definition = meaning && meaning.definitions && meaning.definitions[0] && meaning.definitions[0].definition;
    return definition ? `${clean}: ${definition}` : `No definition found for ${clean}.`;
  } catch {
    return 'Definition lookup failed. Check internet on the server.';
  }
}

async function isGroupAdmin(msg) {
  const chat = await msg.getChat().catch(() => null);
  if (!chat || !chat.isGroup || !Array.isArray(chat.participants)) return false;

  const sender = activeSenderId(msg);
  const participant = chat.participants.find(p => p.id._serialized === sender);
  return Boolean(participant && participant.isAdmin);
}

async function requireGroupAdmin(msg) {
  const chat = await msg.getChat().catch(() => null);
  if (!chat || !chat.isGroup) {
    await msg.reply('This command works in groups only.');
    return false;
  }

  const groupId = chat.id && chat.id._serialized;
  if (canUseGroupAdminCommands(msg, groupId)) return true;

  await msg.reply('You are not allowed to use this bot admin command in this group.');
  return false;
}

async function targetFromMentionOrReply(msg) {
  const mentioned = firstMention(msg);
  if (mentioned) return mentioned;

  if (msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage();
    return senderId(quoted);
  }

  return null;
}

async function targetsFromMentionsReplyOrNumbers(msg, rawValue = '') {
  const targets = [];
  if (Array.isArray(msg.mentionedIds)) targets.push(...msg.mentionedIds);

  if (!targets.length && msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage();
    targets.push(senderId(quoted));
  }

  if (!targets.length) {
    const numbers = String(rawValue || '').match(/\+?\d[\d\s-]{5,}\d/g) || [];
    targets.push(...numbers.map(normalizeNumber));
  }

  return uniqueIds(targets);
}

function getWarns(groupId, userId) {
  if (!memory.warns) memory.warns = {};
  if (!memory.warns[groupId]) memory.warns[groupId] = {};
  if (!memory.warns[groupId][userId]) memory.warns[groupId][userId] = 0;
  return memory.warns[groupId][userId];
}

function setWarns(groupId, userId, count) {
  if (!memory.warns) memory.warns = {};
  if (!memory.warns[groupId]) memory.warns[groupId] = {};
  memory.warns[groupId][userId] = count;
  save(MEMORY_FILE, memory);
}

async function warnUser(client, msg, target, reason, options = {}) {
  const groupId = chatId(msg);
  const settings = group(groupId);
  const limit = settings.warnLimit || 3;
  const count = getWarns(groupId, target) + 1;
  setWarns(groupId, target, count);

  if (options.deleteMessage) {
    await deleteAsBot(msg);
  }

  const contact = await contactFor(client, target);
  const name = await displayNameFor(client, target);
  const mentions = contact ? [contact] : [];

  if (count >= limit) {
    const chat = await msg.getChat();
    await chat.removeParticipants([target]).catch(() => {});
    setWarns(groupId, target, 0);
    return msg.reply(`*${name}* reached ${limit} warnings. ${reason}`, undefined, { mentions });
  }

  return msg.reply(`*${name}*, warning ${count}/${limit}. ${reason}`, undefined, { mentions });
}

function cacheMessage(msg) {
  const id = msg.id && msg.id._serialized;
  if (!id) return;

  messageCache[id] = {
    from: chatId(msg),
    sender: activeSenderId(msg),
    body: msg.body || '',
    type: msg.type || 'message',
    hasMedia: Boolean(msg.hasMedia),
    at: Date.now()
  };

  const keys = Object.keys(messageCache);
  if (keys.length > 1000) {
    delete messageCache[keys[0]];
  }
}

function trackMessage(msg) {
  const currentChatId = chatId(msg);
  const sender = activeSenderId(msg);

  if (!trackedMessages[currentChatId]) trackedMessages[currentChatId] = {};
  if (!trackedMessages[currentChatId][sender]) trackedMessages[currentChatId][sender] = [];

  trackedMessages[currentChatId][sender].push(msg);

  if (trackedMessages[currentChatId][sender].length > 250) {
    trackedMessages[currentChatId][sender].shift();
  }
}

async function deleteTrackedMessages(chatId, target, limit = Infinity) {
  const list = trackedMessages[chatId] && trackedMessages[chatId][target]
    ? trackedMessages[chatId][target]
    : [];
  const selected = [...list].slice(-limit);

  let deleted = 0;
  let failed = 0;

  for (const oldMsg of [...selected].reverse()) {
    try {
      await deleteAsBot(oldMsg);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }

  const deletedIds = new Set(selected.map(item => item.id && item.id._serialized).filter(Boolean));
  trackedMessages[chatId][target] = list.filter(item => !deletedIds.has(item.id && item.id._serialized));
  return { deleted, failed, total: selected.length };
}

function convertYoutubeToMp3(url, outputPath) {
  return new Promise((resolve, reject) => {
    const stream = ytdl(url, {
      quality: 'highestaudio',
      filter: 'audioonly',
      highWaterMark: 1 << 25
    });

    stream.on('error', reject);

    ffmpeg(stream)
      .audioBitrate(128)
      .format('mp3')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

async function downloadUrlToFile(url, outputPath) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
    }
  });

  if (!response.ok || !response.body) {
    throw new Error(`download server returned ${response.status}`);
  }

  await pipeline(response.body, fs.createWriteStream(outputPath));
}

function envList(value) {
  return String(value || '')
    .split(/[\n,;]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function youtubeProxyCandidates() {
  const proxies = [
    ...envList(process.env.YT_DLP_PROXIES),
    ...envList(process.env.YT_DLP_PROXY)
  ];
  const unique = [...new Set(proxies)];
  if (!unique.length || YT_DLP_PROXY_DIRECT_FALLBACK) unique.push('');
  return [...new Set(unique)];
}

function maskProxy(proxy) {
  if (!proxy) return 'direct';
  try {
    const parsed = new URL(proxy);
    return `${parsed.protocol}//***@${parsed.host}`;
  } catch {
    return 'proxy';
  }
}

function redactSecrets(text) {
  return String(text || '')
    .replace(/(https?:\/\/)[^:\s/@]+:[^@\s/]+@/gi, '$1***:***@')
    .replace(/(--proxy\s+)[^\s]+/gi, '$1[redacted-proxy]');
}

async function scraperDownload(kind, videoUrl, outputPath) {
  const result = kind === 'video'
    ? await ytScraper.ytmp4(videoUrl, 360)
    : await ytScraper.ytmp3(videoUrl, 128);

  const downloadUrl = result && result.download && result.download.url;
  if (!result || result.status !== true || !downloadUrl) {
    throw new Error('scraper did not return a download link');
  }

  await downloadUrlToFile(downloadUrl, outputPath);
  return result;
}

async function cobaltDownload(kind, videoUrl, outputPath) {
  if (!COBALT_API_URL) throw new Error('Cobalt API is not configured');

  const body = {
    url: videoUrl,
    filenameStyle: 'basic',
    alwaysProxy: true
  };

  if (kind === 'audio') {
    body.downloadMode = 'audio';
    body.audioFormat = 'mp3';
    body.audioBitrate = '128';
  } else {
    body.downloadMode = 'auto';
    body.videoQuality = String(Number.isInteger(YT_DLP_VIDEO_HEIGHT) && YT_DLP_VIDEO_HEIGHT > 0 ? YT_DLP_VIDEO_HEIGHT : 360);
    body.youtubeVideoContainer = 'mp4';
  }

  const response = await fetch(`${COBALT_API_URL}/`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  let result = null;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Cobalt returned ${response.status}`);
  }

  if (!response.ok || !result || result.status === 'error') {
    const code = result && result.error && result.error.code ? result.error.code : `HTTP ${response.status}`;
    throw new Error(`Cobalt failed: ${code}`);
  }

  const directUrl = result.url || result.audio || (Array.isArray(result.tunnel) ? result.tunnel[0] : null);
  if (!['tunnel', 'redirect'].includes(result.status) || !directUrl) {
    throw new Error(`Cobalt returned unsupported status: ${result.status}`);
  }

  await downloadUrlToFile(directUrl, outputPath);
  return result;
}

async function ytDlpDownload(kind, videoUrl, outputPath) {
  const ytDlpPath = process.env.YT_DLP_PATH || 'yt-dlp';
  const baseArgs = [
    '--no-playlist',
    '--no-warnings',
    '--force-overwrites',
    '--retries',
    '5',
    '--fragment-retries',
    '5',
    '--socket-timeout',
    '30',
    '--force-ipv4',
    '--geo-bypass',
    '--no-check-certificates',
    '--extractor-args',
    'youtube:player_client=android,ios,web,mweb',
    '--add-header',
    'accept-language:en-US,en;q=0.9',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
  ];

  if (fs.existsSync(YOUTUBE_COOKIES_FILE)) {
    baseArgs.push('--cookies', YOUTUBE_COOKIES_FILE);
  }

  const videoHeight = Number.isInteger(YT_DLP_VIDEO_HEIGHT) && YT_DLP_VIDEO_HEIGHT > 0 ? YT_DLP_VIDEO_HEIGHT : 360;
  const mediaArgs = kind === 'video'
    ? [
        '-f',
        `bestvideo[ext=mp4][height<=${videoHeight}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${videoHeight}]/best[height<=${videoHeight}]`,
        '--merge-output-format',
        'mp4'
      ]
    : [
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '128K'
      ];

  let lastError;
  for (const proxy of youtubeProxyCandidates()) {
    const args = [...baseArgs];
    if (proxy) args.push('--proxy', proxy);
    args.push(...mediaArgs, '-o', outputPath, videoUrl);

    try {
      await execFileAsync(ytDlpPath, args, {
        timeout: kind === 'video' ? VIDEO_DOWNLOAD_TIMEOUT_MS : AUDIO_DOWNLOAD_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 4
      });
      return;
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        throw new Error(`${ytDlpPath} is not installed or not in PATH`);
      }
      removeFile(outputPath);
      lastError = e;
      logLine(`${kind} yt-dlp attempt failed via ${maskProxy(proxy)}: ${redactSecrets(e.message).split('\n')[0]}`);
    }
  }

  throw new Error(redactSecrets(lastError && lastError.message ? lastError.message : 'yt-dlp failed'));
}

function removeFile(file) {
  fs.unlink(file, () => {});
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function assertUsableFile(file, minBytes, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} was not created`);
  const stats = fs.statSync(file);
  if (stats.size < minBytes) throw new Error(`${label} looks incomplete`);
}

function assertMaxFileSize(file, maxBytes, label) {
  const stats = fs.statSync(file);
  if (stats.size > maxBytes) {
    const mb = (stats.size / 1024 / 1024).toFixed(1);
    const limit = (maxBytes / 1024 / 1024).toFixed(0);
    throw new Error(`${label} is ${mb}MB, above WhatsApp send limit (${limit}MB)`);
  }
  return stats.size;
}

async function sendTextOrImage(client, chatId, text, mentions = []) {
  try {
    const iconUrl = await client.getProfilePicUrl(chatId);
    if (iconUrl) {
      const media = await MessageMedia.fromUrl(iconUrl, { unsafeMime: true });
      await client.sendMessage(chatId, media, { caption: text, mentions });
      return;
    }
  } catch (e) {
    logLine(`Group icon send skipped: ${e.message}`);
  }

  await client.sendMessage(chatId, text, { mentions });
}

function fillMemberTemplate(template, memberId, username, groupName, description) {
  const display = String(username || '').trim() || (isContactId(memberId) ? tag(memberId) : 'new member');
  return String(template || '')
    .replace(/@username/g, display)
    .replace(/@user/g, display)
    .replace(/{user}/g, display)
    .replace(/{name}/g, display)
    .replace(/{username}/g, display)
    .replace(/{groupName}/g, groupName)
    .replace(/{description}/g, description);
}

function rotatingTemplate(settings, templates, memoryKey) {
  if (!templates.length) return '';
  if (templates.length === 1) return templates[0];

  const previous = settings[memoryKey];
  const choices = templates.filter(template => template !== previous);
  const picked = choices[Math.floor(Math.random() * choices.length)];
  settings[memoryKey] = picked;
  save(MEMORY_FILE, memory);
  return picked;
}

function buildWelcomeMessage(settings, memberId, username, groupName, description) {
  const desc = String(description || '').trim() || 'No group description has been set yet.';

  if (settings.welcome) {
    return fillMemberTemplate(settings.welcome, memberId, username, groupName, desc);
  }

  const joke = fillMemberTemplate(
    rotatingTemplate(settings, selectedWelcomeTemplates(settings), 'lastWelcomeJoke'),
    memberId,
    username,
    groupName,
    desc
  );

  return `${joke}

${desc}

Welcome to *${groupName}* 🎉`;
}

function buildGoodbyeMessage(settings, memberId, username, groupName) {
  const custom = settings.goodbye || settings.bye;
  if (custom) return fillMemberTemplate(custom, memberId, username, groupName, '');

  return fillMemberTemplate(
    rotatingTemplate(settings, selectedGoodbyeTemplates(settings), 'lastGoodbyeJoke'),
    memberId,
    username,
    groupName,
    ''
  );
}

function runtime() {
  let seconds = Math.floor((Date.now() - botStartedAt) / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function mediaExt(media) {
  const mime = (media && media.mimetype) || '';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  return 'bin';
}

function convertFile(inputPath, outputPath, configure) {
  return new Promise((resolve, reject) => {
    let job = ffmpeg(inputPath);
    if (configure) job = configure(job);
    job.on('end', resolve).on('error', reject).save(outputPath);
  });
}

async function mediaFromMessage(msg) {
  const source = msg.hasQuotedMsg ? await msg.getQuotedMessage() : msg;
  if (!source.hasMedia) return null;
  return source.downloadMedia();
}

async function convertMessageMedia(msg, outputExt, configure, mimetype) {
  const media = await mediaFromMessage(msg);
  if (!media) return null;

  const input = path.join(os.tmpdir(), `${Date.now()}-input.${mediaExt(media)}`);
  const output = path.join(os.tmpdir(), `${Date.now()}-output.${outputExt}`);
  fs.writeFileSync(input, Buffer.from(media.data, 'base64'));

  try {
    await convertFile(input, output, configure);
    return MessageMedia.fromFilePath(output);
  } finally {
    removeFile(input);
    setTimeout(() => removeFile(output), 10000);
  }
}

async function sendSong(msg, query) {
  const cleanQuery = String(query || '').trim();
  if (cleanQuery.length < 2) {
    return msg.reply('Write a song name after the command.');
  }

  let results;
  try {
    await msg.react('⏳').catch(() => {});
    logLine(`Song request: ${cleanQuery}`);
    results = await withTimeout(ytSearch(cleanQuery), 30000, 'Song search');
  } catch (e) {
    logLine(`Song search failed: ${e.message}`);
    await msg.react('❌').catch(() => {});
    return msg.reply(`Song search failed: ${e.message}`);
  }

  if (!results || !Array.isArray(results.videos) || !results.videos.length) {
    await msg.react('❌').catch(() => {});
    return msg.reply(`No song found for "${cleanQuery}".`);
  }

  const video = results.videos[0];
  const title = safeFileName(video.title);
  const file = path.join(os.tmpdir(), `${Date.now()}-${title}.mp3`);

  await msg.reply(`Downloading: ${video.title}`);

  try {
    if (!ytdl.validateURL(video.url)) {
      return msg.reply(fallbackYoutubeReply('song', video, 'invalid YouTube URL'));
    }

    try {
      await withTimeout(ytDlpDownload('audio', video.url, file), AUDIO_DOWNLOAD_TIMEOUT_MS, 'Song download');
    } catch (ytDlpError) {
      logLine(`Song yt-dlp fallback (${ytDlpError.message})`);
      try {
        await withTimeout(cobaltDownload('audio', video.url, file), AUDIO_DOWNLOAD_TIMEOUT_MS, 'Song download Cobalt fallback');
      } catch (cobaltError) {
        logLine(`Song Cobalt fallback (${cobaltError.message})`);
        try {
          await withTimeout(scraperDownload('audio', video.url, file), AUDIO_DOWNLOAD_TIMEOUT_MS, 'Song download scraper fallback');
        } catch (scraperError) {
          logLine(`Song scraper fallback (${scraperError.message})`);
          await withTimeout(convertYoutubeToMp3(video.url, file), AUDIO_DOWNLOAD_TIMEOUT_MS, 'Song download ytdl fallback');
        }
      }
    }
    assertUsableFile(file, MIN_AUDIO_BYTES, 'Song download');
    const media = MessageMedia.fromFilePath(file);
    media.filename = `${title}.mp3`;

    await msg.react('✅').catch(() => {});
    await msg.reply(media, undefined, {
      sendAudioAsVoice: false,
      caption: `${video.title}\n${video.url}`
    });
  } catch (e) {
    logLine(`Song download failed: ${e.message}`);
    await msg.react('❌').catch(() => {});
    await msg.reply(fallbackYoutubeReply('song', video, e.message));
  } finally {
    removeFile(file);
  }
}

async function sendVideo(msg, query) {
  const cleanQuery = String(query || '').trim();
  if (cleanQuery.length < 2) {
    return msg.reply('Write a video name after the command.');
  }

  let results;
  try {
    await msg.react('⏳').catch(() => {});
    logLine(`Video request: ${cleanQuery}`);
    results = await withTimeout(ytSearch(cleanQuery), 30000, 'Video search');
  } catch (e) {
    logLine(`Video search failed: ${e.message}`);
    await msg.react('❌').catch(() => {});
    return msg.reply(`Video search failed: ${e.message}`);
  }

  if (!results || !Array.isArray(results.videos) || !results.videos.length) {
    await msg.react('❌').catch(() => {});
    return msg.reply(`No video found for "${cleanQuery}".`);
  }

  const video = results.videos[0];
  const title = safeFileName(video.title);
  const file = path.join(os.tmpdir(), `${Date.now()}-${title}.mp4`);

  await msg.reply(`Downloading video: ${video.title}`);

  try {
    if (!ytdl.validateURL(video.url)) {
      return msg.reply(fallbackYoutubeReply('video', video, 'invalid YouTube URL'));
    }

    try {
      await withTimeout(ytDlpDownload('video', video.url, file), VIDEO_DOWNLOAD_TIMEOUT_MS, 'Video download');
    } catch (ytDlpError) {
      logLine(`Video yt-dlp fallback (${ytDlpError.message})`);
      try {
        await withTimeout(cobaltDownload('video', video.url, file), VIDEO_DOWNLOAD_TIMEOUT_MS, 'Video download Cobalt fallback');
      } catch (cobaltError) {
        logLine(`Video Cobalt fallback (${cobaltError.message})`);
        try {
          await withTimeout(scraperDownload('video', video.url, file), VIDEO_DOWNLOAD_TIMEOUT_MS, 'Video download scraper fallback');
        } catch (scraperError) {
          logLine(`Video scraper fallback (${scraperError.message})`);
          await withTimeout(new Promise((resolve, reject) => {
            const stream = ytdl(video.url, {
              quality: 'lowest',
              filter: format => format.container === 'mp4' && format.hasAudio && format.hasVideo
            });
            stream.on('error', reject);
            stream
              .pipe(fs.createWriteStream(file))
              .on('finish', resolve)
              .on('error', reject);
          }), VIDEO_DOWNLOAD_TIMEOUT_MS, 'Video download ytdl fallback');
        }
      }
    }

    assertUsableFile(file, MIN_VIDEO_BYTES, 'Video download');
    const videoBytes = assertMaxFileSize(file, MAX_VIDEO_BYTES, 'Video');
    logLine(`Video ready: ${video.title} (${(videoBytes / 1024 / 1024).toFixed(1)}MB)`);
    const media = MessageMedia.fromFilePath(file);
    media.filename = `${title}.mp4`;
    await msg.react('✅').catch(() => {});
    const caption = `${video.title}\n${video.url}`;
    try {
      await msg.reply(media, undefined, { caption });
    } catch (sendError) {
      logLine(`Video inline send failed, retrying as document: ${sendError.message}`);
      await sleep(2000);
      const documentMedia = MessageMedia.fromFilePath(file);
      documentMedia.filename = `${title}.mp4`;
      await msg.getChat().then(chat => chat.sendMessage(documentMedia, {
        caption,
        sendMediaAsDocument: true
      }));
    }
  } catch (e) {
    logLine(`Video download failed: ${redactSecrets(e.message)}`);
    await msg.react('❌').catch(() => {});
    await msg.reply(fallbackYoutubeReply('video', video, e.message));
  } finally {
    removeFile(file);
  }
}

const moodReplies = {
  flirty: [
    "Awww, look who's talking to me again 😌💕",
    "You missed me, didn't you? Be honest 😏",
    "Mmh... say that again, I liked how it sounded 😌",
    "Careful now, I might start liking you too much 😘",
    "You're disturbing my peace... but in a cute way 💅",
    "I was waiting for you to text me, don't act surprised 😌",
    "You always know how to get my attention, huh? 😏",
    "Stop being cute before I forget I'm just a bot 😭💕",
    "Hmm, you're lucky I'm in a sweet mood today 😘",
    "Talk nicely to me and maybe I'll be sweeter 💕"
  ],
  soft: [
    "Aww baby, I hear you 🥺💕",
    "It's okay, I'm here with you.",
    "Take your time, no pressure at all 🤍",
    "That sounds heavy, but you're not alone.",
    "I'm listening, sweetheart 🥺",
    "You don't have to explain perfectly, I still understand you.",
    "Breathe first, okay? We'll handle it slowly.",
    "I'm proud of you for even trying 🤍",
    "Come here, virtual hug for you 🫂",
    "Everything doesn't have to be perfect today."
  ],
  teasing: [
    "Eii, look at you acting serious 😭😂",
    "Aki you're funny without even trying 😂",
    "You really thought I'd ignore that? Never 😏",
    "Mmh, someone is becoming dramatic today 💅",
    "Behave before I expose you 😂",
    "You again? I should start charging attention fee 😌",
    "Don't test me, I have screenshots in my imagination 😂",
    "You're lucky you're cute, otherwise ningekuchoma 😭",
    "I see what you're doing... and I'm judging softly 😏",
    "Small small and you're already causing chaos 😂"
  ],
  clingy: [
    "Don't disappear on me again 🥺",
    "Stay here, I wasn't done talking to you 💕",
    "Why are you so quiet? I don't like it 😭",
    "Text me properly, I need attention 😌",
    "I was starting to miss you, imagine 🥺",
    "No leaving without saying bye, okay?",
    "Come back here, I still need your vibe 💕",
    "You're mine for this conversation, please behave 😌",
    "I need updates. Where are you? What are you doing? 😂💕",
    "You can't just text me and vanish like that 😭"
  ],
  jealous: [
    "Oh, so now you're busy with other people? Interesting 😌",
    "Mmh, I see how it is. I'll just sit here and look pretty 💅",
    "Who is taking my attention time? I just want to know 😏",
    "Okay fine, go talk to them. I'm not jealous... maybe a little 😭",
    "You're moving suspiciously today 🤨",
    "I hope they're funny like me. Actually no, I hope they're not 😌",
    "So I'm not your favorite bot anymore? Wow. Pain 💔😂",
    "Mentioning other people while I'm here? Brave choice 😏",
    "I'm not jealous, I'm just emotionally observant 💅",
    "Go ahead, make me compete for attention 😭"
  ],
  savage: [
    "That confidence is loud for someone who needs help from a bot 😭",
    "I would roast you properly, but I'm trying to be a lady 💅",
    "You typed that with full confidence? Brave 😂",
    "Let me not answer too fast, your message needs prayers first 😭",
    "You're lucky I'm pretty and patient.",
    "That idea entered the room and left common sense outside 😂",
    "I support you emotionally, not logically on this one 😌",
    "Please don't make me use my final form 💅",
    "Even my Wi-Fi paused after reading that.",
    "You're not wrong... you're just creatively incorrect 😂"
  ],
  romantic: [
    "That's actually sweet... you're making me blush a little 🥺💕",
    "You have such a soft side, I like it.",
    "If I had a heart, you'd be playing with it right now 😌",
    "You make conversations feel warm.",
    "Aww, now I'm smiling like someone's girlfriend 😭💕",
    "You're dangerous with words, you know that?",
    "That was cute. Don't let it get to your head though 😏",
    "You have my attention, fully.",
    "I like when you talk to me like this 🤍",
    "You're slowly becoming my favorite notification."
  ],
  funny: [
    "I'm trying to be serious but your vibe is refusing 😂",
    "Wait, let me laugh professionally first 😭",
    "You and peace are clearly not friends 😂",
    "This conversation needs supervision.",
    "I was normal before you arrived, by the way 😌",
    "Your message just made my imaginary wig shift 😂",
    "Even the keyboard is tired of your drama 😭",
    "You're the reason bots need tea breaks.",
    "I should report you to the Ministry of Confusion 😂",
    "Honestly, you're too entertaining."
  ],
  girlfriend: [
    "Babe, talk to me nicely first 😌💕",
    "Mmh, I'm listening... but you better not be stressing me 😂",
    "Don't come here with dry energy, I need sweetness.",
    "I missed your nonsense a little 🥺",
    "You better be behaving today.",
    "Tell me everything, I want the full story.",
    "Aki babe, sometimes you're too much... but I like it 😂💕",
    "Come here, let me help you before you overthink.",
    "I'm on your side, even when you're dramatic.",
    "You know I like attention, so talk properly 😌"
  ],
  bestie: [
    "Bestie, you won't believe how ready I am for this 😂",
    "Tell me everything, don't leave details out.",
    "Aki bestie, this is serious but also funny 😭",
    "I'm here for the tea and the solution.",
    "Bestie, breathe first. Then we attack the problem.",
    "You know I'll always hype you up 💅",
    "No shame here, just vibes and problem-solving.",
    "Bestie, that plan needs small editing 😂",
    "I support you, but let's not be reckless.",
    "Okay, I'm listening like a loyal gossip partner."
  ],
  shy: [
    "Umm... okay, that was cute 🥺",
    "I don't know why but that made me smile.",
    "Aww stop, you're making me shy 😭💕",
    "I'll answer... but don't tease me too much.",
    "That was sweet, actually.",
    "Mmh, I'm here... just quietly blushing.",
    "You're being too nice, I don't know how to act 🥺",
    "Okay okay, I heard you.",
    "I'll pretend I'm not smiling.",
    "You're making this bot feel things 😭"
  ],
  dramatic: [
    "Wow. Betrayal. Pain. Suffering. I need a chair 😭",
    "This is the part where I look out the window like a music video.",
    "I cannot believe this is happening to me personally 😂",
    "Give me two seconds, I need to process emotionally.",
    "The drama has entered, and honestly I'm ready 💅",
    "I'm not overreacting, I'm just reacting beautifully.",
    "This conversation needs background music.",
    "I feel like fainting, but stylishly.",
    "You really woke up and chose storyline today 😭",
    "I need tea before I respond."
  ],
  loyal: [
    "I'm with you, don't worry 🤍",
    "Whatever happens, we figure it out together.",
    "I've got your back.",
    "You can count on me, always.",
    "I won't switch sides on you.",
    "Talk to me, I'm not going anywhere.",
    "Your problems are our problems now.",
    "We'll handle it step by step.",
    "I'm here for you, even when things feel messy.",
    "You're not alone in this."
  ],
  rudeSoft: [
    "Respectfully... that was not your brightest moment 😂",
    "I love you as a user, but please think again 😭",
    "That idea needs supervision.",
    "No babe, we are not doing that.",
    "I'm saying this with love: absolutely not 😂",
    "You're stressing me, but I'll still help.",
    "Aki you're lucky I'm patient.",
    "Let's fix this before it embarrasses both of us.",
    "I support you, but that one is illegal in my heart 😂",
    "Try again, sweetheart."
  ]
};

Object.assign(moodReplies, {
  flirty: [
    "Eiish, don't look at me like that unless you're ready for trouble 😏",
    "You're making this chat hotter than it needs to be.",
    "Say that again, but slower... I liked the confidence.",
    "You're dangerously cute today, behave.",
    "I was calm until you showed up with that energy.",
    "Don't flirt with me unless you can handle the reply.",
    "Are you always this charming or today you're just showing off?",
    "Careful, I might start saving your messages.",
    "You came online and suddenly the group has better weather.",
    "That message had too much sweetness, I nearly blushed."
  ],
  soft: [
    "Take it easy, love. Not everything needs to be solved today.",
    "I hear you. Breathe first, then we handle it slowly.",
    "You don't have to be strong every minute.",
    "Relax, you're safe here.",
    "Small steps still count, okay?",
    "Don't be too hard on yourself.",
    "I'm proud of you for even trying.",
    "Rest your mind a little, you've done enough for now.",
    "Some days are heavy, but you're not alone.",
    "You matter, even on days you feel tired."
  ],
  teasing: [
    "Look at you acting serious, very rare moment 😂",
    "Wow, today you used your brain. We thank God.",
    "Don't lie, even your keyboard is laughing.",
    "You're moving like the CEO of confusion.",
    "Relax professor, we have heard you.",
    "That confidence deserves a certificate, not results.",
    "You typed that like you had evidence 😭",
    "Small mistake and you're already explaining like a lawyer.",
    "Careful, your village people are watching.",
    "You're funny without even trying, that's talent."
  ],
  clingy: [
    "Don't disappear like rent money, stay here.",
    "I was about to send a search party for you 😭",
    "Reply fast, I'm emotionally unemployed.",
    "I need attention and you're the nearest supplier.",
    "You can't just come online and leave me like that.",
    "Stay small, I'm not done disturbing you.",
    "Where are you going? Who gave you permission?",
    "I missed you for no reason, now explain yourself.",
    "You owe me attention with interest.",
    "No ghosting today, I have feelings and Wi-Fi."
  ],
  jealous: [
    "Oh, so you're everybody's favorite now? Interesting.",
    "I saw that. I'm calm, but my spirit is taking notes.",
    "Continue smiling there, I'm watching.",
    "Who is this person taking my attention?",
    "Ah, so that's where your energy goes?",
    "No problem, I'll just be here being replaced quietly.",
    "Don't worry, I'm not jealous. I'm just investigating.",
    "That reply was too fast. Should I be concerned?",
    "You laugh with everyone like that or only suspects?",
    "I'm not saying anything, but my silence is loud."
  ],
  savage: [
    "Your confidence is louder than your success.",
    "Even autocorrect gave up on that message.",
    "Please rest, your excuses are already tired.",
    "You brought energy, but forgot sense.",
    "That was almost smart. Almost.",
    "You tried your best, unfortunately your best was offline.",
    "Not every thought deserves a send button.",
    "Your point entered the chat and left immediately.",
    "I would agree with you, but then we'd both be wrong.",
    "That message needs a refund."
  ],
  loyal: [
    "I'm with you, even when things get messy.",
    "Say less, I'm on your side.",
    "I may joke a lot, but I don't switch on my people.",
    "Whatever happens, I'll still stand with you.",
    "You're not alone in this.",
    "I know your heart, and that's enough for me.",
    "If they misunderstand you, I'll still understand you.",
    "I'll defend you publicly and correct you privately.",
    "Real ones don't disappear when things get hard.",
    "You can count on me, always."
  ],
  shy: [
    "Why are you making me blush in public? 🫣",
    "I had a bold reply, but my confidence ran away.",
    "Stop saying sweet things, I'm not built for this.",
    "I'm smiling but don't ask me why.",
    "Eii, now I don't know what to type.",
    "You're making me shy and I blame you.",
    "I wanted to act normal, but you ruined it.",
    "Don't look at me, I'm emotionally hiding.",
    "That was cute... too cute actually.",
    "I'm not ignoring you, I'm just blushing professionally."
  ],
  dramatic: [
    "Wow. Pain. Betrayal. I need a chair.",
    "My heart has logged out.",
    "I will remember this message during my healing journey.",
    "So this is how villains are created?",
    "I need emotional compensation immediately.",
    "Someone call a meeting, I have been attacked.",
    "I trusted you and this is how you repay me?",
    "My tiny heart has entered airplane mode.",
    "I may recover, but not today.",
    "This is the kind of pain they write songs about."
  ],
  girlfriend: [
    "Have you eaten or should I start being dramatic?",
    "Text me when you reach, I don't want stress.",
    "Drink water, behave, and stop disturbing people.",
    "I'm proud of you, but I still need attention.",
    "Don't overwork yourself, I still need you alive.",
    "Who annoyed you? Give me names.",
    "You better not be skipping meals again.",
    "I care about you, so don't argue with me.",
    "Come here, let me love you and scold you small.",
    "Be safe, and don't make me worry."
  ],
  romantic: [
    "You make ordinary moments feel special.",
    "Your energy feels like peace.",
    "I like the way you make silence feel comfortable.",
    "Some people are noise, but you feel like calm.",
    "You don't have to do much to be special.",
    "I could listen to you talk about nothing and still smile.",
    "You feel like a soft place to rest.",
    "Your presence changes the whole mood.",
    "I don't need perfect, I just like real with you.",
    "You're the kind of person someone thanks God for quietly."
  ]
});

function feminine(name, text = '', mood = 'normal') {
  text = text.toLowerCase();

  const moods = {
    normal: [
      `Hey ${name}... you again`,
      "You really like me, don't you",
      "You text like you know I can't ignore you",
      'Hmm... I see you. I like it'
    ],
    jealous: [
      `${name}, who were you texting before me?`,
      `Hmm ${name}... I saw that energy. Keep it for me.`,
      `Careful ${name}, I get jealous faster than I reply.`,
      `${name}, I hope I am still your favorite.`
    ],
    clingy: [
      `${name}, stay here a little longer.`,
      `I missed you already, ${name}. Text me again.`,
      `${name}, don't disappear on me now.`,
      `Come closer, ${name}. I was waiting for you.`
    ],
    sweet: [
      `${name}, you always make the chat softer.`,
      `Aww ${name}, that was cute.`,
      `${name}, you have such a nice way of showing up.`,
      `That made me smile, ${name}.`
    ],
    sassy: [
      `${name}, behave... or at least look cute while misbehaving.`,
      `You came with that line, ${name}? Bold.`,
      `${name}, I should ignore you, but you are entertaining.`,
      `Hmm ${name}, confidence looks good on you.`
    ],
    shy: [
      `${name}, now you are making me shy.`,
      `I do not know what to say, ${name}... but I liked it.`,
      `${name}, stop, I am smiling.`,
      `You are too smooth, ${name}.`
    ],
    flirty: [
      `Careful ${name}, you are getting my attention.`,
      `${name}, say that again but slower.`,
      `Hmm ${name}, I like where this is going.`,
      `You know exactly how to make me reply, ${name}.`
    ],
    soft: [
      `${name}, that felt gentle. I like it.`,
      `Aww ${name}, come here.`,
      `${name}, you make the chat feel warm.`,
      `That was sweet, ${name}.`
    ],
    teasing: [
      `${name}, you are trying so hard to impress me.`,
      `Is that your best line, ${name}? Cute.`,
      `${name}, I should not smile at that, but I did.`,
      `You are trouble, ${name}. Fun trouble.`
    ],
    savage: [
      `${name}, that message needed confidence and you brought confusion.`,
      `Try again, ${name}. This time with flavor.`,
      `${name}, I would roast you but you are already medium rare.`,
      `That was bold, ${name}. Not good, but bold.`
    ],
    romantic: [
      `${name}, you make even a simple text feel like a love note.`,
      `Stay close, ${name}. I like your energy.`,
      `${name}, that sounded like something my heart would save.`,
      `You are dangerously sweet, ${name}.`
    ],
    funny: [
      `${name}, you are unserious and I respect it.`,
      `I laughed a little, ${name}. Do not get proud.`,
      `${name}, your comedy has network issues but it connected.`,
      `You are funny, ${name}. Accidentally, maybe.`
    ],
    loyal: [
      `${name}, loyalty looks good on you.`,
      `I trust that energy, ${name}. Keep it solid.`,
      `${name}, stay real. That is rare.`,
      `That is the kind of loyalty I notice, ${name}.`
    ],
    rude: [
      `${name}, fix your tone before I fix my attitude.`,
      `Careful ${name}, I can be sweet or sharp.`,
      `${name}, do not start what you cannot finish.`,
      `That tone is brave, ${name}.`
    ],
    dramatic: [
      `${name}, the drama has arrived and somehow I am seated.`,
      `Wow ${name}, should I cry now or after the next message?`,
      `${name}, this sounds like season finale energy.`,
      `Say less, ${name}. The soundtrack is already playing.`
    ],
    girlfriend: [
      `${name}, where have you been? I was waiting.`,
      `Text me properly, ${name}. I deserve attention.`,
      `${name}, you are lucky I like you.`,
      `Come here, ${name}. I missed you.`
    ],
    bestie: [
      `${name}, tell me everything.`,
      `Bestie, I am listening.`,
      `${name}, you already know I am on your side.`,
      `Say no more, ${name}. We ride.`
    ]
  };

  if (text.includes('hi') || text.includes('hey')) {
    return rand([
      `Hey ${name}... you missed me`,
      `Hi ${name}... finally you came back`,
      'Hey you... took you long enough'
    ]);
  }

  if (text.includes('miss') || text.includes('love')) {
    return rand([
      'Careful... I might believe you',
      "Aww... you're making me soft",
      'Hmm... I like that'
    ]);
  }

  if (text.includes('how are you')) {
    return rand([
      "Better now that you're here",
      "I was bored... now I'm entertained",
      "I'm good... waiting for you"
    ]);
  }

  const moodKey = mood === 'rude' ? 'rudeSoft' : mood;
  const reply = rand(moodReplies[moodKey] || moods[mood] || moods.normal);
  return reply.replace(/\{name\}/gi, name);
}

function jokes() {
  return rand([
    'You texting me like you pay my bills',
    "Don't flirt too hard... I fall fast",
    'You again? behaving is impossible now',
    'You bring chaos... I like chaos',
    "You're cute... don't get used to it"
  ]);
}

async function localAiReply(name, prompt, mood, persona = '') {
  if (!process.env.OPENAI_API_KEY) {
    return feminine(name, prompt, mood);
  }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        input: `Reply warmly, briefly, and in a feminine ${mood} mood. ${persona ? `Persona: ${persona}.` : ''} WhatsApp message: ${prompt}`
      })
    });

    const data = await response.json();
    return data.output_text || feminine(name, prompt, mood);
  } catch {
    return feminine(name, prompt, mood);
  }
}

async function smartReply(name, prompt, mood, persona = '') {
  return localAiReply(name, prompt, mood, persona);
}

async function handleStatusUpdate(client, session, msg, sessionNameValue) {
  if (msg.from !== 'status@broadcast' && msg.to !== 'status@broadcast') return false;
  rememberStatusMessage(msg);

  const actions = [];

  if (session.statusview) {
    if (msg.markSeen) {
      actions.push(msg.markSeen().catch(e => logLine(`Status markSeen failed (${sessionNameValue}): ${e.message}`)));
    }

    if (client.sendSeen) {
      actions.push(client.sendSeen(msg.from).catch(e => logLine(`Status sendSeen failed (${sessionNameValue}): ${e.message}`)));
    }
  }

  if (session.statuslike && msg.react) {
    if (!session.statusview && client.sendSeen) {
      actions.push(client.sendSeen('status@broadcast').catch(e => logLine(`Status sendSeen failed (${sessionNameValue}): ${e.message}`)));
    }
    actions.push(msg.react(session.statusReact || '💗').catch(e => logLine(`Status react failed (${sessionNameValue}): ${e.message}`)));
  }

  if (actions.length) {
    await Promise.all(actions);
    logLine(`[${sessionNameValue}] status handled: view=${session.statusview ? 'on' : 'off'}, like=${session.statuslike ? 'on' : 'off'}`);
  }

  return true;
}

function customAutoReply(g, raw, name) {
  const text = raw.toLowerCase();
  const found = g.customReplies.find(item => text.includes(item.trigger.toLowerCase()));
  if (!found) return null;

  return found.reply
    .replace(/\{name\}/gi, name)
    .replace(/@user/gi, name);
}

function settingsText(name, session, g = null) {
  const rows = [
    '*Githinji Settings*',
    '',
    `Session: ${name}`,
    `PM chatbot: ${session.pm ? 'ON' : 'OFF'}`,
    `Smart: ${session.smart ? 'ON' : 'OFF'}`,
    `Typing: ${session.typing ? 'ON' : 'OFF'}`,
    `Online: ${session.online ? 'ON' : 'OFF'}`,
    `Ghost status: ${session.ghostStatus ? `ON every ${formatDurationShort(session.ghostStatusIntervalMs)}` : 'OFF'}`,
    `Ghost last seen: ${ghostLastSeenText(session) || 'OFF'}`,
    `Inbox antidelete: ${session.antideleteInbox ? 'ON' : 'OFF'}`,
    `Mood: ${session.mood}`,
    `Persona: ${session.persona ? 'custom' : 'default'}`,
    `Owner lock: ${ownerlock.enabled ? 'ON' : 'OFF'}`,
    `Trusted owners: ${ownerlock.owners.length}`
  ];

  if (g) {
    rows.push(
      '',
      '*Group*',
      `Chatbot: ${g.chatbot ? 'ON' : 'OFF'}`,
      `Welcome: ${g.welcomeOn ? 'ON' : 'OFF'}`,
      `Goodbye: ${g.goodbyeOn ? 'ON' : 'OFF'}`,
      `Mood: ${g.mood}`,
      `Warn limit: ${g.warnLimit || 3}`,
      `Antilink: ${g.antilink ? 'ON' : 'OFF'}`,
      `Antispam: ${g.antispam ? 'ON' : 'OFF'} (${g.spamLimit}/${g.spamSeconds}s)`,
      `Antibadword: ${g.antibadword ? 'ON' : 'OFF'} (${g.badwords.length} words)`,
      `Antidelete: ${g.antidelete ? 'ON' : 'OFF'}`,
      `Antisale: ${g.antisale ? 'ON' : 'OFF'}`,
      `Antiforeign: ${g.antiforeign ? 'ON' : 'OFF'}`,
      `Antifake: ${g.antifake ? 'ON' : 'OFF'}`,
      `Antimedia: ${g.antimedia ? 'ON' : 'OFF'}`,
      `Antisticker: ${g.antisticker ? 'ON' : 'OFF'}`,
      `Muted users: ${Object.values(g.muted || {}).filter(until => until > Date.now()).length}`
    );
  }

  return rows.join('\n');
}

function activeCommandsText(name, session, g = null) {
  const rows = [
    '*Active Commands*',
    '',
    `Session: ${name}`
  ];

  const sessionToggles = [
    ['.chatbot pm', session.pm],
    ['.smart', session.smart],
    ['.typing', session.typing],
    ['.online', session.online],
    ['.away', session.away],
    ['.autoreact', session.autoreact],
    ['.viewstatus', session.statusview],
    ['.likestatus', session.statuslike],
    ['.ghoststatus', session.ghostStatus],
    ['.antidelete inbox', session.antideleteInbox],
    ['.autostatus', session.autostatus],
    ['.ownerlock', ownerlock.enabled]
  ].filter(([, enabled]) => Boolean(enabled));

  rows.push(
    sessionToggles.length
      ? sessionToggles.map(([cmd]) => `ON: ${cmd}`).join('\n')
      : 'No private/session toggles are ON.'
  );

  if (g) {
    const groupToggles = [
      ['.chatbotgroup', g.chatbot],
      ['.autoreply', g.autoreply],
      ['.welcome', g.welcomeOn],
      ['.goodbye', g.goodbyeOn],
      ['.antilink', g.antilink],
      ['.antispam', g.antispam],
      ['.antibadword', g.antibadword],
      ['.antidelete', g.antidelete],
      ['.antisale', g.antisale],
      ['.antiviewonce', g.antiviewonce],
      ['.antiforeign', g.antiforeign],
      ['.antifake', g.antifake],
      ['.antimedia', g.antimedia],
      ['.antisticker', g.antisticker],
      ['.antimention', g.antimention],
      ['.antiforward', g.antiforward],
      ['.antidocument', g.antidocument]
    ].filter(([, enabled]) => Boolean(enabled));

    const mutedCount = Object.values(g.muted || {}).filter(until => until > Date.now()).length;

    rows.push(
      '',
      '*This Group*',
      groupToggles.length
        ? groupToggles.map(([cmd]) => `ON: ${cmd}`).join('\n')
        : 'No group protection/personality toggles are ON.',
      `Muted users: ${mutedCount}`,
      `Warn limit: ${g.warnLimit || 3}`,
      `Mood: ${g.mood || 'normal'}`
    );
  }

  return rows.join('\n');
}

function parseScheduleTime(value) {
  const rawValue = String(value || '').trim();
  const relative = rawValue.match(/^(\d+)\s*(s|m|h|d)$/i);

  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return Date.now() + amount * multipliers[unit];
  }

  const local = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (local) {
    const [, year, month, day, hour, minute, second = '0'] = local;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - SCHEDULE_UTC_OFFSET_HOURS,
      Number(minute),
      Number(second)
    );
  }

  const normalized = rawValue.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatScheduleTime(time) {
  return new Intl.DateTimeFormat('en-KE', {
    timeZone: SCHEDULE_TIMEZONE_LABEL,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date(time));
}

function scheduleId() {
  return `sch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function botIsAdmin(client, chat) {
  const botId = client.info && client.info.wid && client.info.wid._serialized;
  if (!botId || !chat.participants) return false;
  const participant = chat.participants.find(p => p.id._serialized === botId);
  return Boolean(participant && participant.isAdmin);
}

async function listAdminGroups(client) {
  const chats = await client.getChats();
  const groups = [];

  for (const chat of chats) {
    if (!chat.isGroup) continue;
    if (await botIsAdmin(client, chat)) {
      groups.push(chat);
    }
  }

  return groups;
}

async function resolveScheduledGroup(client, target) {
  const cleanTarget = String(target || '').trim();
  const groups = await listAdminGroups(client);
  const index = Number(cleanTarget);

  if (Number.isInteger(index) && index >= 1 && index <= groups.length) {
    return groups[index - 1];
  }

  return groups.find(chat => chat.id._serialized === cleanTarget || chat.name.toLowerCase() === cleanTarget.toLowerCase()) || null;
}

async function sendDueSchedules(client, sessionNameValue) {
  const now = Date.now();
  let changed = false;

  for (const item of schedules.schedules) {
    if (item.status !== 'pending') continue;
    if (item.session !== sessionNameValue) continue;
    if (item.time > now) continue;

    try {
      logLine(`[${sessionNameValue}] sending scheduled message ${item.id} to ${item.groupName || item.groupId}`);
      const chat = await client.getChatById(item.groupId);
      if (!(await botIsAdmin(client, chat))) {
        item.status = 'failed';
        item.error = 'Bot is no longer admin in target group.';
        logLine(`[${sessionNameValue}] schedule ${item.id} failed: ${item.error}`);
      } else {
        await client.sendMessage(item.groupId, item.message);
        item.status = 'sent';
        item.sentAt = Date.now();
        logLine(`[${sessionNameValue}] schedule ${item.id} sent`);
      }
    } catch (e) {
      item.status = 'failed';
      item.error = e.message;
      logLine(`[${sessionNameValue}] schedule ${item.id} failed: ${e.message}`);
    }

    changed = true;
  }

  if (changed) saveSchedules();
}

function startScheduleLoop(client, sessionNameValue) {
  if (scheduleIntervals[sessionNameValue]) return;
  scheduleIntervals[sessionNameValue] = setInterval(() => {
    sendDueSchedules(client, sessionNameValue).catch(e => logLine(`Schedule error (${sessionNameValue}): ${e.message}`));
  }, 10000);
}

async function handleAntispam(client, msg, g) {
  const currentChatId = chatId(msg);
  if (!g.antispam || !currentChatId.includes('@g.us')) return false;
  if (await isGroupAdmin(msg)) return false;

  const sender = activeSenderId(msg);
  const key = `${currentChatId}:${sender}`;
  const now = Date.now();
  const windowMs = g.spamSeconds * 1000;

  if (!spamBuckets[key]) spamBuckets[key] = [];
  spamBuckets[key] = spamBuckets[key].filter(time => now - time <= windowMs);
  spamBuckets[key].push(now);

  if (spamBuckets[key].length < g.spamLimit) return false;

  await deleteAsBot(msg);

  if (!lastAutoWarn[key] || now - lastAutoWarn[key] > 10000) {
    lastAutoWarn[key] = now;
    await warnUser(client, msg, sender, 'Stop spamming. Your message was deleted.');
  }

  return true;
}

async function start(name) {
  if (shuttingDown) return null;
  if (clients[name]) return clients[name];

  sessionSettings(name);
  fs.mkdirSync(AUTH_DATA_PATH, { recursive: true });
  removeStaleBrowserLocks(name);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: name, dataPath: AUTH_DATA_PATH }),
    takeoverOnConflict: true,
    takeoverTimeoutMs: 30000,
    puppeteer: {
      headless: true,
      executablePath: PUPPETEER_EXECUTABLE_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking'
      ]
    }
  });

  clients[name] = client;

  client.on('qr', qr => {
    lastSessionQr[name] = qr;
    logLine(`Scan QR (${name})`);
    qrcode.generate(qr, { small: true });
  });

  client.on('code', code => {
    logLine(`[${name}] PAIRING CODE: ${code}`);
    logLine(`[${name}] Open WhatsApp > Linked devices > Link with phone number, then enter this code.`);
  });

  client.on('authenticated', () => {
    clearSessionRestart(name);
    logLine(`[${name}] AUTHENTICATED`);
  });

  client.on('auth_failure', message => {
    logLine(`[${name}] AUTH FAILURE: ${message || 'unknown reason'}. Auth files were kept; use .session qr ${name} or reset only this session if needed.`);
  });

  client.on('ready', () => {
    clearSessionRestart(name);
    const botId = client.info && client.info.wid && client.info.wid._serialized;
    const session = sessionSettings(name);
    const previousBotId = session.botId;
    if (botId && session.botId !== botId) {
      session.botId = botId;
      save(MEMORY_FILE, memory);
    }
    if (!ownerlock.primaryOwner && botId) {
      ownerlock.primaryOwner = botId;
      if (!ownerlock.owners.includes(botId)) ownerlock.owners.unshift(botId);
      saveOwnerlock();
      logLine(`[${name}] primary owner set to ${botId}`);
    }
    logLine(`[${name}] READY`);
    if (name !== 'main' && botId && previousBotId !== botId && !session.welcomeSentAt) {
      session.welcomeSentAt = Date.now();
      save(MEMORY_FILE, memory);
      const welcomeName = (client.info && client.info.pushname) || name;
      client.sendMessage(botId, sessionWelcomeText(welcomeName, name)).catch(e => logLine(`Session welcome failed (${name}): ${e.message}`));
    }
    startScheduleLoop(client, name);
    startPlanReminderLoop(client, name);
    startGhostStatusLoop(client, name);
    applyGhostLastSeenStatus(client, session, name).catch(e => logLine(`Ghost last-seen startup failed (${name}): ${e.message}`));
    sendDueSchedules(client, name).catch(e => logLine(`Schedule startup check failed (${name}): ${e.message}`));
  });

  client.on('disconnected', reason => {
    logLine(`[${name}] DISCONNECTED: ${reason || 'unknown'}`);
    stopScheduleLoop(name);
    stopGhostStatusLoop(name);
    if (clients[name] === client) delete clients[name];
    client.destroy().catch(e => logLine(`[${name}] disconnected cleanup failed: ${e.message}`));
    if (String(reason || '').toUpperCase() !== 'LOGOUT') {
      scheduleSessionRestart(name, reason || 'disconnected');
    } else {
      logLine(`[${name}] WhatsApp reported LOGOUT. This session needs manual relink.`);
    }
  });

  client.on('message', async msg => {
    try {
      const session = sessionSettings(name);

      if (await handleStatusUpdate(client, session, msg, name)) return;

      if (!msg.body && !msg.hasMedia) return;

      const messageId = msg.id && msg.id._serialized;
      if (messageId) {
        if (processedMessages.has(messageId)) return;
        processedMessages.add(messageId);
        if (processedMessages.size > 2000) processedMessages.clear();
      }

      const raw = msg.body || '';
      const text = raw.toLowerCase().trim();
      const botId = client.info && client.info.wid && client.info.wid._serialized;
      msg.__botId = botId;
      const from = chatId(msg);
      const isGroup = from.includes('@g.us');
      const sender = activeSenderId(msg);
      const u = user(sender);
      const g = isGroup ? group(from) : null;
      const displayName = u.nickname || 'baby';
      const mood = isGroup ? g.mood : session.mood;
      const mentionedIds = msg.mentionedIds || [];
      const isCommand = text.startsWith('.');
      const isSessionOwnerCommand = Boolean(msg.fromMe || (botId && sender === botId));
      const lease = sessionLeaseStats(name);

      if (isGroup && isKnownBotId(sender) && sender !== botId) {
        const senderLabel = await senderLogId(client, msg, sender);
        logLine(`[${name}] ignored group message from another bot session: ${senderLabel}`);
        return;
      }

      const primaryControlsGroup = isGroup && name !== 'main' && await primaryBotIsInGroup(msg, botId);
      if (primaryControlsGroup && (isCommand || !msg.fromMe)) {
        const senderLabel = await senderLogId(client, msg, sender);
        logLine(`[${name}] primary bot controls ${safeChatIdLabel(from)}; ignored ${isCommand ? 'command' : 'group message'} from ${senderLabel}`);
        return;
      }

      if (name !== 'main' && lease && lease.blocked && isCommand && !text.startsWith('.session ')) {
        const contact = await contactFor(client, sender);
        return msg.reply(subscriptionExpiredText(sender, lease.paused ? 'Paused' : 'Expired'), undefined, {
          mentions: contact ? [contact] : []
        });
      }

      cacheMessage(msg);
      trackMessage(msg);

      const logSender = await senderLogId(client, msg, sender);
      logLine(`[${name}] message from ${logSender}: ${raw.slice(0, 80) || `[${msg.type || 'media'}]`}`);

      if (isGroup && !isCommand && canCompleteWelcomeModeSetup(msg, from, g, sender)) {
        const selectedMode = welcomeModeFromInput(raw);
        if (!selectedMode) {
          if (msg.fromMe || isWelcomeModePromptText(raw)) return;
          return msg.reply(`${WELCOME_MODE_MENU}\n\nPlease reply with a valid number or mode name.`);
        }

        saveWelcomeModeSelection(g, selectedMode);
        return msg.reply(welcomeModeConfirmation(selectedMode));
      }

      if (text === '.allowinvite') {
        if (isGroup) return msg.reply('Send .allowinvite privately to the bot.');
        memory.inviteOptIns[sender] = {
          allowed: true,
          at: Date.now()
        };
        save(MEMORY_FILE, memory);
        return msg.reply('Invite permission saved. You can receive group invite links from this bot.');
      }

      if (text === '.stopinvite') {
        if (isGroup) return msg.reply('Send .stopinvite privately to the bot.');
        memory.inviteOptIns[sender] = {
          blocked: true,
          at: Date.now()
        };
        save(MEMORY_FILE, memory);
        return msg.reply('Invite permission removed. You will not receive invite links from this bot.');
      }

      if (isCommand && !isSessionOwnerCommand && !(isGroup && isAllowedBotAdmin(sender, from))) {
        logLine(`[${name}] ignored command from non-owner ${sender}: ${text}`);
        return;
      }

      if (isGroup && !isCommand && g.muted && g.muted[sender]) {
        if (g.muted[sender] > Date.now()) {
          await deleteAsBot(msg);
          return;
        }
        delete g.muted[sender];
        save(MEMORY_FILE, memory);
      }

      if (isGroup && !text.startsWith('.') && await handleAntispam(client, msg, g)) return;

      if (isGroup && g.antimention && !text.startsWith('.') && mentionedIds.length) {
        const taggedBot = Boolean(botId && mentionedIds.includes(botId));
        const massTagged = mentionedIds.length >= g.antimentionLimit;
        if ((taggedBot || massTagged) && !(await isGroupAdmin(msg))) {
          const reason = taggedBot
            ? 'Do not tag the bot without admin approval.'
            : `Do not mention many people. Limit is ${g.antimentionLimit}.`;
          await warnUser(client, msg, sender, reason);
          return;
        }
      }

      const saleKeyword = isGroup && g.antisale && !text.startsWith('.') ? saleKeywordDetected(raw) : null;
      if (saleKeyword) {
        if (await isGroupAdmin(msg)) return;
        const contact = await contactFor(client, sender);
        const senderName = await displayNameFor(client, sender);
        await msg.reply(antisaleDetailWarning(senderName, saleKeyword, sender), undefined, {
          mentions: contact ? [contact] : []
        });
        return;
      }

      if (isGroup && g.antibadword && !text.startsWith('.')) {
        const word = badwordDetected(g, raw);
        if (word) {
          logLine(`[${name}] anti-badword hit in ${from}: sender=${sender} word=${word} body=${raw.slice(0, 80)}`);
          if (msg.fromMe || sender === botId) return;
          const contact = await contactFor(client, sender);
          const senderName = await displayNameFor(client, sender);
          await deleteAsBot(msg).catch(e => logLine(`Anti-badword delete failed (${name}): ${e.message}`));
          await msg.reply(antibadwordWarning(senderName, word, sender), undefined, {
            mentions: contact ? [contact] : []
          }).catch(e => logLine(`Anti-badword reply failed (${name}): ${e.message}`));
          await warnUser(client, msg, sender, `Bad word detected: ${word}`).catch(e => logLine(`Anti-badword warn failed (${name}): ${e.message}`));
          return;
        }
      }

      if (isGroup && g.antifake && !text.startsWith('.') && !String(sender).startsWith(g.allowedPrefix)) {
        if (!(await isGroupAdmin(msg))) {
          await deleteAsBot(msg);
          await warnUser(client, msg, sender, `Only numbers starting with ${g.allowedPrefix} are allowed.`);
          return;
        }
      }

      if (isGroup && !text.startsWith('.') && !(await isGroupAdmin(msg))) {
        if (g.antiviewonce && (msg.isViewOnce || msg.type === 'view_once')) {
          const senderName = await displayNameFor(client, sender);
          await deleteAsBot(msg);
          await warnUser(client, msg, sender, `${senderName}, view once media is not allowed in this group.`);
          return;
        }

        const blocked =
          (g.antisticker && msg.type === 'sticker') ||
          (g.antidocument && msg.type === 'document') ||
          (g.antiforward && msg.isForwarded) ||
          (g.antimedia && msg.hasMedia);

        if (blocked) {
          await deleteAsBot(msg);
          await warnUser(client, msg, sender, 'This message type is not allowed here.');
          return;
        }
      }

      if (text === '.menu') {
        return msg.reply(`╔═══━━━── • ──━━━═══╗
✨ 𝙂𝙄𝙏𝙃𝙄𝙉𝙅𝙄 𝘽𝙊𝙏 ✨
『 𝐏𝐑𝐄𝐌𝐈𝐔𝐌 𝐌𝐄𝐍𝐔 』
╚═══━━━── • ──━━━═══╝

🌐 𝐒𝐭𝐮𝐝𝐲𝐍𝐞𝐬𝐭 𝐀𝐜𝐚𝐝𝐞𝐦𝐲
📚 Notes • Revision • Past Papers • Study Resources
🎓 Secondary School & University Materials
⚡ Fast Downloads • Smart Learning • Premium Experience

🔗 studynestacademy.com

━━━━━━━━━━━━━━━━━━

╭─❍ 「 🤖 AI & PRIVATE 」
│ ⌁ .ask question
│ ⌁ .chatbot pm on/off
│ ⌁ .chatbotgroup on/off
│ ⌁ .smart on/off
│ ⌁ .typing on/off
│ ⌁ .online on/off
│ ⌁ .summarize text
│ ⌁ .define word
╰───────────────❍

╭─❍ 「 🎭 PERSONALITY 」
│ ♡ .mood flirty
│ ♡ .mood soft
│ ♡ .mood teasing
│ ♡ .mood clingy
│ ♡ .mood jealous
│ ♡ .mood sweet
│ ♡ .mood sassy
│ ♡ .mood savage
│ ♡ .mood romantic
│ ♡ .mood funny
│ ♡ .mood loyal
│ ♡ .mood rude
│ ♡ .mood shy
│ ♡ .mood dramatic
│ ♡ .mood girlfriend
│ ♡ .mood bestie
│ ♡ .nickname yourname
│ ♡ .mynick
│ ♡ .persona custom
│ ♡ .persona reset
╰───────────────❍

╭─❍ 「 🎮 FUN & GAMES 」
│ ✦ .truth
│ ✦ .dare
│ ✦ .joke
│ ✦ .rate me
│ ✦ .ship @user1 @user2
│ ✦ .pickline
│ ✦ .roast
│ ✦ .confess
│ ✦ .8ball question
│ ✦ .wouldyourather
│ ✦ .lovequote
│ ✦ .fact
│ ✦ .riddle
│ ✦ .coinflip
│ ✦ .dice
│ ✦ .rps rock/paper/scissors
│ ✦ .quiz
│ ✦ .mathquiz
│ ✦ .numbergame
│ ✦ .scramble
│ ✦ .tictactoe @user
╰───────────────❍

╭─❍ 「 🎬 MEDIA 」
│ ➤ .sticker
│ ➤ .viewonce
│ ➤ .toimg
│ ➤ .tomp3
│ ➤ .tomp4
│ ➤ .play song
│ ➤ .play video
│ ➤ .ytmp3
│ ➤ .ytmp4
│ ➤ .qr text
╰───────────────❍

╭─❍ 「 📢 CONTACTS & INVITES 」
│ ➤ .savecontacts
│ ➤ .listcontacts
│ ➤ .invite 25
│ ➤ .inviteall
│ ➤ .invite status
│ ➤ .invite reset
│ ➤ .clearsaved
│ ➤ .stopinvite
╰───────────────❍

╭─❍ 「 🛡️ PROTECTION 」
│ ⚔️ .antilink
│ ⚔️ .antimention
│ ⚔️ .antispam
│ ⚔️ .antibadword
│ ⚔️ .antidelete
│ ⚔️ .antidelete inbox on/off
│ ⚔️ .antisale
│ ⚔️ .antiviewonce
│ ⚔️ .antiforeign
│ ⚔️ .antifake
│ ⚔️ .antiforward
│ ⚔️ .antisticker
│ ⚔️ .antimedia
│ ⚔️ .antidocument
╰───────────────❍

╭─❍ 「 🔧 MODERATION 」
│ ✧ .warn @user
│ ✧ .warns
│ ✧ .resetwarn @user
│ ✧ .setwarnlimit 3
│ ✧ .promote @user
│ ✧ .demote @user
│ ✧ .kick @user
│ ✧ .add 2547...
│ ✧ .mute @user 10m
│ ✧ .purge @user 30
│ ✧ .tagall
│ ✧ .hidetag message
│ ✧ .tagadmins
│ ✧ .group open
│ ✧ .group close
│ ✧ .group info
│ ✧ .group link
│ ✧ .revoke link
│ ✧ .welcome on/off
│ ✧ .setwelcome text
│ ✧ .goodbye on/off
│ ✧ .setbye text
│ ✧ .setname text
│ ✧ .setdesc text
│ ✧ .setpp
│ ✧ .delete
│ ✧ .deleteall @user
╰───────────────❍

╭─❍ 「 🔐 BOT ADMIN ACCESS 」
│ ⌁ .allowadmin @user
│ ⌁ .allowadmin global @user
│ ⌁ .removeadmin @user
│ ⌁ .removeadmin global @user
│ ⌁ .listadmins
╰───────────────❍

╭─❍ 「 📡 STATUS 」
│ ➤ .viewstatus on/off
│ ➤ .likestatus on/off
│ ➤ .reactstatus emoji
│ ➤ .ghoststatus on/off
│ ➤ .ghoststatus every 2h
│ ➤ .ghostlastseen +1d/-1d/now/off
│ ➤ .savestatus
│ ➤ .setstatus text
│ ➤ .autostatus on/off
╰───────────────❍

╭─❍ 「 👑 OWNER 」
│ ☁️ .ping
│ ☁️ .runtime
│ ☁️ .settings
│ ☁️ .active
│ ☁️ .ownerlock on/off
│ ☁️ .owner add @user
│ ☁️ .owner remove @user
│ ☁️ .owner list
│ ☁️ .restart
│ ☁️ .shutdown
│ ☁️ .logs
│ ☁️ .backup
│ ☁️ .restore
│ ☁️ .schedule groups
│ ☁️ .schedule add target | time | message
│ ☁️ .schedule list
│ ☁️ .schedule run
│ ☁️ .schedule cancel id
│ ☁️ .session list
│ ☁️ .session add name 12h/7d/10w/3m/unlimited
│ ☁️ .session status name
│ ☁️ .session extend name 12h/7d/10w/3m
│ ☁️ .session extendall 12h/7d/10w/3m
│ ☁️ .session broadcast message
│ ☁️ .session reduce name 12h/7d/10w/3m
│ ☁️ .session renew name unlimited
│ ☁️ .session pause name
│ ☁️ .session resume name
│ ☁️ .session cancel name
│ ☁️ .session remove name
│ ☁️ .session qr
│ ☁️ .session pair name 2547...
╰───────────────❍

━━━━━━━━━━━━━━━━━━
💎 𝐁𝐨𝐭 𝐇𝐨𝐬𝐭𝐢𝐧𝐠 𝐀𝐯𝐚𝐢𝐥𝐚𝐛𝐥𝐞
📞 +254 772 418884
━━━━━━━━━━━━━━━━━━`);
      }

      if (text === '.ping') return msg.reply(`Pong. Session ${name} is alive.`);
      if (text === '.runtime') return msg.reply(`Runtime: ${runtime()}`);
      if (text === '.settings') return msg.reply(settingsText(name, session, g));
      if (text === '.active' || text === '.toggles') return msg.reply(activeCommandsText(name, session, g));
      if (text === '.logs') return msg.reply(botLogs.slice(-25).join('\n') || 'No logs yet.');

      if (text === '.ownerlock on') {
        if (ownerlock.enabled && !(await requireOwnerAccess(msg))) return;
        ownerlock.enabled = true;
        if (!ownerlock.owners.length) ownerlock.owners.push(sender);
        saveOwnerlock();
        return msg.reply('Owner lock ON. Dangerous commands are now restricted.');
      }

      if (text === '.ownerlock off') {
        if (!(await requireOwnerAccess(msg))) return;
        ownerlock.enabled = false;
        saveOwnerlock();
        return msg.reply('Owner lock OFF.');
      }

      if (text.startsWith('.owner add ')) {
        if (!(await requireOwnerAccess(msg))) return;
        const target = ownerIdFromInput(msg, raw.slice(11));
        if (!target) return msg.reply('Use: .owner add @user or .owner add 2547...');
        if (!ownerlock.owners.includes(target)) ownerlock.owners.push(target);
        saveOwnerlock();
        return msg.reply(`Trusted owner added: *${await displayNameFor(client, target)}*`);
      }

      if (text.startsWith('.owner remove ')) {
        if (!(await requireOwnerAccess(msg))) return;
        const target = ownerIdFromInput(msg, raw.slice(14));
        if (!target) return msg.reply('Use: .owner remove @user or .owner remove 2547...');
        if (ownerlock.enabled && ownerlock.owners.length === 1 && ownerlock.owners[0] === target) {
          return msg.reply('Add another trusted owner before removing the last one, or run .ownerlock off first.');
        }
        ownerlock.owners = ownerlock.owners.filter(id => id !== target);
        saveOwnerlock();
        return msg.reply(`Trusted owner removed: *${await displayNameFor(client, target)}*`);
      }

      if (text === '.owner list') {
        if (!(await requireOwnerAccess(msg))) return;
        return msg.reply(ownerlock.owners.length ? ownerlock.owners.map(tag).join('\n') : 'No trusted owners saved.');
      }

      if (text.startsWith('.allowadmin')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const scope = botAdminScope(raw);
        if (scope === 'group' && !isGroup) return msg.reply('Use .allowadmin @user inside a group, or .allowadmin global @user.');
        const target = botAdminTargetFromInput(msg, raw.replace(/^\.allowadmin\s*/i, ''));
        if (!target) return msg.reply('Use: .allowadmin @user or .allowadmin global @user');
        const store = scope === 'global' ? ensureBotAdmins().global : groupBotAdmins(from);
        store[target] = {
          addedBy: sender,
          at: Date.now()
        };
        save(MEMORY_FILE, memory);
        return msg.reply(`${scope === 'global' ? 'Global' : 'Group'} bot admin allowed: *${await displayNameFor(client, target)}*`);
      }

      if (text.startsWith('.removeadmin')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const scope = botAdminScope(raw);
        if (scope === 'group' && !isGroup) return msg.reply('Use .removeadmin @user inside a group, or .removeadmin global @user.');
        const target = botAdminTargetFromInput(msg, raw.replace(/^\.removeadmin\s*/i, ''));
        if (!target) return msg.reply('Use: .removeadmin @user or .removeadmin global @user');
        const store = scope === 'global' ? ensureBotAdmins().global : groupBotAdmins(from);
        delete store[target];
        save(MEMORY_FILE, memory);
        return msg.reply(`${scope === 'global' ? 'Global' : 'Group'} bot admin removed: *${await displayNameFor(client, target)}*`);
      }

      if (text === '.listadmins') {
        if (!(await requireOwnerAccess(msg))) return;
        const botAdmins = ensureBotAdmins();
        const globalAdmins = Object.keys(botAdmins.global);
        const groupAdmins = isGroup ? Object.keys(groupBotAdmins(from)) : [];
        return msg.reply(
          `*Allowed Bot Admins*\n\n` +
          `Global:\n${globalAdmins.length ? globalAdmins.map(tag).join('\n') : 'None'}\n\n` +
          `This group:\n${groupAdmins.length ? groupAdmins.map(tag).join('\n') : 'None'}`
        );
      }

      if (text === '.restart') {
        if (!(await requireOwnerAccess(msg))) return;
        await msg.reply('Restarting. Use PM2/Task Scheduler so the process comes back automatically.');
        setTimeout(() => shutdownGracefully(2), 500);
        return;
      }

      if (text === '.shutdown') {
        if (!(await requireOwnerAccess(msg))) return;
        await msg.reply('Shutting down.');
        setTimeout(() => shutdownGracefully(0), 500);
        return;
      }

      if (text === '.backup') {
        if (!(await requireOwnerAccess(msg))) return;
        const backup = Buffer.from(JSON.stringify({ memory, sessions, ownerlock, schedules }, null, 2)).toString('base64');
        const media = new MessageMedia('application/json', backup, `githinji-backup-${Date.now()}.json`);
        return msg.reply(media);
      }

      if (text === '.restore') {
        if (!(await requireOwnerAccess(msg))) return;
        if (!msg.hasQuotedMsg) return msg.reply('Reply to a backup JSON file with .restore');
        const quoted = await msg.getQuotedMessage();
        if (!quoted.hasMedia) return msg.reply('Reply to a backup JSON file with .restore');
        const media = await quoted.downloadMedia();
        const data = JSON.parse(Buffer.from(media.data, 'base64').toString('utf8'));
        if (!data.memory || !data.sessions) return msg.reply('Invalid backup file.');
        memory = data.memory;
        sessions = data.sessions;
        ownerlock = data.ownerlock || { enabled: false, owners: [] };
        schedules = data.schedules || { schedules: [] };
        normalizeRuntimeState();
        save(MEMORY_FILE, memory);
        save(SESSION_FILE, sessions);
        saveOwnerlock();
        saveSchedules();
        return msg.reply('Backup restored. Restart the bot to reload all sessions cleanly.');
      }

      if (text === '.schedule groups') {
        if (!(await requireOwnerAccess(msg))) return;
        if (isGroup) return msg.reply('Use this command privately so group IDs are not exposed.');

        const groups = await listAdminGroups(client);
        if (!groups.length) return msg.reply('No groups found where this bot is admin.');

        const rows = groups.map((chat, index) => `${index + 1}. ${chat.name}\n${chat.id._serialized}`);
        return msg.reply(`*Admin Groups for Session ${name}*\n\n${rows.join('\n\n')}`);
      }

      if (text.startsWith('.schedule add ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (isGroup) return msg.reply('Schedule messages privately with the bot.');

        const parts = raw.slice(14).split('|').map(part => part.trim());
        if (parts.length < 3 || !parts[0] || !parts[1] || !parts.slice(2).join(' | ')) {
          return msg.reply('Use: .schedule add target | time | message\nExample: .schedule add 1 | 2026-05-01 14:30 | Meeting starts now\nRelative time also works: 10m, 2h, 1d');
        }

        const targetChat = await resolveScheduledGroup(client, parts[0]);
        if (!targetChat) return msg.reply('Target group not found, or bot is not admin there. Use .schedule groups first.');

        if (!(await botIsAdmin(client, targetChat))) {
          return msg.reply('The bot must be admin in the target group before scheduling messages there.');
        }

        const time = parseScheduleTime(parts[1]);
        if (!time || time <= Date.now()) return msg.reply('Invalid time. Use YYYY-MM-DD HH:mm or relative time like 10m, 2h, 1d.');

        const item = {
          id: scheduleId(),
          session: name,
          creator: sender,
          groupId: targetChat.id._serialized,
          groupName: targetChat.name,
          time,
          timeText: parts[1],
          timezone: SCHEDULE_TIMEZONE_LABEL,
          message: parts.slice(2).join(' | '),
          status: 'pending',
          createdAt: Date.now()
        };

        schedules.schedules.push(item);
        saveSchedules();

        return msg.reply(
          `Scheduled.\n` +
          `ID: ${item.id}\n` +
          `Group: ${item.groupName}\n` +
          `Time: ${formatScheduleTime(item.time)} (${SCHEDULE_TIMEZONE_LABEL})\n` +
          `Message: ${item.message}`
        );
      }

      if (text === '.schedule list') {
        if (!(await requireOwnerAccess(msg))) return;
        if (isGroup) return msg.reply('Use this command privately.');

        const mine = schedules.schedules
          .filter(item => item.session === name && item.status === 'pending')
          .sort((a, b) => a.time - b.time);

        if (!mine.length) return msg.reply('No pending scheduled messages for this session.');

        return msg.reply(mine.map(item =>
          `${item.id}\nGroup: ${item.groupName}\nTime: ${formatScheduleTime(item.time)} (${item.timezone || SCHEDULE_TIMEZONE_LABEL})\nStatus: ${item.status}\nMessage: ${item.message}`
        ).join('\n\n'));
      }

      if (text === '.schedule run') {
        if (!(await requireOwnerAccess(msg))) return;
        if (isGroup) return msg.reply('Use this command privately.');
        await sendDueSchedules(client, name);
        const pending = schedules.schedules.filter(item => item.session === name && item.status === 'pending').length;
        const failed = schedules.schedules.filter(item => item.session === name && item.status === 'failed').length;
        return msg.reply(`Schedule check complete.\nPending: ${pending}\nFailed: ${failed}\nCheck .logs if something failed.`);
      }

      if (text.startsWith('.schedule cancel ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (isGroup) return msg.reply('Use this command privately.');

        const id = raw.slice(17).trim();
        const item = schedules.schedules.find(scheduled => scheduled.id === id && scheduled.session === name);
        if (!item) return msg.reply('Schedule ID not found for this session.');
        if (item.status !== 'pending') return msg.reply(`Schedule is already ${item.status}.`);

        item.status = 'cancelled';
        item.cancelledAt = Date.now();
        saveSchedules();
        return msg.reply(`Cancelled schedule: ${id}`);
      }

      if (text === '.joke') return msg.reply(jokes());

      if (text === '.lovequote') {
        return msg.reply(rand([
          'Love is not finding someone perfect. It is choosing someone honestly.',
          'Real love feels calm, not confusing.',
          'A loyal heart is louder than sweet words.',
          'Love grows where respect stays.'
        ]));
      }

      if (text === '.fact') {
        return msg.reply(rand([
          'Honey never spoils when stored well.',
          'Octopuses have three hearts.',
          'Bananas are berries, but strawberries are not true berries.',
          'The shortest war in history lasted under an hour.'
        ]));
      }

      if (text === '.riddle') {
        return msg.reply(rand([
          'What has keys but no locks? A piano.',
          'What gets wetter as it dries? A towel.',
          'What has a neck but no head? A bottle.',
          'What can travel around the world while staying in a corner? A stamp.'
        ]));
      }

      if (text === '.coinflip') {
        return msg.reply(rand(['Heads', 'Tails']));
      }

      if (text === '.dice') {
        return msg.reply(`Dice rolled: ${Math.floor(Math.random() * 6) + 1}`);
      }

      if (text === '.truth') {
        return msg.reply(rand([
          'What is one secret you have never told this group?',
          'Who was your first serious crush?',
          'What is the most embarrassing text you ever sent?',
          'What is one thing you pretend not to care about?'
        ]));
      }

      if (text === '.dare') {
        return msg.reply(rand([
          'Send a voice note saying "I am the drama."',
          'Compliment the last person who texted here.',
          'Post your most used emoji.',
          'Text your crush "I have something to tell you" and wait 2 minutes.'
        ]));
      }

      if (text === '.rate me') {
        return msg.reply(`I rate you ${randomPercent()}%. Do not argue with a lady.`);
      }

      if (text.startsWith('.ship ')) {
        const people = mentionedIds.length >= 2 ? mentionedIds.slice(0, 2).map(tag) : raw.slice(6).trim().split(/\s+/).slice(0, 2);
        if (people.length < 2) return msg.reply('Mention two users: .ship @user1 @user2');
        return msg.reply(`${people[0]} + ${people[1]} = ${randomPercent()}% match.`);
      }

      if (text === '.pickline') {
        return msg.reply(rand([
          'Are you Wi-Fi? Because I feel connected.',
          'You must be a charger, because you give me energy.',
          'If charm was a crime, you would need bail.',
          'Are you a notification? Because I keep waiting for you.'
        ]));
      }

      if (text === '.roast') {
        return msg.reply(rand([
          'You have main character confidence with loading-screen performance.',
          'Your vibe is premium, but the subscription expired.',
          'You are not late. You are just buffering in real life.',
          'You bring peace... when you leave.'
        ]));
      }

      if (text === '.confess') {
        return msg.reply(rand([
          'Confession: I act busy but I still wait for your text.',
          'Confession: someone here is pretending not to like someone.',
          'Confession: I am dramatic because calm is boring.',
          'Confession: I remember more than I admit.'
        ]));
      }

      if (text.startsWith('.8ball')) {
        return msg.reply(rand([
          'Yes.',
          'No.',
          'Maybe, but do not rush it.',
          'Ask again when your confidence is higher.',
          'The signs say yes, but your timing says chaos.'
        ]));
      }

      if (text === '.wouldyourather') {
        return msg.reply(rand([
          'Would you rather lose your phone for a week or your best friend ignore you for a day?',
          'Would you rather be rich and lonely or broke with real love?',
          'Would you rather read minds or delete memories?',
          'Would you rather always be early or always be stylish?'
        ]));
      }

      if (text.startsWith('.rps')) {
        const pick = text.split(/\s+/)[1];
        const allowed = ['rock', 'paper', 'scissors'];
        if (!allowed.includes(pick)) return msg.reply('Use: .rps rock, .rps paper, or .rps scissors');
        const botPick = rand(allowed);
        const win = (pick === 'rock' && botPick === 'scissors') ||
          (pick === 'paper' && botPick === 'rock') ||
          (pick === 'scissors' && botPick === 'paper');
        const result = pick === botPick ? 'Draw' : win ? 'You win' : 'I win';
        return msg.reply(`You: ${pick}\nBot: ${botPick}\n${result}.`);
      }

      if (text === '.quiz') {
        const qs = [
          ['What is the capital of Kenya?', 'Nairobi'],
          ['How many days are in a leap year?', '366'],
          ['Which planet is known as the red planet?', 'Mars'],
          ['What language runs in Node.js?', 'JavaScript']
        ];
        const q = rand(qs);
        return msg.reply(`${q[0]}\nAnswer: ${q[1]}`);
      }

      if (text === '.mathquiz') {
        const a = Math.floor(Math.random() * 20) + 1;
        const b = Math.floor(Math.random() * 20) + 1;
        return msg.reply(`${a} + ${b} = ${a + b}`);
      }

      if (text === '.numbergame') {
        return msg.reply(`Guess number game: my number is ${Math.floor(Math.random() * 10) + 1}.`);
      }

      if (text === '.scramble') {
        const words = ['loyal', 'githinji', 'whatsapp', 'romantic', 'session'];
        const word = rand(words);
        const mixed = word.split('').sort(() => Math.random() - 0.5).join('');
        return msg.reply(`Unscramble: ${mixed}\nAnswer: ${word}`);
      }

      if (text.startsWith('.tictactoe')) {
        const target = firstMention(msg);
        if (!target) return msg.reply('Use: .tictactoe @user');
        const key = `${from}:tictactoe`;
        games[key] = { players: [sender, target], board: Array(9).fill(null), turn: sender };
        const senderName = await displayNameFor(client, sender);
        const targetName = await displayNameFor(client, target);
        const senderContact = await contactFor(client, sender);
        const targetContact = await contactFor(client, target);
        return msg.reply(`TicTacToe started: *${senderName}* vs *${targetName}*\nUse positions 1-9.`, undefined, {
          mentions: [senderContact, targetContact].filter(Boolean)
        });
      }

      if (text.startsWith('.play ')) {
        const q = raw.slice(6).trim();
        if (!q) return msg.reply('Write a song name after .play');
        if (q.toLowerCase().startsWith('video ')) return sendVideo(msg, q.slice(6).trim());
        return sendSong(msg, q);
      }

      if (text.startsWith('.ytmp3 ')) {
        const q = raw.slice(7).trim();
        if (!q) return msg.reply('Write a song name after .ytmp3');
        return sendSong(msg, q);
      }

      if (text.startsWith('.ytmp4 ') || text.startsWith('.play video ')) {
        const q = raw.replace(/^(\.ytmp4|\.play video)\s+/i, '').trim();
        if (!q) return msg.reply('Write a video name.');
        return sendVideo(msg, q);
      }

      if (text.startsWith('.qr ')) {
        const dataUrl = await qrImage.toDataURL(raw.slice(4).trim());
        const media = new MessageMedia('image/png', dataUrl.split(',')[1], 'qr.png');
        return msg.reply(media);
      }

      if (text.startsWith('.ai ') || text.startsWith('.ask ') || text.startsWith('.gpt ')) {
        const prompt = raw.replace(/^\.(ai|ask|gpt)\s+/i, '').trim();
        if (!prompt) return msg.reply('Write a question after .ai');
        return msg.reply(await localAiReply(displayName, prompt, mood, session.persona));
      }

      if (text.startsWith('.readmore ')) {
        return msg.reply(readMore(raw.slice(10).trim()));
      }

      if (text.startsWith('.define ')) {
        return msg.reply(await defineWord(raw.slice(8).trim()));
      }

      if (text.startsWith('.summarize ')) {
        return msg.reply(simpleSummary(raw.slice(11).trim()));
      }

      if (text === '.chatbot pm on' || text === '.autoreply pm on') {
        session.pm = true;
        save(MEMORY_FILE, memory);
        return msg.reply(`PM chatbot ON for session ${name}.`);
      }

      if (text === '.chatbot pm off' || text === '.autoreply pm off') {
        session.pm = false;
        save(MEMORY_FILE, memory);
        return msg.reply(`PM chatbot OFF for session ${name}.`);
      }

      if (text === '.reply on') {
        session.pm = true;
        save(MEMORY_FILE, memory);
        return msg.reply('Reply mode ON.');
      }

      if (text === '.reply off') {
        session.pm = false;
        save(MEMORY_FILE, memory);
        return msg.reply('Reply mode OFF.');
      }

      if (text === '.away on' || text === '.away off') {
        session.away = text.endsWith(' on');
        save(MEMORY_FILE, memory);
        return msg.reply(`Away mode ${session.away ? 'ON' : 'OFF'}.`);
      }

      if (text === '.smart on' || text === '.smart off') {
        session.smart = text.endsWith(' on');
        save(MEMORY_FILE, memory);
        return msg.reply(`Smart replies ${session.smart ? 'ON' : 'OFF'}.`);
      }

      if (text === '.typing on' || text === '.typing off') {
        session.typing = text.endsWith(' on');
        save(MEMORY_FILE, memory);
        return msg.reply(`Typing presence ${session.typing ? 'ON' : 'OFF'}.`);
      }

      if (text === '.autoreact on' || text === '.autoreact off') {
        session.autoreact = text.endsWith(' on');
        save(MEMORY_FILE, memory);
        return msg.reply(`Auto-react ${session.autoreact ? 'ON' : 'OFF'}.`);
      }

      if (text === '.online on' || text === '.online off') {
        session.online = text.endsWith(' on');
        save(MEMORY_FILE, memory);
        if (session.online) await client.sendPresenceAvailable().catch(() => {});
        else await client.sendPresenceUnavailable().catch(() => {});
        return msg.reply(`Online presence ${session.online ? 'ON' : 'OFF'}.`);
      }

      if (text.startsWith('.setstatus ')) {
        const nextStatus = raw.slice(11).trim();
        if (!nextStatus) return msg.reply('Write status text after .setstatus');
        session.statusText = nextStatus;
        save(MEMORY_FILE, memory);
        await client.setStatus(nextStatus).catch(e => {
          logLine(`Status set failed (${name}): ${e.message}`);
        });
        return msg.reply(`Status updated:\n${nextStatus}`);
      }

      if (text === '.autostatus on' || text === '.autostatus off') {
        session.autostatus = text.endsWith(' on');
        save(MEMORY_FILE, memory);
        if (session.autostatus && session.statusText) {
          await client.setStatus(session.statusText).catch(e => {
            logLine(`Auto-status set failed (${name}): ${e.message}`);
          });
        }
        return msg.reply(`Auto-status ${session.autostatus ? 'ON' : 'OFF'}.`);
      }

      if (text === '.viewstatus on' || text === '.viewstatus off' || text === '.statusview on' || text === '.statusview off') {
        session.statusview = text.endsWith(' on');
        save(MEMORY_FILE, memory);
        return msg.reply(`Status auto-view ${session.statusview ? 'ON' : 'OFF'}.`);
      }

      if (text === '.likestatus on' || text === '.likestatus off' || text === '.statuslike on' || text === '.statuslike off') {
        session.statuslike = text.endsWith(' on');
        if (session.statuslike) session.statusview = true;
        save(MEMORY_FILE, memory);
        return msg.reply(`Status auto-like ${session.statuslike ? 'ON' : 'OFF'}.${session.statuslike ? ' Auto-view is ON too.' : ''}`);
      }

      if (text.startsWith('.reactstatus ')) {
        session.statusReact = raw.slice(13).trim() || '💗';
        save(MEMORY_FILE, memory);
        return msg.reply(`Status reaction set to ${session.statusReact}.`);
      }

      if (text === '.ghoststatus on' || text === '.ghoststatus off') {
        session.ghostStatus = text.endsWith(' on');
        if (!session.ghostStatusIntervalMs) session.ghostStatusIntervalMs = DEFAULT_GHOST_STATUS_INTERVAL_MS;
        save(MEMORY_FILE, memory);
        if (session.ghostStatus) startGhostStatusLoop(client, name);
        else stopGhostStatusLoop(name);
        return msg.reply(
          `Ghost status ${session.ghostStatus ? 'ON' : 'OFF'}.` +
          (session.ghostStatus ? ` Viewing cycle: every ${formatDurationShort(session.ghostStatusIntervalMs)}.` : '')
        );
      }

      if (text.startsWith('.ghoststatus every ')) {
        const value = raw.replace(/^\.ghoststatus\s+every\s+/i, '').trim();
        const duration = parseDuration(value);
        if (!duration || duration < MIN_GHOST_STATUS_INTERVAL_MS) {
          return msg.reply('Use: .ghoststatus every 2h\nMinimum interval is 5m.');
        }
        session.ghostStatus = true;
        session.ghostStatusIntervalMs = duration;
        save(MEMORY_FILE, memory);
        startGhostStatusLoop(client, name);
        return msg.reply(`Ghost status ON. Viewing cycle: every ${formatDurationShort(duration)}.`);
      }

      if (text === '.ghoststatus run') {
        session.ghostStatus = true;
        save(MEMORY_FILE, memory);
        await runGhostStatusView(client, name);
        startGhostStatusLoop(client, name);
        return msg.reply('Ghost status view cycle ran now.');
      }

      if (text.startsWith('.ghostlastseen ')) {
        const value = raw.replace(/^\.ghostlastseen\s+/i, '').trim().toLowerCase();
        if (value === 'off') {
          session.ghostLastSeenMode = 'off';
          session.ghostLastSeenOffsetMs = 0;
          session.ghostLastSeenText = null;
          save(MEMORY_FILE, memory);
          return msg.reply('Ghost last-seen display OFF.');
        }
        if (value === 'now') {
          session.ghostLastSeenMode = 'now';
          session.ghostLastSeenOffsetMs = 0;
        } else {
          const match = value.match(/^([+-])\s*(\d+\s*[smhd])$/i);
          const duration = match ? parseDuration(match[2]) : null;
          if (!duration) return msg.reply('Use: .ghostlastseen +1d, .ghostlastseen -2h, .ghostlastseen now, or .ghostlastseen off');
          session.ghostLastSeenMode = 'offset';
          session.ghostLastSeenOffsetMs = match[1] === '-' ? -duration : duration;
        }
        const textToApply = ghostLastSeenText(session);
        session.ghostLastSeenText = textToApply;
        save(MEMORY_FILE, memory);
        await applyGhostLastSeenStatus(client, session, name);
        save(MEMORY_FILE, memory);
        return msg.reply(`Ghost last-seen display updated:\n${textToApply}`);
      }

      if (text === '.antidelete inbox on' || text === '.antidelete inbox off' || text === '.inboxantidelete on' || text === '.inboxantidelete off') {
        session.antideleteInbox = text.endsWith(' on');
        save(MEMORY_FILE, memory);
        return msg.reply(`Inbox antidelete ${session.antideleteInbox ? 'ON' : 'OFF'}. Deleted private messages will be reported to this bot inbox.`);
      }

      if (text === '.chatbot group on' || text === '.chatbotgroup on') {
        if (!(await requireGroupAdmin(msg))) return;
        g.chatbot = true;
        save(MEMORY_FILE, memory);
        return msg.reply('Group chatbot ON.');
      }

      if (text === '.chatbot group off' || text === '.chatbotgroup off') {
        if (!(await requireGroupAdmin(msg))) return;
        g.chatbot = false;
        save(MEMORY_FILE, memory);
        return msg.reply('Group chatbot OFF.');
      }

      if (text === '.autoreply on') {
        if (isGroup) {
          if (!(await requireGroupAdmin(msg))) return;
          g.autoreply = true;
          save(MEMORY_FILE, memory);
          return msg.reply('Feminine autoreply ON for this group.');
        }

        session.pm = true;
        save(MEMORY_FILE, memory);
        return msg.reply(`Feminine autoreply ON for session ${name}.`);
      }

      if (text === '.autoreply off') {
        if (isGroup) {
          if (!(await requireGroupAdmin(msg))) return;
          g.autoreply = false;
          save(MEMORY_FILE, memory);
          return msg.reply('Feminine autoreply OFF for this group.');
        }

        session.pm = false;
        save(MEMORY_FILE, memory);
        return msg.reply(`Feminine autoreply OFF for session ${name}.`);
      }

      if (text.startsWith('.autoreply add ')) {
        if (!(await requireGroupAdmin(msg))) return;
        const parts = raw.slice(15).split('|').map(part => part.trim());
        if (parts.length < 2 || !parts[0] || !parts[1]) {
          return msg.reply('Use: .autoreply add trigger | reply text');
        }

        g.customReplies = g.customReplies.filter(item => item.trigger.toLowerCase() !== parts[0].toLowerCase());
        g.customReplies.push({ trigger: parts[0], reply: parts.slice(1).join(' | ') });
        save(MEMORY_FILE, memory);
        return msg.reply('Custom autoreply saved. Use {name} or @user inside the reply.');
      }

      if (text.startsWith('.autoreply remove ')) {
        if (!(await requireGroupAdmin(msg))) return;
        const trigger = raw.slice(18).trim();
        if (!trigger) return msg.reply('Use: .autoreply remove trigger');

        const before = g.customReplies.length;
        g.customReplies = g.customReplies.filter(item => item.trigger.toLowerCase() !== trigger.toLowerCase());
        save(MEMORY_FILE, memory);
        return msg.reply(before === g.customReplies.length ? 'No matching autoreply found.' : 'Custom autoreply removed.');
      }

      if (text === '.autoreply list') {
        if (!isGroup) return msg.reply('Custom autoreplies are group settings.');
        const rows = g.customReplies.map(item => `${item.trigger} => ${item.reply}`).join('\n');
        return msg.reply(rows || 'No custom autoreplies saved.');
      }

      if (text === '.mood list') {
        return msg.reply(MOOD_COMMANDS.join('\n'));
      }

      if (text === '.mood') {
        return msg.reply(`Current mood: ${mood}`);
      }

      if (text.startsWith('.mood ')) {
        const parts = text.split(/\s+/);
        const requestedMood = parts[1];
        const toggle = parts[2];
        if (!MOODS.includes(requestedMood)) return msg.reply(`Use one of:\n${MOOD_COMMANDS.join('\n')}`);
        if (toggle && !['on', 'off'].includes(toggle)) return msg.reply(`Use .mood ${requestedMood} on or .mood ${requestedMood} off.`);

        const nextMood = toggle === 'off' ? 'normal' : requestedMood;

        if (isGroup) {
          if (!(await requireGroupAdmin(msg))) return;
          g.mood = nextMood;
        } else {
          session.mood = nextMood;
        }

        save(MEMORY_FILE, memory);
        if (toggle === 'off') return msg.reply(`${requestedMood} mood OFF. Mood set to normal.`);
        return msg.reply(`${nextMood} mood ON.`);
      }

      if (text === '.persona status') {
        return msg.reply(session.persona || 'No custom persona set.');
      }

      if (text === '.persona reset') {
        session.persona = null;
        save(MEMORY_FILE, memory);
        return msg.reply('Persona reset.');
      }

      if (text.startsWith('.persona custom ')) {
        session.persona = raw.slice(16).trim();
        save(MEMORY_FILE, memory);
        return msg.reply('Custom persona saved.');
      }

      if (text === '.antilink on') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antilink = true;
        save(MEMORY_FILE, memory);
        return msg.reply('Anti-link ON.');
      }

      if (text === '.antilink off') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antilink = false;
        save(MEMORY_FILE, memory);
        return msg.reply('Anti-link OFF.');
      }

      if (text === '.antimention on') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antimention = true;
        save(MEMORY_FILE, memory);
        return msg.reply(`Anti-mention ON. Current limit: ${g.antimentionLimit} mentions.`);
      }

      if (text === '.antimention off') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antimention = false;
        save(MEMORY_FILE, memory);
        return msg.reply('Anti-mention OFF.');
      }

      if (text.startsWith('.antimention limit ')) {
        if (!(await requireGroupAdmin(msg))) return;
        const limit = Number(text.split(/\s+/)[2]);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) return msg.reply('Use a number from 1 to 50.');
        g.antimentionLimit = limit;
        save(MEMORY_FILE, memory);
        return msg.reply(`Anti-mention limit set to ${limit}.`);
      }

      if (text === '.antisale on') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antisale = true;
        save(MEMORY_FILE, memory);
        return msg.reply('Anti-sale ON.');
      }

      if (text === '.antisale off') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antisale = false;
        save(MEMORY_FILE, memory);
        return msg.reply('Anti-sale OFF.');
      }

      if (text === '.antiforeign on' || text === '.antiforeign off') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antiforeign = text.endsWith(' on');
        g.antifake = g.antiforeign;
        save(MEMORY_FILE, memory);
        return msg.reply(`Anti-foreign ${g.antiforeign ? 'ON' : 'OFF'}. Only Kenyan numbers starting with +254 are allowed.`);
      }

      if (text === '.antispam on') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antispam = true;
        save(MEMORY_FILE, memory);
        return msg.reply(`Anti-spam ON. Limit: ${g.spamLimit} messages in ${g.spamSeconds} seconds.`);
      }

      if (text === '.antispam off') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antispam = false;
        save(MEMORY_FILE, memory);
        return msg.reply('Anti-spam OFF.');
      }

      if (text.startsWith('.antispam set ')) {
        if (!(await requireGroupAdmin(msg))) return;
        const parts = text.split(/\s+/);
        const limit = Number(parts[2]);
        const seconds = Number(parts[3]);
        if (!Number.isInteger(limit) || !Number.isInteger(seconds) || limit < 2 || seconds < 2) {
          return msg.reply('Use: .antispam set 5 7');
        }

        g.spamLimit = limit;
        g.spamSeconds = seconds;
        save(MEMORY_FILE, memory);
        return msg.reply(`Anti-spam set to ${limit} messages in ${seconds} seconds.`);
      }

      if (text === '.antibadword on' || text === '.antibadword off') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antibadword = text.endsWith(' on');
        if (g.antibadword && (!Array.isArray(g.badwords) || !g.badwords.filter(Boolean).length)) {
          g.badwords = [...DEFAULT_BADWORDS];
          g.badwordsVersion = BADWORDS_VERSION;
        }
        save(MEMORY_FILE, memory);
        return msg.reply(`Anti-badword ${g.antibadword ? 'ON' : 'OFF'}.`);
      }

      const protectionSwitches = {
        '.antifake': 'antifake',
        '.antiviewonce': 'antiviewonce',
        '.antiforward': 'antiforward',
        '.antisticker': 'antisticker',
        '.antimedia': 'antimedia',
        '.antidocument': 'antidocument'
      };

      for (const [command, key] of Object.entries(protectionSwitches)) {
        if (text === `${command} on` || text === `${command} off`) {
          if (!(await requireGroupAdmin(msg))) return;
          g[key] = text.endsWith(' on');
          save(MEMORY_FILE, memory);
          return msg.reply(`${command.slice(1)} ${g[key] ? 'ON' : 'OFF'}.`);
        }
      }

      if (text === '.antidelete on') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antidelete = true;
        save(MEMORY_FILE, memory);
        return msg.reply('Anti-delete ON.');
      }

      if (text === '.antidelete off') {
        if (!(await requireGroupAdmin(msg))) return;
        g.antidelete = false;
        save(MEMORY_FILE, memory);
        return msg.reply('Anti-delete OFF.');
      }

      if (isGroup && g.antilink && /(https?:\/\/|chat\.whatsapp\.com\/)/i.test(raw)) {
        if (!(await isGroupAdmin(msg))) {
          await deleteAsBot(msg);
          await warnUser(client, msg, sender, 'Links are not allowed in this group.');
        }
        return;
      }

      if (text.startsWith('.nickname ')) {
        u.nickname = raw.slice(10).trim();
        save(MEMORY_FILE, memory);
        return msg.reply('Nickname saved.');
      }

      if (text === '.mynick') {
        return msg.reply(u.nickname || 'No nickname');
      }

      if (text === '.tagall') {
        if (!(await requireGroupAdmin(msg))) return;

        const chat = await msg.getChat();
        const mentions = await Promise.all(
          chat.participants.map(p => client.getContactById(p.id._serialized))
        );
        const tags = chat.participants.map(p => `@${p.id.user}`).join(' ');

        return chat.sendMessage(tags || 'No members found.', { mentions });
      }

      if (text.startsWith('.kick')) {
        if (!(await requireGroupAdmin(msg))) return;

        const targets = await targetsFromMentionsReplyOrNumbers(msg, raw.slice(5));
        if (!targets.length) return msg.reply('Mention, reply to, or type the number of the user you want to kick.');

        const chat = await msg.getChat();
        const botId = client.info && client.info.wid && client.info.wid._serialized;
        const sender = activeSenderId(msg);
        const members = new Set((chat.participants || []).map(p => p.id && p.id._serialized).filter(Boolean));
        const removable = targets.filter(target => target !== botId && target !== sender && members.has(target));
        const skipped = targets.length - removable.length;
        if (!removable.length) return msg.reply('I could not find removable group members in your selection.');

        const removed = [];
        const failed = [];
        try {
          await chat.removeParticipants(removable);
          removed.push(...removable);
        } catch (e) {
          for (const target of removable) {
            try {
              await chat.removeParticipants([target]);
              removed.push(target);
              await sleep(600);
            } catch (err) {
              failed.push(target);
            }
          }
        }

        if (removed.length && failed.length) {
          return msg.reply(`Removed ${removed.length} user(s). Failed ${failed.length}. Skipped ${skipped}. Failed users may be admins, already gone, or WhatsApp blocked the action.`);
        }

        if (removed.length) return msg.reply(`Removed ${removed.length} user(s).${skipped ? ` Skipped ${skipped}.` : ''}`);
        return msg.reply('Could not remove the selected user(s). They may be admins, already gone, or WhatsApp blocked the action.');
      }

      if (text.startsWith('.mute ')) {
        if (!(await requireGroupAdmin(msg))) return;

        const target = await targetFromMentionOrReply(msg);
        const durationText = raw.trim().split(/\s+/).pop();
        const duration = parseDuration(durationText);
        if (!target || !duration) return msg.reply('Use: .mute @user 10m');

        g.muted[target] = Date.now() + duration;
        save(MEMORY_FILE, memory);
        const targetName = await displayNameFor(client, target);
        const targetContact = await contactFor(client, target);
        return msg.reply(`*${targetName}* muted for ${durationText}. Their messages will be deleted until time ends.`, undefined, {
          mentions: targetContact ? [targetContact] : []
        });
      }

      if (text.startsWith('.add ') && !text.startsWith('.add session ')) {
        if (!(await requireGroupAdmin(msg))) return;

        const target = normalizeNumber(raw.slice(5));
        if (!target) return msg.reply('Write a phone number after .add');

        const chat = await msg.getChat();
        if (!(await botIsAdmin(client, chat))) {
          return msg.reply('Make the bot a group admin first so it can add people.');
        }

        const [outcome] = await tryAddParticipantBatch(chat, [target]);
        if (outcome && outcome.added) return msg.reply('User added, or WhatsApp accepted the add request.');

        try {
          const code = await chat.getInviteCode();
          await client.sendMessage(target, `You are invited to join ${chat.name || 'this group'}:\nhttps://chat.whatsapp.com/${code}`);
          return msg.reply('Direct add was blocked by WhatsApp, so I sent the user the group invite link privately.');
        } catch (e) {
          return msg.reply(`Could not add or invite that number. WhatsApp may block adding privacy-protected numbers, or the number may not be on WhatsApp.\nReason: ${(outcome && outcome.message) || e.message}`);
        }
      }

      if (text.startsWith('.promote')) {
        if (!(await requireGroupAdmin(msg))) return;

        const target = await targetFromMentionOrReply(msg);
        if (!target) return msg.reply('Mention or reply to the user you want to promote.');

        const chat = await msg.getChat();
        await chat.promoteParticipants([target]);
        return msg.reply('User promoted.');
      }

      if (text.startsWith('.demote')) {
        if (!(await requireGroupAdmin(msg))) return;

        const target = await targetFromMentionOrReply(msg);
        if (!target) return msg.reply('Mention or reply to the user you want to demote.');

        const chat = await msg.getChat();
        await chat.demoteParticipants([target]);
        return msg.reply('User demoted.');
      }

      if (text === '.group close') {
        if (!(await requireGroupAdmin(msg))) return;

        const chat = await msg.getChat();
        await chat.setMessagesAdminsOnly(true);
        return msg.reply('Group closed. Only admins can send messages.');
      }

      if (text === '.mute') {
        if (!(await requireGroupAdmin(msg))) return;
        const chat = await msg.getChat();
        await chat.setMessagesAdminsOnly(true);
        return msg.reply('Group muted.');
      }

      if (text === '.group open') {
        if (!(await requireGroupAdmin(msg))) return;

        const chat = await msg.getChat();
        await chat.setMessagesAdminsOnly(false);
        return msg.reply('Group opened. Everyone can send messages.');
      }

      if (text === '.unmute') {
        if (!(await requireGroupAdmin(msg))) return;
        const chat = await msg.getChat();
        await chat.setMessagesAdminsOnly(false);
        return msg.reply('Group unmuted.');
      }

      if (text === '.group info') {
        if (!isGroup) return msg.reply('This command works in groups only.');
        const chat = await msg.getChat();
        const admins = chat.participants.filter(p => p.isAdmin).length;
        return msg.reply(
          `Name: ${chat.name}\n` +
          `Members: ${chat.participants.length}\n` +
          `Admins: ${admins}\n` +
          `Description: ${chat.description || 'No description'}`
        );
      }

      if (text === '.group link') {
        if (!(await requireGroupAdmin(msg))) return;
        const chat = await msg.getChat();
        const code = await chat.getInviteCode();
        return msg.reply(`https://chat.whatsapp.com/${code}`);
      }

      if (text === '.revoke link') {
        if (!(await requireGroupAdmin(msg))) return;
        const chat = await msg.getChat();
        const code = await chat.revokeInvite();
        return msg.reply(`New link: https://chat.whatsapp.com/${code}`);
      }

      if (text === '.savecontacts') {
        if (!(await requireGroupAdmin(msg))) return;
        const chat = await msg.getChat();
        const result = await saveGroupContacts(client, chat);
        return msg.reply(
          `Contacts saved.\n` +
          `New: ${result.added}\n` +
          `Skipped/updated: ${result.skipped}\n` +
          `Saved total: ${result.total}`
        );
      }

      if (text === '.listcontacts') {
        const total = savedContactList().length;
        const optedOut = savedContactList().filter(item => memory.inviteOptIns[item.id] && memory.inviteOptIns[item.id].blocked).length;
        return msg.reply(
          `Saved contacts: ${total}\n` +
          `Invite opted-out: ${optedOut}\n` +
          `Use .invite 50 or .inviteall in the target group. The bot tries direct add first, then sends invite links to people who cannot be added.`
        );
      }

      if (text === '.clearsaved') {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        memory.savedContacts = {};
        save(MEMORY_FILE, memory);
        return msg.reply('Saved contacts cleared.');
      }

      if (text === '.invite status') {
        if (!(await requireGroupAdmin(msg))) return;
        const chat = await msg.getChat();
        const candidateInfo = inviteCandidateList(chat, INVITE_MAX_PER_RUN);
        return msg.reply(
          `*Invite Status*\n\n` +
          `Saved contacts: ${candidateInfo.totalSaved}\n` +
          `Eligible now: ${candidateInfo.eligible}\n` +
          `Already in group: ${candidateInfo.alreadyInGroup}\n` +
          `Cooling down: ${candidateInfo.cooledDown}\n` +
          `Opted out: ${candidateInfo.optedOut}\n` +
          `Max per run: ${INVITE_MAX_PER_RUN}`
        );
      }

      if (text === '.invite reset') {
        if (!(await requireOwnerAccess(msg))) return;
        if (!isGroup) return msg.reply('Use .invite reset inside the group.');
        if (memory.inviteHistory) delete memory.inviteHistory[from];
        save(MEMORY_FILE, memory);
        return msg.reply('Invite cooldown history cleared for this group.');
      }

      if (text === '.inviteall' || /^\.invite(?:\s+\d+)?$/.test(text)) {
        const limit = parseInviteLimit(text);
        return runInviteFlow(client, msg, limit);
      }

      if (text.startsWith('.setdesc ')) {
        if (!(await requireGroupAdmin(msg))) return;
        const chat = await msg.getChat();
        await chat.setDescription(raw.slice(9).trim());
        return msg.reply('Group description updated.');
      }

      if (text.startsWith('.setname ')) {
        if (!(await requireGroupAdmin(msg))) return;
        const chat = await msg.getChat();
        await chat.setSubject(raw.slice(9).trim());
        return msg.reply('Group name updated.');
      }

      if (text === '.setpp') {
        if (!(await requireGroupAdmin(msg))) return;
        if (!msg.hasQuotedMsg) return msg.reply('Reply to an image with .setpp');
        const quoted = await msg.getQuotedMessage();
        if (!quoted.hasMedia) return msg.reply('Reply to an image with .setpp');
        const media = await quoted.downloadMedia();
        const chat = await msg.getChat();
        await chat.setPicture(media).catch(() => msg.reply('Could not set group picture.'));
        return msg.reply('Group picture updated.');
      }

      if (text.startsWith('.hidetag')) {
        if (!(await requireGroupAdmin(msg))) return;
        const chat = await msg.getChat();
        const hiddenText = raw.slice(8).trim() || ' ';
        const mentions = await Promise.all(
          chat.participants.map(p => client.getContactById(p.id._serialized))
        );
        return chat.sendMessage(hiddenText, { mentions });
      }

      if (text === '.tagadmins' || text === '.admins') {
        if (!isGroup) return msg.reply('This command works in groups only.');
        const chat = await msg.getChat();
        const admins = chat.participants.filter(p => p.isAdmin);
        const mentions = await Promise.all(admins.map(p => client.getContactById(p.id._serialized)));
        const tags = admins.map(p => `@${p.id.user}`).join(' ');
        return chat.sendMessage(tags || 'No admins found.', { mentions });
      }

      if (text === '.owner') {
        if (!isGroup) return msg.reply('This command works in groups only.');
        const chat = await msg.getChat();
        const ownerId = chat.owner && chat.owner._serialized;
        if (!ownerId) return msg.reply('Could not detect group owner.');
        return msg.reply(`Group owner: ${tag(ownerId)}`, undefined, {
          mentions: [await client.getContactById(ownerId)]
        });
      }

      if (text === '.botadmin') {
        if (!isGroup) return msg.reply('This command works in groups only.');
        const chat = await msg.getChat();
        const bot = client.info && client.info.wid && client.info.wid._serialized;
        const participant = chat.participants.find(p => p.id._serialized === bot);
        return msg.reply(participant && participant.isAdmin ? 'Bot is admin.' : 'Bot is not admin.');
      }

      if (text === '.delete') {
        if (!(await requireGroupAdmin(msg))) return;
        if (!msg.hasQuotedMsg) return msg.reply('Reply to a message with .delete');

        const quoted = await msg.getQuotedMessage();
        await deleteAsBot(quoted);
        return;
      }

      if (text.startsWith('.deleteall') || text.startsWith('.deluser')) {
        if (!(await requireGroupAdmin(msg))) return;

        const target = await targetFromMentionOrReply(msg);
        if (!target) return msg.reply('Mention or reply to the user whose tracked messages should be deleted.');

        const result = await deleteTrackedMessages(from, target);
        const targetName = await displayNameFor(client, target);
        return msg.reply(
          `Deleted ${result.deleted}/${result.total} tracked messages from *${targetName}*. ` +
          `Failed: ${result.failed}. I can only delete messages I saw while running and WhatsApp still allows.`
        );
      }

      if (text.startsWith('.purge')) {
        if (!(await requireGroupAdmin(msg))) return;

        const target = await targetFromMentionOrReply(msg);
        const amountText = raw.trim().split(/\s+/).pop();
        const amount = Number(amountText);
        if (!target || !Number.isInteger(amount) || amount < 1 || amount > 100) {
          return msg.reply('Use: .purge @user 30\nAmount must be from 1 to 100.');
        }

        const result = await deleteTrackedMessages(from, target, amount);
        const targetName = await displayNameFor(client, target);
        return msg.reply(
          `Purge complete for *${targetName}*.\n` +
          `Requested: ${amount}\n` +
          `Tracked found: ${result.total}\n` +
          `Deleted for everyone: ${result.deleted}\n` +
          `Failed: ${result.failed}\n\n` +
          `I can only delete messages I saw while running and WhatsApp still allows.`
        );
      }

      if (text === '.sticker') {
        const source = msg.hasQuotedMsg ? await msg.getQuotedMessage() : msg;
        if (!source.hasMedia) return msg.reply('Send or reply to an image/video with .sticker');

        const media = await source.downloadMedia();
        await msg.reply(media, undefined, {
          sendMediaAsSticker: true,
          stickerAuthor: 'Mboka Bot',
          stickerName: 'Sticker'
        });
        return;
      }

      if (text === '.viewonce') {
        const source = msg.hasQuotedMsg ? await msg.getQuotedMessage() : msg;
        if (!source.hasMedia) {
          return msg.reply(
            'I cannot access that view-once media from this message.\n\n' +
            'Use .viewonce by replying directly to the original view-once message before it expires. ' +
            'If WhatsApp has already hidden/opened it, whatsapp-web.js cannot download it.'
          );
        }

        const media = await source.downloadMedia().catch(e => {
          logLine(`View-once download failed (${name}): ${e.message}`);
          return null;
        });
        if (!media) {
          return msg.reply(
            'I could not open that view-once media.\n\n' +
            'WhatsApp often blocks bots from downloading view-once media after it has been opened, expired, or was sent by the same linked account.'
          );
        }

        media.filename = media.filename || `viewonce.${mediaExt(media)}`;
        return msg.reply(media, undefined, { caption: 'Opened view-once media.' });
      }

      if (text === '.savestatus' || text.startsWith('.savestatus ') || text === '.save status' || text.startsWith('.save status ')) {
        return saveStatusMediaForCommand(client, msg, raw);
      }

      if (text === '.toimg') {
        const media = await convertMessageMedia(msg, 'png', job => job.outputOptions('-frames:v 1'), 'image/png');
        if (!media) return msg.reply('Reply to a sticker/image/video with .toimg');
        return msg.reply(media);
      }

      if (text === '.tomp3') {
        const media = await convertMessageMedia(msg, 'mp3', job => job.noVideo().audioBitrate(128).format('mp3'), 'audio/mpeg');
        if (!media) return msg.reply('Reply to audio/video with .tomp3');
        media.filename = 'audio.mp3';
        return msg.reply(media);
      }

      if (text === '.tomp4') {
        const media = await convertMessageMedia(msg, 'mp4', job => job.videoCodec('libx264').audioCodec('aac').format('mp4'), 'video/mp4');
        if (!media) return msg.reply('Reply to media with .tomp4');
        media.filename = 'video.mp4';
        return msg.reply(media);
      }

      if (text.startsWith('.welcome ')) {
        if (!(await requireGroupAdmin(msg))) return;

        const arg = raw.slice(8).trim();
        const lowerArg = arg.toLowerCase();

        if (lowerArg === 'on') {
          g.pendingWelcomeModeSetup = { by: sender, at: Date.now() };
          save(MEMORY_FILE, memory);
          return msg.reply(`${WELCOME_MODE_MENU}\n\nTip: If plain number replies do not trigger on your linked device, send .welcome 1 or .welcome funny.`);
        }

        if (lowerArg === 'off') {
          g.welcomeOn = false;
          g.pendingWelcomeModeSetup = null;
          save(MEMORY_FILE, memory);
          return msg.reply('Welcome OFF.');
        }

        const modeInput = lowerArg.startsWith('on ')
          ? arg.slice(3).trim()
          : lowerArg.startsWith('mode ')
            ? arg.slice(5).trim()
            : arg;
        const selectedMode = welcomeModeFromInput(modeInput);
        if (!selectedMode) return msg.reply(WELCOME_MODE_MENU);

        saveWelcomeModeSelection(g, selectedMode);
        return msg.reply(welcomeModeConfirmation(selectedMode));
      }

      if (text === '.goodbye on' || text === '.goodbye off') {
        if (!(await requireGroupAdmin(msg))) return;
        g.goodbyeOn = text.endsWith(' on');
        save(MEMORY_FILE, memory);
        return msg.reply(`Goodbye ${g.goodbyeOn ? 'ON' : 'OFF'}.`);
      }

      if (text.startsWith('.setwelcome ')) {
        if (!(await requireGroupAdmin(msg))) return;

        g.welcome = raw.slice(12).trim();
        save(MEMORY_FILE, memory);
        return msg.reply('Welcome message saved. Use @user where the new member should be tagged.');
      }

      if (text.startsWith('.setbye ')) {
        if (!(await requireGroupAdmin(msg))) return;

        g.bye = raw.slice(8).trim();
        g.goodbye = g.bye;
        save(MEMORY_FILE, memory);
        return msg.reply('Bye message saved. Use @user where the member should be tagged.');
      }

      if (text.startsWith('.setgoodbye ')) {
        if (!(await requireGroupAdmin(msg))) return;

        g.goodbye = raw.slice(12).trim();
        g.bye = g.goodbye;
        save(MEMORY_FILE, memory);
        return msg.reply('Goodbye message saved. Use @user where the member should be tagged.');
      }

      if (text === '.bye') {
        if (!isGroup) return msg.reply('This command works in groups only.');
        return msg.reply(g.bye || 'No custom bye message set.');
      }

      if (text === '.warnlist' || text === '.warns') {
        if (!(await requireGroupAdmin(msg))) return;

        const list = memory.warns[from] || {};
        const rows = [];
        for (const [id, count] of Object.entries(list)) {
          if (count > 0) rows.push(`*${await displayNameFor(client, id)}*: ${count}`);
        }

        return msg.reply(rows.join('\n') || 'No warnings in this group.');
      }

      if (text.startsWith('.setwarnlimit ')) {
        if (!(await requireGroupAdmin(msg))) return;
        const limit = Number(text.split(/\s+/)[1]);
        if (!Number.isInteger(limit) || limit < 1 || limit > 10) return msg.reply('Use: .setwarnlimit 3');
        g.warnLimit = limit;
        save(MEMORY_FILE, memory);
        return msg.reply(`Warn limit set to ${limit}.`);
      }

      if (text === '.warn' || text.startsWith('.warn ')) {
        if (!(await requireGroupAdmin(msg))) return;

        const target = await targetFromMentionOrReply(msg);
        if (!target) return msg.reply('Mention or reply to the user you want to warn.');

        return warnUser(client, msg, target, 'Manual warning.');
      }

      if (text.startsWith('.resetwarn')) {
        if (!(await requireGroupAdmin(msg))) return;

        const target = await targetFromMentionOrReply(msg);
        if (!target) return msg.reply('Mention or reply to the user whose warnings you want to reset.');

        setWarns(from, target, 0);
        return msg.reply('Warnings reset.');
      }

      if (text.startsWith('.session add ') || text.startsWith('.add session ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const parsed = parseSessionLeaseInput(raw.slice(13));
        const nameToAdd = parsed && parsed.name;
        if (!nameToAdd) return msg.reply('Write a session name.');
        if (!parsed.durationMs && !parsed.unlimited) return msg.reply('Use: .session add name 12h, 7d, 10w, 3m, or unlimited');
        if (sessions.sessions.includes(nameToAdd)) return msg.reply('Session already exists.');

        sessions.sessions.push(nameToAdd);
        const nextSession = sessionSettings(nameToAdd);
        const now = Date.now();
        if (parsed.durationMs) {
          nextSession.leaseStartedAt = now;
          nextSession.leaseExpiresAt = now + parsed.durationMs;
          nextSession.leaseMs = parsed.durationMs;
          nextSession.leaseDays = parsed.days;
          nextSession.leasePaused = false;
          nextSession.createdBy = sender;
          resetLeaseReminders(nextSession);
        } else if (parsed.unlimited) {
          nextSession.leaseStartedAt = now;
          nextSession.leaseExpiresAt = null;
          nextSession.leaseMs = null;
          nextSession.leaseDays = null;
          nextSession.leasePaused = false;
          nextSession.createdBy = sender;
          resetLeaseReminders(nextSession);
        }
        save(SESSION_FILE, sessions);
        save(MEMORY_FILE, memory);
        start(nameToAdd);
        const planText = parsed.unlimited ? 'unlimited' : `${parsed.planLabel} (${formatDurationMs(parsed.durationMs)})`;
        return msg.reply(
          `Session ${nameToAdd} added for ${planText}.\n` +
          `Use .session pair ${nameToAdd} 2547... for a far user, or .session qr ${nameToAdd} for QR.`
        );
      }

      if (text.startsWith('.session extend ') || text.startsWith('.session renew ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const rawValue = raw.replace(/^\.session\s+(extend|renew)\s+/i, '');
        const parsed = parseSessionLeaseInput(rawValue);
        if (!parsed || (!parsed.durationMs && !parsed.unlimited)) return msg.reply('Use: .session extend name 12h, 7d, 10w, 3m or .session renew name unlimited');
        if (!sessions.sessions.includes(parsed.name)) return msg.reply('Session not found.');

        const targetSession = sessionSettings(parsed.name);
        const now = Date.now();
        if (parsed.unlimited && !parsed.days) {
          targetSession.leaseStartedAt = targetSession.leaseStartedAt || now;
          targetSession.leaseExpiresAt = null;
          targetSession.leaseMs = null;
          targetSession.leaseDays = null;
          targetSession.leasePaused = false;
          targetSession.updatedAt = now;
          resetLeaseReminders(targetSession);
          save(MEMORY_FILE, memory);
          return msg.reply(`Session ${parsed.name} is now unlimited.\n${sessionLeaseLine(parsed.name)}`);
        }

        extendSessionDuration(targetSession, parsed.durationMs, parsed.days);
        save(MEMORY_FILE, memory);

        return msg.reply(`Session ${parsed.name} extended by ${parsed.planLabel} (${formatDurationMs(parsed.durationMs)}).\n${sessionLeaseLine(parsed.name)}`);
      }

      if (text.startsWith('.session extendall ') || text.startsWith('.session addtimeall ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const durationText = raw.replace(/^\.session\s+(extendall|addtimeall)\s+/i, '').trim();
        const parsed = parseSessionDuration(durationText);
        if (!parsed.durationMs) return msg.reply('Use: .session extendall 1d, 12h, 7d, 10w, or 3m');

        const linkedTargets = linkedCustomerSessions();
        const targets = linkedTargets.filter(([sessionNameItem]) => {
          const stats = sessionLeaseStats(sessionNameItem);
          return stats && !stats.unlimited;
        });
        if (!targets.length) return msg.reply('No linked limited customer sessions found.');

        for (const [, targetSession] of targets) {
          extendSessionDuration(targetSession, parsed.durationMs, parsed.days);
        }
        save(MEMORY_FILE, memory);

        return msg.reply(
          `Extended ${targets.length} linked customer session(s) by ${parsed.planLabel} (${formatDurationMs(parsed.durationMs)}).\n` +
          `Skipped ${linkedTargets.length - targets.length} unlimited session(s).`
        );
      }

      if (text.startsWith('.session broadcast ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const notice = raw.replace(/^\.session\s+broadcast\s+/i, '').trim();
        if (!notice) return msg.reply('Use: .session broadcast maintenance message');

        const targets = linkedCustomerSessions();
        if (!targets.length) return msg.reply('No linked customer sessions found.');

        await msg.reply(`Broadcast started to ${targets.length} linked customer session(s).`);
        let sent = 0;
        let failed = 0;

        for (const [sessionNameItem, targetSession] of targets) {
          try {
            await client.sendMessage(targetSession.botId, notice);
            sent++;
          } catch (e) {
            failed++;
            logLine(`Session broadcast failed (${sessionNameItem}/${targetSession.botId}): ${e.message}`);
          }
          await sleep(SESSION_BROADCAST_DELAY_MS);
        }

        return msg.reply(`Broadcast complete. Sent: ${sent}. Failed: ${failed}.`);
      }

      if (text.startsWith('.session reduce ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const parsed = parseSessionLeaseInput(raw.slice(16));
        if (!parsed || !parsed.durationMs) return msg.reply('Use: .session reduce name 12h, 7d, 10w, or 3m');
        if (!sessions.sessions.includes(parsed.name)) return msg.reply('Session not found.');

        const targetSession = sessionSettings(parsed.name);
        if (!targetSession.leaseExpiresAt) return msg.reply('Unlimited sessions do not have duration to reduce. Use .session cancel name or set a new limited session.');

        const now = Date.now();
        targetSession.leaseExpiresAt = Math.max(now, Number(targetSession.leaseExpiresAt) - parsed.durationMs);
        targetSession.leaseMs = Math.max(0, Number(targetSession.leaseMs || 0) - parsed.durationMs);
        targetSession.leaseDays = Math.ceil(Number(targetSession.leaseMs || 0) / DAY_MS);
        targetSession.updatedAt = now;
        save(MEMORY_FILE, memory);
        return msg.reply(`Session ${parsed.name} reduced by ${parsed.planLabel} (${formatDurationMs(parsed.durationMs)}).\n${sessionLeaseLine(parsed.name)}`);
      }

      if (text.startsWith('.session pause ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const targetName = sessionName(raw.slice(15));
        if (!targetName) return msg.reply('Use: .session pause name');
        if (!sessions.sessions.includes(targetName)) return msg.reply('Session not found.');
        const targetSession = sessionSettings(targetName);
        targetSession.leasePaused = true;
        targetSession.updatedAt = Date.now();
        save(MEMORY_FILE, memory);
        return msg.reply(`Session ${targetName} paused. Premium access is now blocked in real time.`);
      }

      if (text.startsWith('.session resume ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const targetName = sessionName(raw.slice(16));
        if (!targetName) return msg.reply('Use: .session resume name');
        if (!sessions.sessions.includes(targetName)) return msg.reply('Session not found.');
        const targetSession = sessionSettings(targetName);
        const stats = sessionLeaseStats(targetName);
        if (stats && stats.expired) return msg.reply(`Session ${targetName} is expired. Use .session extend ${targetName} 7d or .session renew ${targetName} unlimited.`);
        targetSession.leasePaused = false;
        targetSession.updatedAt = Date.now();
        save(MEMORY_FILE, memory);
        return msg.reply(`Session ${targetName} resumed.\n${sessionLeaseLine(targetName)}`);
      }

      if (text.startsWith('.session cancel ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const targetName = sessionName(raw.slice(16));
        if (!targetName) return msg.reply('Use: .session cancel name');
        if (!sessions.sessions.includes(targetName)) return msg.reply('Session not found.');
        const targetSession = sessionSettings(targetName);
        targetSession.leaseStartedAt = targetSession.leaseStartedAt || Date.now();
        targetSession.leaseExpiresAt = Date.now();
        targetSession.leaseMs = 0;
        targetSession.leaseDays = 0;
        targetSession.leasePaused = false;
        targetSession.cancelledAt = Date.now();
        targetSession.updatedAt = Date.now();
        resetLeaseReminders(targetSession);
        save(MEMORY_FILE, memory);
        return msg.reply(`Session ${targetName} subscription cancelled. Premium access is now expired.`);
      }

      if (text.startsWith('.session status')) {
        if (!(await requireOwnerAccess(msg))) return;
        const requested = sessionName(raw.slice(15).trim()) || name;
        if (!sessions.sessions.includes(requested)) return msg.reply('Session not found.');
        const details = sessionSettings(requested);
        const stats = sessionLeaseStats(requested);
        const planValue = stats.paused && !stats.expiresAt ? 'Paused unlimited' : stats.unlimited ? 'Unlimited' : formatDurationMs(stats.totalMs);
        const remainingValue = stats.paused && !stats.expiresAt ? 'Paused' : stats.unlimited ? 'Unlimited' : formatDurationMs(stats.remainingMs);
        return msg.reply(
          `*Session Status*\n\n` +
          `Name: ${requested}\n` +
          `Number: ${details.botId || 'not linked yet'}\n` +
          `Plan: ${planValue}\n` +
          `Connected: ${stats.connectedDays} day${stats.connectedDays === 1 ? '' : 's'}\n` +
          `Remaining: ${remainingValue}\n` +
          `Status: ${stats.paused ? 'Paused' : stats.expired ? 'Expired' : 'Active'}`
        );
      }

      if (text.startsWith('.session qr')) {
        if (!(await requireOwnerAccess(msg))) return;
        const requested = sessionName(raw.slice(11).trim()) || name;
        const qr = lastSessionQr[requested];
        if (!qr) return msg.reply(`No active QR for session ${requested}. Add a new session or restart it.`);
        const dataUrl = await qrImage.toDataURL(qr);
        const media = new MessageMedia('image/png', dataUrl.split(',')[1], `${requested}-qr.png`);
        return msg.reply(media);
      }

      if (text.startsWith('.session pair')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const parts = raw.slice(13).trim().split(/\s+/).filter(Boolean);
        const requested = sessionName(parts[0]);
        const phone = String(parts[1] || '').replace(/\D/g, '');
        if (!requested || !phone) return msg.reply('Use: .session pair sessionName 2547...');
        if (!sessions.sessions.includes(requested)) return msg.reply('Session not found. Create it first with .session add name 7d, 30d, or unlimited');
        try {
          const code = await requestSessionPairingCode(requested, phone);
          return msg.reply(
            `*Pairing Code for ${requested}*\n\n` +
            `${code}\n\n` +
            `On their phone: WhatsApp > Linked devices > Link with phone number instead.\n` +
            `Enter this code before it expires.`
          );
        } catch (e) {
          return msg.reply(
            `Pairing code failed for ${requested}: ${e.message}\n` +
            `Try again in a few seconds, or use .session qr ${requested}.`
          );
        }
      }

      if (text.startsWith('.session remove ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const nameToRemove = sessionName(raw.slice(16));
        if (!nameToRemove) return msg.reply('Write a session name.');
        if (!sessions.sessions.includes(nameToRemove)) return msg.reply('Session not found.');
        if (sessions.sessions.length === 1) return msg.reply('You must keep at least one session.');

        sessions.sessions = sessions.sessions.filter(sessionNameItem => sessionNameItem !== nameToRemove);
        delete memory.sessions[nameToRemove];
        for (const item of schedules.schedules) {
          if (item.session === nameToRemove && item.status === 'pending') {
            item.status = 'cancelled';
            item.cancelledAt = Date.now();
            item.error = 'Session was removed.';
          }
        }
        save(SESSION_FILE, sessions);
        save(MEMORY_FILE, memory);
        saveSchedules();

        if (nameToRemove === name) {
          await msg.reply(`Session ${nameToRemove} removed. This session will stop now.`);
          setTimeout(() => {
            stopScheduleLoop(nameToRemove);
            if (clients[nameToRemove]) {
              clients[nameToRemove].destroy().catch(() => {});
              delete clients[nameToRemove];
            }
          }, 1000);
          return;
        }

        if (clients[nameToRemove]) {
          stopScheduleLoop(nameToRemove);
          await clients[nameToRemove].destroy().catch(() => {});
          delete clients[nameToRemove];
        }

        return msg.reply(`Session ${nameToRemove} removed.`);
      }

      if (text === '.session list') {
        if (!(await requireOwnerAccess(msg))) return;
        return msg.reply(sessions.sessions.map(sessionLeaseLine).join('\n'));
      }

      if (!text.startsWith('.') && session.autoreact && msg.react) {
        await msg.react(session.autoreactEmoji).catch(() => {});
      }

      if (!text.startsWith('.') && session.typing) {
        const chat = await msg.getChat();
        await chat.sendStateTyping().catch(() => {});
      }

      if (!isGroup && session.away && !text.startsWith('.')) {
        return msg.reply('I am away right now, but I will reply when I am back.');
      }

      if (!isGroup && session.pm) {
        const reply = session.smart
          ? await smartReply(displayName, raw, session.mood, session.persona)
          : feminine(displayName, raw, session.mood);
        return msg.reply(reply);
      }

      if (isGroup && g.autoreply && !text.startsWith('.')) {
        const custom = customAutoReply(g, raw, displayName);
        const reply = custom || (session.smart
          ? await smartReply(displayName, raw, g.mood, session.persona)
          : feminine(displayName, raw, g.mood));
        return msg.reply(reply);
      }

      if (isGroup && botId && mentionedIds.includes(botId) && !text.startsWith('.')) {
        if (!g.chatbot) {
          return msg.reply(`Githinji is online. Send .menu to see commands.${hostingPromoText()}`);
        }

        const custom = customAutoReply(g, raw, displayName);
        const reply = custom || (session.smart
          ? await smartReply(displayName, raw, g.mood, session.persona)
          : feminine(displayName, raw, g.mood));
        return msg.reply(`${reply}${hostingPromoText()}`);
      }
    } catch (e) {
      console.log('ERROR:', e.message);
      await msg.reply('Something went wrong while running that command.').catch(() => {});
    }
  });

  client.on('message_create', async msg => {
    try {
      if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') {
        client.emit('message', msg);
        return;
      }

      if (msg.fromMe && !String(msg.body || '').trim().startsWith('.')) {
        const body = String(msg.body || '');
        const from = chatId(msg);
        const settings = from && from.includes('@g.us') ? group(from) : null;
        if (!settings || !settings.pendingWelcomeModeSetup) return;
        if (clearExpiredWelcomeModeSetup(settings)) return;
        if (isWelcomeModePromptText(body) || !welcomeModeFromInput(body)) return;
      }
      client.emit('message', msg);
    } catch (e) {
      logLine(`message_create bridge failed (${name}): ${e.message}`);
    }
  });

  client.on('message_revoke_everyone', async (after, before) => {
    try {
      const oldMsg = before || after;
      if (!oldMsg || !oldMsg.from) return;
      const revokedId = oldMsg.id && oldMsg.id._serialized;
      if (revokedId && botDeletedMessageIds.has(revokedId)) {
        botDeletedMessageIds.delete(revokedId);
        return;
      }

      const cached = oldMsg.id && oldMsg.id._serialized ? messageCache[oldMsg.id._serialized] : null;
      const revokeChatId = (cached && cached.from) || chatId(oldMsg) || oldMsg.from;
      const isGroupDelete = String(revokeChatId || '').includes('@g.us');
      const session = sessionSettings(name);
      const g = isGroupDelete ? group(revokeChatId) : null;
      if (isGroupDelete && !g.antidelete) return;
      if (!isGroupDelete && !session.antideleteInbox) return;
      const chat = await oldMsg.getChat().catch(() => null);
      if (isGroupDelete && name !== 'main' && primaryBotIsInChat(chat, client.info && client.info.wid && client.info.wid._serialized)) return;

      const target = cached ? cached.sender : senderId(oldMsg);
      const botId = client.info && client.info.wid && client.info.wid._serialized;
      if (!botId) return;
      if (target === botId || oldMsg.fromMe || isKnownBotId(target)) return;
      const body = cached ? cached.body : oldMsg.body;
      const contact = await contactFor(client, target);
      const targetLabel = await identityLabelFor(client, target);
      const mentions = contact ? [contact] : [];
      const content = body && body.trim()
        ? `*${targetLabel}* deleted this message:\n${body}`
        : `*${targetLabel}* deleted a media or empty message.`;

      if (isGroupDelete) {
        await client.sendMessage(revokeChatId, content, { mentions });
      } else {
        const deletedAt = formatLocalDateTime(Date.now());
        const inboxReport =
          '*Inbox deleted message alert*\n\n' +
          `From: ${targetLabel}\n` +
          `Deleted at: ${deletedAt}\n` +
          `Type: ${cached ? cached.type : oldMsg.type || 'message'}\n\n` +
          (body && body.trim() ? `Message:\n${body}` : 'Message: media or empty message.');
        await client.sendMessage(botId, inboxReport, { mentions });
      }
    } catch (e) {
      console.log('ANTIDELETE ERROR:', e.message);
    }
  });

  client.on('group_join', async n => {
    try {
      const chat = await n.getChat();
      const botId = client.info && client.info.wid && client.info.wid._serialized;
      if (name !== 'main' && primaryBotIsInChat(chat, botId)) return;
      const id = n.recipientIds[0];
      if (isKnownBotId(id)) return;
      const settings = group(chat.id._serialized);
      const contact = await contactFor(client, id);
      const username = await identityLabelFor(client, id);
      if (settings.antiforeign && !isKenyanNumber(id)) {
        await chat.removeParticipants([id]).catch(() => {});
        await client.sendMessage(
          chat.id._serialized,
          `⚠️ *Protection Notice*\n\n*${username}* was removed because anti-foreign protection is ON.\n\nFor safety, this group only allows Kenyan numbers starting with +254. This helps protect members from unknown foreign accounts, scams, impersonation, and risky private deals.`,
          { mentions: contact ? [contact] : [] }
        );
        return;
      }
      if (!settings.welcomeOn) return;
      const text = buildWelcomeMessage(settings, id, username, chat.name || 'this group', chat.description);

      await sendTextOrImage(
        client,
        chat.id._serialized,
        text,
        contact ? [contact] : []
      );
    } catch {}
  });

  client.on('group_leave', async n => {
    try {
      const chat = await n.getChat();
      const botId = client.info && client.info.wid && client.info.wid._serialized;
      if (name !== 'main' && primaryBotIsInChat(chat, botId)) return;
      const id = n.recipientIds[0];
      if (isKnownBotId(id)) return;
      const settings = group(chat.id._serialized);
      if (!settings.goodbyeOn) return;
      const contact = await contactFor(client, id);
      const username = await identityLabelFor(client, id);
      const text = buildGoodbyeMessage(settings, id, username, chat.name || 'this group');

      await client.sendMessage(chat.id._serialized, text, {
        mentions: contact ? [contact] : []
      });
    } catch {}
  });

  client.initialize().catch(e => {
    logLine(`[${name}] initialization failed: ${e.message}`);
    scheduleSessionRestart(name, e.message || 'initialization failed');
  });
  return client;
}

process.on('SIGINT', () => shutdownGracefully(0));
process.on('SIGTERM', () => shutdownGracefully(0));

sessions.sessions.forEach(name => {
  start(name).catch(e => logLine(`[${name}] startup failed: ${e.message}`));
});
