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

const MEMORY_FILE = './memory.json';
const SESSION_FILE = './sessions.json';
const OWNERLOCK_FILE = './ownerlock.json';
const SCHEDULE_FILE = './schedules.json';
const YOUTUBE_COOKIES_FILE = path.join(__dirname, 'youtube-cookies.txt');
const SCHEDULE_UTC_OFFSET_HOURS = 3;
const SCHEDULE_TIMEZONE_LABEL = 'Africa/Nairobi';
const AUDIO_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_AUDIO_BYTES = 100 * 1024;
const MIN_VIDEO_BYTES = 500 * 1024;
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_MB || 45) * 1024 * 1024;
const YT_DLP_VIDEO_HEIGHT = Number(process.env.YT_DLP_VIDEO_HEIGHT || 360);
const HOSTING_PROMO = 'For bot hosting call +254 772 418884.';
const DAY_MS = 24 * 60 * 60 * 1000;

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
  inviteOptIns: {}
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
const processedMessages = new Set();
const botDeletedMessageIds = new Set();

const DEFAULT_BADWORDS = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'idiot',
  'stupid',
  'nonsense',
  'umbwa',
  'fala',
  'mjinga',
  'kuma',
  'mavi',
  'malaya',
  'scam',
  'conman',
  'fraud'
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
  return msg.author || msg.from;
}

function chatId(msg) {
  return msg.fromMe && msg.to ? msg.to : msg.from;
}

function activeSenderId(msg) {
  return msg.fromMe && msg.__botId ? msg.__botId : senderId(msg);
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

function isTrustedOwner(id) {
  return ownerlock.owners.includes(id);
}

async function requireOwnerAccess(msg) {
  if (!ownerlock.enabled) return true;
  if (!ownerlock.owners.length) return true;
  if (isTrustedOwner(activeSenderId(msg))) return true;
  await msg.reply('Owner lock is ON. This command is restricted.');
  return false;
}

async function requirePrimaryOwnerAccess(msg, botId, sessionNameValue) {
  if (!ownerlock.primaryOwner) return true;
  if (sessionNameValue === 'main' && (msg.fromMe || isTrustedOwner(activeSenderId(msg)))) return true;
  if (botId === ownerlock.primaryOwner && (msg.fromMe || isTrustedOwner(activeSenderId(msg)))) return true;
  await msg.reply('Only the first deployed bot number can use this command.');
  return false;
}

function tag(id) {
  return `@${String(id).split('@')[0]}`;
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
  if (!g.allowedPrefix) g.allowedPrefix = '254';
  if (typeof g.welcomeOn !== 'boolean') g.welcomeOn = true;
  if (typeof g.goodbyeOn !== 'boolean') g.goodbyeOn = true;
  if (!g.goodbye && g.bye) g.goodbye = g.bye;
  if (!g.warnLimit) g.warnLimit = 3;
  if (!g.muted) g.muted = {};
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
      statusReact: '💗',
      online: false,
      autostatus: false,
      statusText: 'Githinji Bot online',
      persona: null,
      createdAt: Date.now(),
      leaseStartedAt: null,
      leaseExpiresAt: null,
      leaseDays: null,
      botId: null
    };
    save(MEMORY_FILE, memory);
  }

  if (!memory.sessions[name].mood) memory.sessions[name].mood = 'normal';
  if (!memory.sessions[name].autoreactEmoji) memory.sessions[name].autoreactEmoji = '💗';
  if (!memory.sessions[name].statusReact) memory.sessions[name].statusReact = '💗';
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

function sessionName(raw) {
  return String(raw || '').trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
}

async function requestSessionPairingCode(name, phone) {
  if (!clients[name]) start(name);

  let lastError = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    const targetClient = clients[name];
    if (targetClient && typeof targetClient.requestPairingCode === 'function') {
      try {
        return await targetClient.requestPairingCode(phone);
      } catch (e) {
        lastError = e;
      }
    }
    await sleep(2000);
  }

  throw lastError || new Error('Pairing page was not ready.');
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
  const totalDays = Number(session.leaseDays || (expiresAt ? Math.ceil((expiresAt - startedAt) / DAY_MS) : 0));
  const connectedDays = Math.max(0, Math.floor((now - startedAt) / DAY_MS));
  const remainingDays = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / DAY_MS)) : null;

  return {
    startedAt,
    expiresAt,
    totalDays,
    connectedDays,
    remainingDays,
    expired: Boolean(expiresAt && expiresAt <= now),
    unlimited: !expiresAt
  };
}

function sessionLeaseLine(name) {
  const stats = sessionLeaseStats(name);
  if (!stats) return `${name}: missing`;
  if (stats.unlimited) return `${name}: unlimited`;
  return `${name}: ${stats.remainingDays} day${stats.remainingDays === 1 ? '' : 's'} left, connected ${stats.connectedDays} day${stats.connectedDays === 1 ? '' : 's'} (${stats.expired ? 'expired' : 'active'})`;
}

function parseSessionLeaseInput(rawValue) {
  const parts = String(rawValue || '').trim().split(/\s+/).filter(Boolean);
  const name = sessionName(parts[0]);
  const days = Number(parts[1]);
  if (!name) return null;
  return {
    name,
    days: Number.isInteger(days) && days > 0 ? days : null
  };
}

function safeFileName(name) {
  return String(name || 'song')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'song';
}

function saleDetected(text) {
  return /\b(uza|nunua|buy|purchase|sell|selling|sold)\b/i.test(text);
}

function antisaleWarning(displayName) {
  return `⚠️ *Safety Reminder*

*${displayName}*

Buying, selling, swapping, or trading inside a group can sometimes lead to scams or misunderstandings.

For your own safety, please involve a group admin as escrow before sending money, goods, account details, login information, or any private information.

Admin escrow helps protect both the buyer and the seller by confirming the deal before anything is released.

Please don't rush. Direct deals are done at your own risk.`;
}

function badwordDetected(g, text) {
  const body = String(text || '').toLowerCase();
  return g.badwords.find(word => body.includes(String(word).toLowerCase()));
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

async function displayNameFor(client, id) {
  const contact = await client.getContactById(id).catch(() => null);
  if (!contact) return tag(id);
  return contact.pushname || contact.name || contact.shortName || contact.verifiedName || tag(id);
}

async function contactFor(client, id) {
  return client.getContactById(id).catch(() => null);
}

function isContactId(id) {
  return /^\d+@c\.us$/.test(String(id || ''));
}

function savedContactList() {
  return Object.values(memory.savedContacts || {}).filter(item => item && isContactId(item.id));
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

  if (await isGroupAdmin(msg)) return true;

  await msg.reply('Group admin only command.');
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

async function ytDlpDownload(kind, videoUrl, outputPath) {
  const baseArgs = [
    '--no-playlist',
    '--no-warnings',
    '--force-overwrites',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
  ];

  if (fs.existsSync(YOUTUBE_COOKIES_FILE)) {
    baseArgs.push('--cookies', YOUTUBE_COOKIES_FILE);
  }

  if (process.env.YT_DLP_PROXY) {
    baseArgs.push('--proxy', process.env.YT_DLP_PROXY);
  }

  const videoHeight = Number.isInteger(YT_DLP_VIDEO_HEIGHT) && YT_DLP_VIDEO_HEIGHT > 0 ? YT_DLP_VIDEO_HEIGHT : 360;
  const args = kind === 'video'
    ? [
        ...baseArgs,
        '-f',
        `bestvideo[ext=mp4][height<=${videoHeight}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${videoHeight}]/best[height<=${videoHeight}]`,
        '--merge-output-format',
        'mp4',
        '-o',
        outputPath,
        videoUrl
      ]
    : [
        ...baseArgs,
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '128K',
        '-o',
        outputPath,
        videoUrl
      ];

  await execFileAsync('yt-dlp', args, {
    timeout: kind === 'video' ? VIDEO_DOWNLOAD_TIMEOUT_MS : AUDIO_DOWNLOAD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 4
  });
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
        await withTimeout(scraperDownload('audio', video.url, file), AUDIO_DOWNLOAD_TIMEOUT_MS, 'Song download scraper fallback');
      } catch (scraperError) {
        logLine(`Song scraper fallback (${scraperError.message})`);
        await withTimeout(convertYoutubeToMp3(video.url, file), AUDIO_DOWNLOAD_TIMEOUT_MS, 'Song download ytdl fallback');
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
    logLine(`Video download failed: ${e && e.stack ? e.stack : e.message}`);
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
  if (clients[name]) return clients[name];

  sessionSettings(name);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: name }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  clients[name] = client;

  client.on('qr', qr => {
    lastSessionQr[name] = qr;
    logLine(`Scan QR (${name})`);
    qrcode.generate(qr, { small: true });
  });

  client.on('code', code => {
    logLine(`[${name}] pairing code: ${code}`);
  });

  client.on('ready', () => {
    const botId = client.info && client.info.wid && client.info.wid._serialized;
    const session = sessionSettings(name);
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
    startScheduleLoop(client, name);
    sendDueSchedules(client, name).catch(e => logLine(`Schedule startup check failed (${name}): ${e.message}`));
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

      if (name !== 'main' && lease && lease.expired && isCommand && !text.startsWith('.session ')) {
        return msg.reply(
          `This bot session has expired.\n` +
          `Session: ${name}\n` +
          `Connected: ${lease.connectedDays} day${lease.connectedDays === 1 ? '' : 's'}\n` +
          `${HOSTING_PROMO}`
        );
      }

      cacheMessage(msg);
      trackMessage(msg);

      logLine(`[${name}] message from ${sender}: ${raw.slice(0, 80) || `[${msg.type || 'media'}]`}`);

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
        delete memory.inviteOptIns[sender];
        save(MEMORY_FILE, memory);
        return msg.reply('Invite permission removed. You will not receive invite links from this bot.');
      }

      if (isCommand && !isSessionOwnerCommand) {
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

      if (isGroup && g.antimention && !text.startsWith('.') && mentionedIds.length >= g.antimentionLimit) {
        if (!(await isGroupAdmin(msg))) {
          await deleteAsBot(msg);
          await warnUser(client, msg, sender, `Do not mention many people. Limit is ${g.antimentionLimit}.`);
          return;
        }
      }

      if (isGroup && g.antisale && !text.startsWith('.') && saleDetected(raw)) {
        if (await isGroupAdmin(msg)) return;
        const contact = await contactFor(client, sender);
        const senderName = await displayNameFor(client, sender);
        await msg.reply(antisaleWarning(senderName), undefined, {
          mentions: contact ? [contact] : []
        });
        await warnUser(client, msg, sender, 'Sale/trade warning. Please use admins as escrow.');
        return;
      }

      if (isGroup && g.antibadword && !text.startsWith('.')) {
        const word = badwordDetected(g, raw);
        if (word && !(await isGroupAdmin(msg))) {
          await deleteAsBot(msg);
          await warnUser(client, msg, sender, `Bad word detected: ${word}`);
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
        return msg.reply(`*Githinji Bot Menu*

*AI / Private*
.ask your question
.chatbot pm on/off
.chatbotgroup on/off
.smart on/off
.typing on/off
.online on/off
.summarize text
.define word

*Personality*
.mood flirty
.mood soft
.mood teasing
.mood clingy
.mood jealous
.mood savage
.mood loyal
.mood shy
.mood dramatic
.mood girlfriend
.mood romantic
.nickname yourname
.mynick
.persona custom your personality
.persona reset

*Fun*
.truth
.dare
.joke
.rate me
.ship @user1 @user2
.pickline
.roast
.confess
.8ball question
.wouldyourather
.lovequote
.fact
.riddle
.coinflip
.dice

*Games*
.rps rock/paper/scissors
.quiz
.mathquiz
.numbergame
.scramble
.tictactoe @user

*Media*
.sticker
.viewonce
.toimg
.tomp3
.tomp4
.play song name
.play video name
.ytmp3 song name
.ytmp4 video name
.qr text

*Welcome*
.welcome on/off
.setwelcome text
.goodbye on/off
.setgoodbye text

*Contacts / Group Transfer*
.savecontacts
.listcontacts
.inviteall
.clearsaved
.allowinvite
.stopinvite

*Protection*
.antilink on/off
.antimention on/off
.antimention limit 5
.antispam on/off
.antibadword on/off
.antiword badword
.delword badword
.badwords
.antidelete on/off
.antisale on/off
.antiviewonce on/off
.antiforeign on/off
.antifake on/off
.antiforward on/off
.antisticker on/off
.antimedia on/off
.antidocument on/off

*Moderation*
.warn @user
.warns
.resetwarn @user
.setwarnlimit 3
.promote @user
.demote @user
.kick @user
.add 2547...
.mute @user 10m
.purge @user 30
.tagall
.hidetag message
.tagadmins
.owner
.botadmin
.group open
.group close
.group info
.group link
.revoke link
.setname text
.setdesc text
.setpp
.delete
.deleteall @user

*Status*
.viewstatus on/off
.likestatus on/off
.reactstatus emoji
.setstatus text
.autostatus on/off

*Owner*
.ping
.runtime
.settings
.active
.ownerlock on/off
.owner add @user
.owner remove @user
.owner list
.restart
.shutdown
.logs
.backup
.restore
.schedule groups
.schedule add target | time | message
.schedule list
.schedule run
.schedule cancel id
.session list
.session add name days
.session status name
.session extend name days
.session remove name
.session qr
.session pair name 2547...${hostingPromoText()}`);
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

      if (text === '.restart') {
        if (!(await requireOwnerAccess(msg))) return;
        await msg.reply('Restarting. Use PM2/Task Scheduler so the process comes back automatically.');
        process.exit(2);
      }

      if (text === '.shutdown') {
        if (!(await requireOwnerAccess(msg))) return;
        await msg.reply('Shutting down.');
        process.exit(0);
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
        return msg.reply('Available moods: normal, flirty, soft, teasing, clingy, jealous, sweet, sassy, savage, romantic, funny, loyal, rude, shy, dramatic, girlfriend, bestie');
      }

      if (text === '.mood') {
        return msg.reply(`Current mood: ${mood}`);
      }

      if (text.startsWith('.mood ')) {
        const nextMood = text.split(/\s+/)[1];
        const allowed = ['normal', 'flirty', 'soft', 'teasing', 'clingy', 'jealous', 'sweet', 'sassy', 'savage', 'romantic', 'funny', 'loyal', 'rude', 'shy', 'dramatic', 'girlfriend', 'bestie'];
        if (!allowed.includes(nextMood)) return msg.reply(`Use one of: ${allowed.join(', ')}`);

        if (isGroup) {
          if (!(await requireGroupAdmin(msg))) return;
          g.mood = nextMood;
        } else {
          session.mood = nextMood;
        }

        save(MEMORY_FILE, memory);
        return msg.reply(`Mood set to ${nextMood}.`);
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
        }
        save(MEMORY_FILE, memory);
        return msg.reply(`Anti-badword ${g.antibadword ? 'ON' : 'OFF'}. Words saved: ${g.badwords.length}.`);
      }

      if (text.startsWith('.antiword ')) {
        if (!(await requireGroupAdmin(msg))) return;
        const word = raw.slice(10).trim().toLowerCase();
        if (!word) return msg.reply('Use: .antiword badword');
        if (!g.badwords.includes(word)) g.badwords.push(word);
        save(MEMORY_FILE, memory);
        return msg.reply(`Bad word added: ${word}`);
      }

      if (text.startsWith('.delword ')) {
        if (!(await requireGroupAdmin(msg))) return;
        const word = raw.slice(9).trim().toLowerCase();
        g.badwords = g.badwords.filter(item => item !== word);
        save(MEMORY_FILE, memory);
        return msg.reply(`Bad word removed: ${word}`);
      }

      if (text === '.badwords') {
        if (!isGroup) return msg.reply('Group only command.');
        g.badwords = [...new Set((g.badwords || []).map(word => String(word || '').trim().toLowerCase()).filter(Boolean))];
        if (!g.badwords.length) g.badwords = [...DEFAULT_BADWORDS];
        save(MEMORY_FILE, memory);
        return msg.reply(g.badwords.join('\n'));
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

        const target = await targetFromMentionOrReply(msg);
        if (!target) return msg.reply('Mention or reply to the user you want to kick.');

        const chat = await msg.getChat();
        await chat.removeParticipants([target]);
        return msg.reply('User removed.');
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

      if (text.startsWith('.add ')) {
        if (!(await requireGroupAdmin(msg))) return;

        const target = normalizeNumber(raw.slice(5));
        if (!target) return msg.reply('Write a phone number after .add');

        const chat = await msg.getChat();
        await chat.addParticipants([target]);
        return msg.reply('Add request sent.');
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
        const optedIn = savedContactList().filter(item => memory.inviteOptIns[item.id]).length;
        return msg.reply(
          `Saved contacts: ${total}\n` +
          `Invite opted-in: ${optedIn}\n` +
          `Use .savecontacts in a group to add members. Contacts must send .allowinvite privately before .inviteall can DM them.`
        );
      }

      if (text === '.clearsaved') {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        memory.savedContacts = {};
        save(MEMORY_FILE, memory);
        return msg.reply('Saved contacts cleared.');
      }

      if (text === '.inviteall') {
        if (!(await requireGroupAdmin(msg))) return;
        const chat = await msg.getChat();
        const code = await chat.getInviteCode();
        const inviteLink = `https://chat.whatsapp.com/${code}`;
        const botNumber = client.info && client.info.wid && client.info.wid._serialized;
        const ownerSet = new Set([botNumber, ownerlock.primaryOwner, ...ownerlock.owners].filter(Boolean));
        const contacts = savedContactList()
          .filter(item => isContactId(item.id))
          .filter(item => !ownerSet.has(item.id))
          .filter(item => Boolean(memory.inviteOptIns[item.id]));

        if (!contacts.length) {
          return msg.reply(
            `No opted-in saved contacts to invite.\n` +
            `Saved contacts must first send .allowinvite privately to the bot.`
          );
        }

        const maxPerRun = 25;
        const delayMs = 8000;
        const selected = contacts.slice(0, maxPerRun);
        let sent = 0;
        let failed = 0;

        await msg.reply(`Sending invite link to ${selected.length}/${contacts.length} opted-in contacts with ${delayMs / 1000}s delay.`);

        for (const item of selected) {
          try {
            const contact = await contactFor(client, item.id);
            if (!contact) {
              failed += 1;
              continue;
            }

            await client.sendMessage(
              item.id,
              `Hi ${item.name || 'there'}, here is the group invite link:\n${inviteLink}`
            );
            sent += 1;
            await sleep(delayMs);
          } catch {
            failed += 1;
          }
        }

        return msg.reply(
          `Invite run finished.\n` +
          `Sent: ${sent}\n` +
          `Failed/skipped: ${failed}\n` +
          `Remaining opted-in not sent this run: ${Math.max(contacts.length - selected.length, 0)}`
        );
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

      if (text === '.welcome on' || text === '.welcome off') {
        if (!(await requireGroupAdmin(msg))) return;
        g.welcomeOn = text.endsWith(' on');
        save(MEMORY_FILE, memory);
        return msg.reply(`Welcome ${g.welcomeOn ? 'ON' : 'OFF'}.`);
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

      if (text.startsWith('.session add ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const parsed = parseSessionLeaseInput(raw.slice(13));
        const nameToAdd = parsed && parsed.name;
        if (!nameToAdd) return msg.reply('Write a session name.');
        if (sessions.sessions.includes(nameToAdd)) return msg.reply('Session already exists.');

        sessions.sessions.push(nameToAdd);
        const nextSession = sessionSettings(nameToAdd);
        const now = Date.now();
        if (parsed.days) {
          nextSession.leaseStartedAt = now;
          nextSession.leaseExpiresAt = now + parsed.days * DAY_MS;
          nextSession.leaseDays = parsed.days;
          nextSession.createdBy = sender;
        }
        save(SESSION_FILE, sessions);
        save(MEMORY_FILE, memory);
        start(nameToAdd);
        return msg.reply(
          `Session ${nameToAdd} added${parsed.days ? ` for ${parsed.days} day${parsed.days === 1 ? '' : 's'}` : ''}.\n` +
          `Use .session pair ${nameToAdd} 2547... for a far user, or .session qr ${nameToAdd} for QR.`
        );
      }

      if (text.startsWith('.session extend ') || text.startsWith('.session renew ')) {
        if (!(await requireOwnerAccess(msg))) return;
        if (!(await requirePrimaryOwnerAccess(msg, botId, name))) return;
        const rawValue = raw.replace(/^\.session\s+(extend|renew)\s+/i, '');
        const parsed = parseSessionLeaseInput(rawValue);
        if (!parsed || !parsed.days) return msg.reply('Use: .session extend name 7');
        if (!sessions.sessions.includes(parsed.name)) return msg.reply('Session not found.');

        const targetSession = sessionSettings(parsed.name);
        const now = Date.now();
        const baseExpiry = Math.max(Number(targetSession.leaseExpiresAt || now), now);
        targetSession.leaseStartedAt = targetSession.leaseStartedAt || now;
        targetSession.leaseExpiresAt = baseExpiry + parsed.days * DAY_MS;
        targetSession.leaseDays = Number(targetSession.leaseDays || 0) + parsed.days;
        targetSession.updatedAt = now;
        save(MEMORY_FILE, memory);

        return msg.reply(`Session ${parsed.name} extended by ${parsed.days} day${parsed.days === 1 ? '' : 's'}.\n${sessionLeaseLine(parsed.name)}`);
      }

      if (text.startsWith('.session status')) {
        if (!(await requireOwnerAccess(msg))) return;
        const requested = sessionName(raw.slice(15).trim()) || name;
        if (!sessions.sessions.includes(requested)) return msg.reply('Session not found.');
        const details = sessionSettings(requested);
        const stats = sessionLeaseStats(requested);
        return msg.reply(
          `*Session Status*\n\n` +
          `Name: ${requested}\n` +
          `Number: ${details.botId || 'not linked yet'}\n` +
          `Plan: ${stats.unlimited ? 'Unlimited' : `${stats.totalDays} day${stats.totalDays === 1 ? '' : 's'}`}\n` +
          `Connected: ${stats.connectedDays} day${stats.connectedDays === 1 ? '' : 's'}\n` +
          `Remaining: ${stats.unlimited ? 'Unlimited' : `${stats.remainingDays} day${stats.remainingDays === 1 ? '' : 's'}`}\n` +
          `Status: ${stats.expired ? 'Expired' : 'Active'}`
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
        if (!sessions.sessions.includes(requested)) return msg.reply('Session not found. Create it first with .session add name days');
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

      if (msg.fromMe && !String(msg.body || '').trim().startsWith('.')) return;
      client.emit('message', msg);
    } catch (e) {
      logLine(`message_create bridge failed (${name}): ${e.message}`);
    }
  });

  client.on('message_revoke_everyone', async (after, before) => {
    try {
      const oldMsg = before || after;
      if (!oldMsg || !oldMsg.from || !oldMsg.from.includes('@g.us')) return;
      const revokedId = oldMsg.id && oldMsg.id._serialized;
      if (revokedId && botDeletedMessageIds.has(revokedId)) {
        botDeletedMessageIds.delete(revokedId);
        return;
      }

      const g = group(oldMsg.from);
      if (!g.antidelete) return;

      const cached = oldMsg.id && oldMsg.id._serialized ? messageCache[oldMsg.id._serialized] : null;
      const target = cached ? cached.sender : senderId(oldMsg);
      const botId = client.info && client.info.wid && client.info.wid._serialized;
      if (target === botId || oldMsg.fromMe) return;
      const body = cached ? cached.body : oldMsg.body;
      const contact = await contactFor(client, target);
      const targetName = await displayNameFor(client, target);
      const mentions = contact ? [contact] : [];
      const content = body && body.trim()
        ? `*${targetName}* deleted this message:\n${body}`
        : `*${targetName}* deleted a media or empty message.`;

      await client.sendMessage(oldMsg.from, content, { mentions });
    } catch (e) {
      console.log('ANTIDELETE ERROR:', e.message);
    }
  });

  client.on('group_join', async n => {
    try {
      const chat = await n.getChat();
      const id = n.recipientIds[0];
      const settings = group(chat.id._serialized);
      const contact = await contactFor(client, id);
      const username = contact
        ? (contact.pushname || contact.name || contact.shortName || contact.verifiedName || tag(id))
        : tag(id);
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
      const desc = chat.description || '';
      const text = settings.welcome ||
        `Welcome *${username}*\n\n${desc}\n\nThank you for joining, ${username}.`;

      await sendTextOrImage(
        client,
        chat.id._serialized,
        text.replace(/@user/g, username),
        contact ? [contact] : []
      );
    } catch {}
  });

  client.on('group_leave', async n => {
    try {
      const chat = await n.getChat();
      const id = n.recipientIds[0];
      const settings = group(chat.id._serialized);
      if (!settings.goodbyeOn) return;
      const contact = await contactFor(client, id);
      const username = contact
        ? (contact.pushname || contact.name || contact.shortName || contact.verifiedName || tag(id))
        : tag(id);
      const text = settings.goodbye || settings.bye || `Goodbye *${username}*`;

      await client.sendMessage(chat.id._serialized, text.replace(/@user/g, username), {
        mentions: contact ? [contact] : []
      });
    } catch {}
  });

  client.initialize();
  return client;
}

sessions.sessions.forEach(start);
