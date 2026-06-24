const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const Parser = require('rss-parser');

loadLocalEnv();

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'DevOps-News/1.0 (+local demo)' }
});

// === Live Russian DevOps News from Google News RSS (real-time) ===
let liveNews = [];
let lastUpdated = null;
let fetchInFlight = null;
let telegramSentNewsIds = new Set();
let telegramDeliveryInFlight = null;

const DEVOPS_KEYWORDS = [
  '"DevOps"',
  '"Kubernetes"',
  '"Docker"',
  '"CI/CD"',
  '"Terraform"',
  '"GitOps"',
  '"SRE"',
  '"Platform Engineering"',
  '"Cloud Native"',
  '"DevSecOps"',
  '"Prometheus"',
  '"Grafana"',
  '"Jenkins"',
  '"GitLab CI"',
  '"GitHub Actions"',
  '"инфраструктура как код"',
  '"непрерывная интеграция"',
  '"непрерывная доставка"',
  '"платформенная инженерия"',
  '"облачно-нативные"',
  '"контейнеризация"',
  '"мониторинг инфраструктуры"',
  '"DevSecOps"'
].join(' OR ');

function buildGoogleNewsRSS(keywords = DEVOPS_KEYWORDS) {
  const q = encodeURIComponent(`${keywords} when:14d`);
  return `https://news.google.com/rss/search?q=${q}&hl=ru&gl=RU&ceid=RU:ru`;
}

const NEWS_FEEDS = [
  {
    id: 'google-news',
    name: 'Google News',
    type: 'google',
    url: buildGoogleNewsRSS()
  },
  {
    id: 'habr-devops',
    name: 'Хабр',
    type: 'direct',
    url: 'https://habr.com/ru/rss/hub/devops/all/?fl=ru'
  },
  {
    id: 'securitylab',
    name: 'SecurityLab',
    type: 'direct',
    url: 'https://www.securitylab.ru/_services/export/rss/news/'
  },
  {
    id: 'cnews',
    name: 'CNews',
    type: 'direct',
    url: 'https://www.cnews.ru/inc/rss/news.xml'
  },
  {
    id: 'comnews',
    name: 'ComNews',
    type: 'direct',
    url: 'https://www.comnews.ru/rss.xml'
  }
];

const DEVOPS_TOPIC_PATTERNS = [
  /\bdevops\b/,
  /девопс/,
  /kubernetes|\bk8s\b|кубернет/,
  /docker|докер|container|контейнер/,
  /\bci\s*\/?\s*cd\b|\bcicd\b|pipeline|пайплайн|jenkins|gitlab ci|github actions|teamcity|buildkite/,
  /terraform|ansible|pulumi|\biac\b|infrastructure as code|инфраструктур[а-я\s-]*как код/,
  /gitops|argo\s*cd|argocd|fluxcd|\bhelm\b/,
  /\bsre\b|site reliability|\bsla\b|\bslo\b|\bsli\b|incident|инцидент|on-call|дежурств|observability|наблюдаем|alertmanager|opentelemetry|мониторинг/,
  /platform engineering|платформенн[а-я\s-]*инженер/,
  /cloud native|cloud-native|облачно[-\s]?натив|service mesh|istio|envoy/,
  /devsecops|supply chain security|software supply chain|\bsbom\b|trivy|snyk|cosign|sigstore/
];

const DEVOPS_TOOL_PATTERNS = [
  /prometheus|grafana|victoriametrics|victoria metrics|\bloki\b|elasticsearch/,
  /cilium|nginx|redis|snmp|ipmi/
];

const DEVOPS_CONTEXT_PATTERNS = [
  /linux|линукс/,
  /cloud|облак/,
  /server|сервер/,
  /infrastructure|инфраструктур/,
  /security|безопас|уязвим|эксплойт|\bcve\b/,
  /open source|opensource|открыт[а-я\s-]*код/,
  /automation|автоматизац/,
  /deployment|деплой|развертыв|релиз/
];

const DEVOPS_CONTEXT_REQUIRED_PATTERNS = [
  /infrastructure|инфраструктур|platform|платформ|server|сервер/,
  /cloud native|cloud-native|облачно[-\s]?натив/,
  /automation|автоматизац|deployment|деплой|развертыв|pipeline|пайплайн/
];

const NON_DEVOPS_NOISE_PATTERNS = [
  /музык|оркестр|джаз|классик|концерт|фестивал/,
  /смартфон|гаджет|автомобил|игр[ауы]|кино|сериал/,
  /криптовалют|бирж|банк|финанс|маркетинг/
];

function stripHtml(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) return;

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (!key || process.env[key] !== undefined) return;

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    });
  } catch (err) {
    console.error('[Config] Failed to load .env:', err.message);
  }
}

function getPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSearchText(value = '') {
  return stripHtml(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRussianText(value = '') {
  const text = stripHtml(value);
  let letters = 0;
  let cyrillic = 0;

  for (const char of text) {
    const code = char.codePointAt(0);
    const isLatin = (code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A);
    const isCyrillic = code >= 0x0400 && code <= 0x04FF;
    if (isLatin || isCyrillic) letters++;
    if (isCyrillic) cyrillic++;
  }

  if (cyrillic < 10) return false;
  return letters > 0 && cyrillic / letters >= 0.35;
}

function splitGoogleNewsTitle(rawTitle = '') {
  const title = stripHtml(rawTitle || 'Без заголовка');
  const dashIdx = title.lastIndexOf(' - ');

  if (dashIdx > 20 && dashIdx < title.length - 3) {
    return {
      title: title.substring(0, dashIdx).trim(),
      source: title.substring(dashIdx + 3).trim()
    };
  }

  return { title, source: '' };
}

function getNewsSearchText(item, parsedTitle = null) {
  const text = [
    parsedTitle && parsedTitle.title,
    item.title,
    item.contentSnippet,
    item.content,
    item.summary,
    item.categories && item.categories.join(' ')
  ].filter(Boolean).join(' ');

  return normalizeSearchText(text);
}

function countPatternMatches(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function isRelevantDevOpsNews(item, feed, parsedTitle = null) {
  if (feed.id === 'habr-devops') return true;

  const text = getNewsSearchText(item, parsedTitle);
  const hasNoise = NON_DEVOPS_NOISE_PATTERNS.some(pattern => pattern.test(text));
  const topicMatches = countPatternMatches(text, DEVOPS_TOPIC_PATTERNS);
  if (hasNoise && topicMatches === 0) return false;
  if (topicMatches > 0) return true;

  const toolMatches = countPatternMatches(text, DEVOPS_TOOL_PATTERNS);
  if (toolMatches > 0 && !hasNoise) return true;

  const contextMatches = countPatternMatches(text, DEVOPS_CONTEXT_PATTERNS);
  const hasDevOpsContext = DEVOPS_CONTEXT_REQUIRED_PATTERNS.some(pattern => pattern.test(text));

  return contextMatches >= 2 && hasDevOpsContext;
}

function getItemSource(item, feed, parsedTitle) {
  if (feed.type !== 'google') return feed.name;

  if (feed.type === 'google' && parsedTitle.source) return parsedTitle.source;

  if (item.source) {
    if (typeof item.source === 'string') return item.source;
    if (item.source.name) return item.source.name;
    if (item.source._) return item.source._;
  }

  return item.creator || item.author || feed.name;
}

function normalizeNewsItem(item, feed, index) {
  const parsedTitle = feed.type === 'google'
    ? splitGoogleNewsTitle(item.title)
    : { title: stripHtml(item.title || 'Без заголовка'), source: feed.name };

  const sourceName = stripHtml(getItemSource(item, feed, parsedTitle));
  const cleanTitle = parsedTitle.title;
  const textForLanguage = [cleanTitle, item.contentSnippet, item.content, item.summary].filter(Boolean).join(' ');

  if (!cleanTitle || !sourceName || !isRussianText(textForLanguage) || !isRelevantDevOpsNews(item, feed, parsedTitle)) {
    return null;
  }

  const pub = item.pubDate || item.isoDate || item.date || new Date().toISOString();
  let snippet = stripHtml(item.contentSnippet || item.summary || item.content || '');
  snippet = snippet
    .replace(cleanTitle, '')
    .replace(sourceName, '')
    .replace(/^[-–—·\s]+/, '')
    .trim()
    .slice(0, 260);
  if (snippet.length < 24) snippet = '';

  const stableId = crypto
    .createHash('sha1')
    .update(`${feed.id}:${item.guid || item.link || cleanTitle}`)
    .digest('hex')
    .slice(0, 12);

  return {
    id: `${feed.id}-${stableId}`,
    title: cleanTitle,
    link: item.link || '#',
    source: sourceName,
    provider: feed.name,
    providerId: feed.id,
    pubDate: pub,
    summary: snippet,
    category: 'DevOps'
  };
}

async function parseNewsFeed(feed) {
  const parsed = await parser.parseURL(feed.url);
  return (parsed.items || [])
    .map((item, index) => normalizeNewsItem(item, feed, index))
    .filter(Boolean);
}

function dedupeAndSortNews(items) {
  const seen = new Set();

  const sorted = items
    .filter(item => {
      const key = stripHtml(item.title).toLowerCase().replace(/\s+/g, ' ').slice(0, 90);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => getNewsTimestamp(b.pubDate) - getNewsTimestamp(a.pubDate));

  const selected = [];
  const selectedIds = new Set();

  for (const feed of NEWS_FEEDS) {
    sorted
      .filter(item => item.providerId === feed.id)
      .slice(0, 6)
      .forEach(item => {
        if (!selectedIds.has(item.id)) {
          selected.push(item);
          selectedIds.add(item.id);
        }
      });
  }

  sorted.forEach(item => {
    if (selected.length < 80 && !selectedIds.has(item.id)) {
      selected.push(item);
      selectedIds.add(item.id);
    }
  });

  return selected.sort((a, b) => getNewsTimestamp(b.pubDate) - getNewsTimestamp(a.pubDate)).slice(0, 80);
}

function getNewsTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function fetchLiveNews(force = false) {
  const cacheMs = 4 * 60 * 1000; // 4 minutes cache
  if (!force && lastUpdated && (Date.now() - lastUpdated < cacheMs) && liveNews.length > 0) {
    return liveNews;
  }

  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = (async () => {
    try {
      console.log(`[Live] Fetching news from ${NEWS_FEEDS.length} RSS sources...`);
      const results = await Promise.allSettled(NEWS_FEEDS.map(parseNewsFeed));
      const collected = [];
      let successfulFeeds = 0;

      results.forEach((result, index) => {
        const feed = NEWS_FEEDS[index];
        if (result.status === 'fulfilled') {
          successfulFeeds++;
          collected.push(...result.value);
        } else {
          console.error(`[Live] ${feed.name} RSS fetch failed:`, result.reason.message);
        }
      });

      if (successfulFeeds > 0) {
        liveNews = dedupeAndSortNews(collected);
      }
      lastUpdated = Date.now();
      console.log(`[Live] Loaded ${liveNews.length} Russian DevOps items from ${successfulFeeds}/${NEWS_FEEDS.length} sources`);
    } catch (err) {
      console.error('[Live] RSS aggregation failed:', err.message);
      if (liveNews.length === 0) {
        liveNews = [{
          id: 'fallback',
          title: 'Не удалось загрузить свежие русскоязычные DevOps-новости из RSS-источников',
          link: 'https://news.google.com/search?q=DevOps+OR+Kubernetes+when:14d&hl=ru&gl=RU&ceid=RU:ru',
          source: 'Система',
          pubDate: new Date().toISOString(),
          summary: 'Нажмите «Обновить сейчас». Убедитесь, что есть доступ к Google News RSS и прямым RSS-лентам. В ленту допускаются только русскоязычные материалы про DevOps, SRE, Cloud Native, CI/CD, Kubernetes и инфраструктуру.',
          category: 'DevOps'
        }];
      }
    }

    return liveNews;
  })();

  try {
    return await fetchInFlight;
  } finally {
    fetchInFlight = null;
  }
}

function getLiveNews() {
  return liveNews;
}

function getLastUpdated() {
  return lastUpdated;
}
const PORT = process.env.PORT || 3000;

// === Конфигурация ===
const ARTICLES_PATH = path.join(__dirname, 'data', 'articles.json');
const ADMIN_USERS_PATH = path.join(__dirname, 'data', 'admin-users.json');
const TELEGRAM_SENT_NEWS_PATH = path.join(__dirname, 'data', 'telegram-sent-news.json');
const LEARNING_PATH = path.join(__dirname, 'data', 'learning.json');
const DEFAULT_ADMIN_PATH = '/control-6fd9f142bf';
const ADMIN_PATH = normalizeAdminPath(process.env.ADMIN_PATH || DEFAULT_ADMIN_PATH);
const ADMIN_SESSION_COOKIE = 'adminSession';
const ADMIN_CSRF_COOKIE = 'adminCsrf';
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
const ADMIN_COOKIE_SECRET = process.env.ADMIN_COOKIE_SECRET || crypto.randomBytes(32).toString('base64url');
const NEWS_REFRESH_MS = getPositiveInteger(process.env.NEWS_REFRESH_MS, 5 * 60 * 1000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_NEWS_ENABLED = process.env.TELEGRAM_NEWS_ENABLED !== '0' && Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const TELEGRAM_SEND_INITIAL = process.env.TELEGRAM_SEND_INITIAL === '1';
const TELEGRAM_MAX_PER_CYCLE = getPositiveInteger(process.env.TELEGRAM_MAX_PER_CYCLE, 6);

const MARKDOWN_SANITIZE_OPTIONS = {
  allowedTags: Array.from(new Set([
    ...sanitizeHtml.defaults.allowedTags,
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'img', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
  ])),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    code: ['class']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', {
      target: '_blank',
      rel: 'noopener noreferrer'
    }, true)
  }
};

validateProductionConfig();

const adminLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: 'Слишком много попыток входа. Попробуйте позже.'
});

const apiRefreshLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 6,
  message: 'Слишком много запросов обновления. Попробуйте позже.'
});

// === Настройка ===
if (isProduction || process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(securityHeaders);
app.use(express.urlencoded({ extended: true, limit: '500kb' }));
app.use(express.json({ limit: '500kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: isProduction ? '1d' : 0
}));

// === Работа с данными ===
let articles = [];
let learningLessons = [];

function loadArticles() {
  try {
    const data = fs.readFileSync(ARTICLES_PATH, 'utf8');
    const parsed = JSON.parse(data);
    articles = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Не удалось загрузить статьи, создаём пустой массив');
    articles = [];
  }
}

function saveArticles() {
  try {
    const tempPath = `${ARTICLES_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(articles, null, 2), 'utf8');
    fs.renameSync(tempPath, ARTICLES_PATH);
  } catch (e) {
    console.error('Ошибка сохранения статей:', e);
  }
}

function loadLearningLessons() {
  try {
    const data = fs.readFileSync(LEARNING_PATH, 'utf8');
    const parsed = JSON.parse(data);
    learningLessons = Array.isArray(parsed.lessons) ? parsed.lessons : [];
  } catch (e) {
    console.error('Не удалось загрузить уроки, создаём пустой список');
    learningLessons = [];
  }
}

function saveLearningLessons() {
  try {
    const tempPath = `${LEARNING_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ lessons: learningLessons }, null, 2), 'utf8');
    fs.renameSync(tempPath, LEARNING_PATH);
  } catch (e) {
    console.error('Ошибка сохранения уроков:', e);
  }
}

function loadTelegramSentNews() {
  try {
    const data = fs.readFileSync(TELEGRAM_SENT_NEWS_PATH, 'utf8');
    const parsed = JSON.parse(data);
    const ids = Array.isArray(parsed.sentIds) ? parsed.sentIds : [];
    telegramSentNewsIds = new Set(ids.filter(Boolean));
  } catch (e) {
    telegramSentNewsIds = new Set();
  }
}

function saveTelegramSentNews() {
  try {
    const sentIds = [...telegramSentNewsIds].slice(-600);
    telegramSentNewsIds = new Set(sentIds);

    const tempPath = `${TELEGRAM_SENT_NEWS_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({
      updatedAt: new Date().toISOString(),
      sentIds
    }, null, 2), 'utf8');
    fs.renameSync(tempPath, TELEGRAM_SENT_NEWS_PATH);
  } catch (e) {
    console.error('[Telegram] Failed to save sent-news state:', e.message);
  }
}

function escapeTelegramHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isHttpUrl(value = '') {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function truncateText(value = '', maxLength = 700) {
  const text = stripHtml(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}…`;
}

function getTelegramTopicTags(item) {
  const text = normalizeSearchText(`${item.title} ${item.summary || ''}`);
  const tags = ['#DevOps', '#Новости'];

  if (/kubernetes|\bk8s\b|кубернет/.test(text)) tags.push('#Kubernetes');
  if (/docker|container|контейнер/.test(text)) tags.push('#Docker');
  if (/terraform|ansible|iac|инфраструктур/.test(text)) tags.push('#IaC');
  if (/\bci\s*\/?\s*cd\b|pipeline|jenkins|gitlab ci|github actions|пайплайн/.test(text)) tags.push('#CICD');
  if (/sre|observability|prometheus|grafana|мониторинг/.test(text)) tags.push('#SRE');
  if (/security|безопас|уязвим|devsecops|\bcve\b/.test(text)) tags.push('#DevSecOps');

  return [...new Set(tags)].slice(0, 5).join(' ');
}

function formatTelegramDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'дата неизвестна';

  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function buildTelegramNewsMessage(item) {
  const title = escapeTelegramHtml(item.title);
  const source = escapeTelegramHtml(item.source || item.provider || 'RSS');
  const provider = escapeTelegramHtml(item.provider || 'RSS');
  const summary = truncateText(item.summary || '', 650);
  const link = isHttpUrl(item.link) ? item.link : '';
  const titleLine = link
    ? `📰 <a href="${escapeTelegramHtml(link)}"><b>${title}</b></a>`
    : `📰 <b>${title}</b>`;

  const parts = [
    '🚀 <b>DevOps News</b>',
    '',
    titleLine,
    '',
    `🏷 <b>Источник:</b> ${source}`,
    `📡 <b>Лента:</b> ${provider}`,
    `🕒 <b>Опубликовано:</b> ${escapeTelegramHtml(formatTelegramDate(item.pubDate))}`
  ];

  if (summary) {
    parts.push('', `💬 ${escapeTelegramHtml(summary)}`);
  }

  if (link) {
    parts.push('', `🔗 <a href="${escapeTelegramHtml(link)}">Открыть новость</a>`);
  }

  parts.push('', getTelegramTopicTags(item));

  return parts.join('\n').slice(0, 3900);
}

async function sendTelegramMessage(text) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(data.description || `Telegram HTTP ${response.status}`);
  }

  return data.result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deliverTelegramNews(items, { startup = false } = {}) {
  if (!TELEGRAM_NEWS_ENABLED || !Array.isArray(items) || items.length === 0) return;
  if (telegramDeliveryInFlight) return telegramDeliveryInFlight;

  telegramDeliveryInFlight = (async () => {
    const knownItems = items.filter(item => item && item.id);

    if (startup && telegramSentNewsIds.size === 0 && !TELEGRAM_SEND_INITIAL) {
      knownItems.forEach(item => telegramSentNewsIds.add(item.id));
      saveTelegramSentNews();
      console.log(`[Telegram] Seeded ${knownItems.length} existing news items. Future new items will be sent.`);
      return;
    }

    const pending = knownItems
      .filter(item => !telegramSentNewsIds.has(item.id))
      .sort((a, b) => getNewsTimestamp(a.pubDate) - getNewsTimestamp(b.pubDate))
      .slice(0, TELEGRAM_MAX_PER_CYCLE);

    if (pending.length === 0) return;

    for (const item of pending) {
      try {
        await sendTelegramMessage(buildTelegramNewsMessage(item));
        telegramSentNewsIds.add(item.id);
        saveTelegramSentNews();
        console.log(`[Telegram] Sent news: ${item.title}`);
        await sleep(800);
      } catch (err) {
        const message = String(err.message || err).replace(TELEGRAM_BOT_TOKEN, '[redacted]');
        console.error('[Telegram] Failed to send news:', message);
        break;
      }
    }
  })();

  try {
    await telegramDeliveryInFlight;
  } finally {
    telegramDeliveryInFlight = null;
  }
}

function startNewsJobs() {
  fetchLiveNews(true)
    .then(items => deliverTelegramNews(items, { startup: true }))
    .catch(() => {});

  setInterval(() => {
    fetchLiveNews(false)
      .then(items => deliverTelegramNews(items))
      .catch(() => {});
  }, NEWS_REFRESH_MS);
}

function getArticleBySlug(slug) {
  return articles.find(a => a.slug === slug);
}

function getLearningLessonBySlug(slug) {
  return learningLessons.find(lesson => lesson.slug === slug);
}

function generateSlug(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s-]/gi, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();

  return slug || `article-${Date.now().toString(36)}`;
}

function getSortedArticles() {
  return [...articles].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function getSortedLearningLessons() {
  return [...learningLessons].sort((a, b) => {
    const moduleDiff = Number(a.moduleOrder || 0) - Number(b.moduleOrder || 0);
    if (moduleDiff !== 0) return moduleDiff;

    const lessonDiff = Number(a.lessonOrder || 0) - Number(b.lessonOrder || 0);
    if (lessonDiff !== 0) return lessonDiff;

    return new Date(b.date || 0) - new Date(a.date || 0);
  });
}

function getCategories() {
  const cats = [...new Set(articles.map(a => a.category))];
  return cats.sort();
}

function getLearningCategories() {
  const cats = [...new Set(learningLessons.map(lesson => lesson.module).filter(Boolean))];
  return cats.sort();
}

function normalizeAdminPath(value) {
  const cleaned = String(value || '').trim().replace(/\/+$/, '');
  if (!cleaned || cleaned === '/') return '/control-6fd9f142bf';
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
}

function validateProductionConfig() {
  if (!isProduction) return;

  const errors = [];
  if (!process.env.ADMIN_COOKIE_SECRET || process.env.ADMIN_COOKIE_SECRET.length < 32) {
    errors.push('ADMIN_COOKIE_SECRET must be set to at least 32 characters');
  }
  if (!process.env.ADMIN_PATH || ADMIN_PATH === DEFAULT_ADMIN_PATH) {
    errors.push('ADMIN_PATH must be set to a private non-default path');
  }

  if (errors.length > 0) {
    throw new Error(`Production config is not ready: ${errors.join('; ')}`);
  }
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const record = hits.get(key);

    if (!record || now > record.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    record.count += 1;
    if (record.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((record.resetAt - now) / 1000)));
      return res.status(429).send(message);
    }

    return next();
  };
}

function renderMarkdownSafe(content = '') {
  return sanitizeHtml(marked.parse(content || ''), MARKDOWN_SANITIZE_OPTIONS);
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function normalizeDateInput(value, fallback = todayISO()) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fallback;

  const timestamp = new Date(`${date}T00:00:00.000Z`).getTime();
  return Number.isFinite(timestamp) ? date : fallback;
}

function clampText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function getNextArticleId() {
  const ids = articles.map(article => Number(article.id)).filter(Number.isFinite);
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

function getNextLearningLessonId() {
  const ids = learningLessons.map(lesson => Number(lesson.id)).filter(Number.isFinite);
  return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

function parseQuizJson(value) {
  if (!value || !String(value).trim()) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(item => ({
        question: clampText(item.question, 240),
        options: Array.isArray(item.options)
          ? item.options.map(option => clampText(option, 160)).filter(Boolean).slice(0, 6)
          : [],
        correctIndex: Number.isInteger(item.correctIndex) ? item.correctIndex : 0,
        explanation: clampText(item.explanation, 400)
      }))
      .filter(item => item.question && item.options.length >= 2 && item.correctIndex >= 0 && item.correctIndex < item.options.length)
      .slice(0, 12);
  } catch (e) {
    return [];
  }
}

function stringifyQuizForForm(quiz) {
  return JSON.stringify(Array.isArray(quiz) ? quiz : [], null, 2);
}

function buildLearningLessonFromBody(body, existing = {}) {
  const cleanTitle = clampText(body.title, 180);
  const cleanContent = clampText(body.content, 70000);

  if (!cleanTitle || !cleanContent) return null;

  return {
    ...existing,
    title: cleanTitle,
    slug: existing.slug || generateSlug(cleanTitle),
    summary: clampText(body.summary, 700),
    module: clampText(body.module, 120) || 'Месяц 1. Введение в DevOps и Culture',
    week: clampText(body.week, 120) || 'Неделя 1: Что такое DevOps сегодня (2026 год)',
    lessonNumber: clampText(body.lessonNumber, 40) || '1.1',
    moduleOrder: getPositiveInteger(body.moduleOrder, existing.moduleOrder || 1),
    lessonOrder: getPositiveInteger(body.lessonOrder, existing.lessonOrder || 1),
    duration: clampText(body.duration, 40) || '7 минут',
    level: clampText(body.level, 60) || 'Старт',
    date: normalizeDateInput(body.date, existing.date || todayISO()),
    status: body.status === 'draft' ? 'draft' : 'published',
    objectives: clampText(body.objectives, 3000),
    content: cleanContent,
    practice: clampText(body.practice, 12000),
    resources: clampText(body.resources, 8000),
    quiz: parseQuizJson(body.quizJson),
    updatedAt: new Date().toISOString()
  };
}

let adminUsers = [];

function loadAdminUsers() {
  try {
    const data = fs.readFileSync(ADMIN_USERS_PATH, 'utf8');
    const parsed = JSON.parse(data);
    adminUsers = Array.isArray(parsed.users) ? parsed.users : [];
  } catch (e) {
    console.error('Не удалось загрузить админ-пользователей:', e.message);
    adminUsers = [];
  }
}

function findAdminUser(username) {
  return adminUsers.find(user => user.username === username);
}

function verifyPassword(password, user) {
  if (!user || !password || !user.salt || !user.passwordHash) return false;

  const iterations = Number(user.iterations) || 310000;
  const keylen = Number(user.keylen) || 32;
  const digest = user.digest || 'sha256';
  const expected = Buffer.from(user.passwordHash, 'base64url');
  const actual = crypto.pbkdf2Sync(password, user.salt, iterations, keylen, digest);

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function signValue(value) {
  return crypto.createHmac('sha256', ADMIN_COOKIE_SECRET).update(value).digest('base64url');
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookieOptions(req, maxAge = ADMIN_SESSION_TTL_MS) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction || req.secure,
    maxAge
  };
}

function createSignedToken(prefix) {
  const payload = `${prefix}:${crypto.randomBytes(24).toString('base64url')}`;
  return `${payload}.${signValue(payload)}`;
}

function verifySignedToken(token, prefix) {
  if (!token || typeof token !== 'string') return false;

  const [payload, signature] = token.split('.');
  if (!payload || !signature || !payload.startsWith(`${prefix}:`)) return false;

  return timingSafeStringEqual(signature, signValue(payload));
}

function createSessionToken(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  })).toString('base64url');
  return `${payload}.${signValue(payload)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = signValue(payload);
  if (!timingSafeStringEqual(expected, signature)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session.username || !session.expiresAt || Date.now() > session.expiresAt) return null;
    return findAdminUser(session.username) ? session : null;
  } catch (e) {
    return null;
  }
}

function getAdminRedirect(message, needLogin = false) {
  const params = new URLSearchParams();
  if (needLogin) params.set('needLogin', '1');
  if (message) params.set('msg', message);
  const query = params.toString();
  return query ? `${ADMIN_PATH}?${query}` : ADMIN_PATH;
}

function getOrCreateCsrfToken(req, res) {
  const existing = req.cookies && req.cookies[ADMIN_CSRF_COOKIE];
  if (verifySignedToken(existing, 'csrf')) return existing;

  const token = createSignedToken('csrf');
  res.cookie(ADMIN_CSRF_COOKIE, token, getCookieOptions(req));
  return token;
}

function csrfProtection(req, res, next) {
  const cookieToken = req.cookies && req.cookies[ADMIN_CSRF_COOKIE];
  const requestToken = (req.body && req.body._csrf) || req.get('x-csrf-token');

  if (
    !verifySignedToken(cookieToken, 'csrf') ||
    !verifySignedToken(requestToken, 'csrf') ||
    !timingSafeStringEqual(cookieToken, requestToken)
  ) {
    return res.status(403).send('CSRF token is invalid');
  }

  return next();
}

// Загружаем статьи при старте
loadArticles();
loadLearningLessons();
loadAdminUsers();
loadTelegramSentNews();

// === Middleware для админки ===
function requireAdmin(req, res, next) {
  const session = verifySessionToken(req.cookies && req.cookies[ADMIN_SESSION_COOKIE]);
  if (session) {
    req.adminUser = session.username;
    return next();
  }
  return res.redirect(getAdminRedirect('Требуется вход', true));
}

// === Публичные маршруты ===

// Главная — лента новостей (теперь в стиле Google News + live DevOps)
app.get('/', async (req, res) => {
  const live = await fetchLiveNews(req.query.refresh === '1');
  const curated = getSortedArticles().slice(0, 6); // keep a few curated for learning section
  const lessons = getSortedLearningLessons().filter(lesson => lesson.status !== 'draft').slice(0, 3);
  const categories = getCategories();

  res.render('index', {
    liveNews: live,
    lastUpdated: getLastUpdated(),
    curatedArticles: curated,
    learningLessons: lessons,
    categories,
    title: 'DevOps News — новости DevOps в стиле Google News (live)'
  });
});

app.get('/learning', (req, res) => {
  const materials = getSortedArticles();
  const lessons = getSortedLearningLessons().filter(lesson => lesson.status !== 'draft');

  res.render('learning', {
    materials,
    lessons,
    title: 'Обучение — DevOps News'
  });
});

app.get('/learning/:slug', (req, res) => {
  const lesson = getLearningLessonBySlug(req.params.slug);
  if (!lesson || lesson.status === 'draft') {
    return res.status(404).render('404', { title: 'Урок не найден' });
  }

  const sortedLessons = getSortedLearningLessons().filter(item => item.status !== 'draft');
  const currentIndex = sortedLessons.findIndex(item => item.slug === lesson.slug);
  const previousLesson = currentIndex > 0 ? sortedLessons[currentIndex - 1] : null;
  const nextLesson = currentIndex >= 0 && currentIndex < sortedLessons.length - 1 ? sortedLessons[currentIndex + 1] : null;

  res.render('lesson', {
    lesson,
    htmlContent: renderMarkdownSafe(lesson.content || ''),
    practiceHtml: renderMarkdownSafe(lesson.practice || ''),
    resourcesHtml: renderMarkdownSafe(lesson.resources || ''),
    objectivesHtml: renderMarkdownSafe(lesson.objectives || ''),
    quizJson: JSON.stringify(Array.isArray(lesson.quiz) ? lesson.quiz : []),
    previousLesson,
    nextLesson,
    title: `${lesson.title} — DevOps News`
  });
});

// Отдельная статья
app.get('/article/:slug', (req, res) => {
  const article = getArticleBySlug(req.params.slug);
  if (!article) {
    return res.status(404).render('404', { title: 'Статья не найдена' });
  }
  const htmlContent = renderMarkdownSafe(article.content || '');
  const sorted = getSortedArticles();
  const related = sorted
    .filter(a => a.slug !== article.slug && a.category === article.category)
    .slice(0, 3);

  res.render('article', {
    article,
    htmlContent,
    related,
    title: article.title + ' — DevOps News'
  });
});

// О проекте
app.get('/about', (req, res) => {
  res.render('about', {
    title: 'О проекте — DevOps News'
  });
});

// === Админка ===

// Страница входа / админ-панель
app.get(ADMIN_PATH, (req, res) => {
  const session = verifySessionToken(req.cookies && req.cookies[ADMIN_SESSION_COOKIE]);
  const needLogin = req.query.needLogin;
  const msg = req.query.msg;
  const csrfToken = getOrCreateCsrfToken(req, res);

  if (!session) {
    return res.render('admin-login', {
      title: 'Вход в админку',
      adminPath: ADMIN_PATH,
      csrfToken,
      needLogin,
      msg
    });
  }

  // Админ вошёл
  const sorted = getSortedArticles();
  const lessons = getSortedLearningLessons();
  const categories = getCategories().length ? getCategories() : ['Основы', 'CI/CD', 'Контейнеры', 'Kubernetes', 'IaC', 'Мониторинг', 'GitOps', 'Безопасность'];
  const learningCategories = getLearningCategories().length ? getLearningCategories() : ['Месяц 1. Введение в DevOps и Culture'];

  res.render('admin', {
    title: 'Админ-панель — DevOps News',
    adminPath: ADMIN_PATH,
    adminUser: session.username,
    articles: sorted,
    learningLessons: lessons,
    categories,
    learningCategories,
    csrfToken,
    msg
  });
});

// Логин
app.post(`${ADMIN_PATH}/login`, adminLoginLimiter, csrfProtection, (req, res) => {
  const { username, password } = req.body;
  const user = findAdminUser(String(username || '').trim());

  if (verifyPassword(password, user)) {
    res.cookie(ADMIN_SESSION_COOKIE, createSessionToken(user.username), getCookieOptions(req));
    return res.redirect(getAdminRedirect('Добро пожаловать!'));
  }

  res.redirect(getAdminRedirect('Неверный логин или пароль', true));
});

// Выход
app.post(`${ADMIN_PATH}/logout`, requireAdmin, csrfProtection, (req, res) => {
  res.clearCookie(ADMIN_SESSION_COOKIE);
  res.clearCookie(ADMIN_CSRF_COOKIE);
  res.redirect(getAdminRedirect('Вы вышли'));
});

// Создать статью (из формы админки)
app.post(`${ADMIN_PATH}/create`, requireAdmin, csrfProtection, (req, res) => {
  const { title, summary, content, category, date } = req.body;
  const cleanTitle = clampText(title, 180);
  const cleanContent = clampText(content, 50000);

  if (!cleanTitle || !cleanContent) {
    return res.redirect(getAdminRedirect('Заголовок и содержание обязательны'));
  }

  let slug = generateSlug(cleanTitle);
  // Уникальность slug
  let baseSlug = slug;
  let counter = 1;
  while (articles.find(a => a.slug === slug)) {
    slug = `${baseSlug}-${counter++}`;
  }

  const newArticle = {
    id: getNextArticleId(),
    title: cleanTitle,
    slug,
    summary: clampText(summary, 500),
    content: cleanContent,
    category: clampText(category, 80) || 'Основы',
    date: normalizeDateInput(date),
    author: 'Редакция'
  };

  articles.push(newArticle);
  saveArticles();

  res.redirect(getAdminRedirect('Статья успешно создана'));
});

// Обновить статью
app.post(`${ADMIN_PATH}/update/:id`, requireAdmin, csrfProtection, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const articleIndex = articles.findIndex(a => a.id === id);
  if (articleIndex === -1) {
    return res.redirect(getAdminRedirect('Статья не найдена'));
  }

  const { title, summary, content, category, date, slug: customSlug } = req.body;
  const cleanTitle = clampText(title, 180);
  const cleanContent = clampText(content, 50000);

  if (!cleanTitle || !cleanContent) {
    return res.redirect(getAdminRedirect('Заголовок и содержание обязательны'));
  }

  let slug = customSlug ? generateSlug(customSlug) : generateSlug(cleanTitle);

  // Уникальность (кроме текущей)
  let baseSlug = slug;
  let counter = 1;
  while (articles.some(a => a.slug === slug && a.id !== id)) {
    slug = `${baseSlug}-${counter++}`;
  }

  articles[articleIndex] = {
    ...articles[articleIndex],
    title: cleanTitle,
    slug,
    summary: clampText(summary, 500),
    content: cleanContent,
    category: clampText(category, 80) || 'Основы',
    date: normalizeDateInput(date, articles[articleIndex].date || todayISO()),
    author: articles[articleIndex].author || 'Редакция'
  };

  saveArticles();
  res.redirect(getAdminRedirect('Статья обновлена'));
});

// Удалить статью
app.post(`${ADMIN_PATH}/delete/:id`, requireAdmin, csrfProtection, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const before = articles.length;
  articles = articles.filter(a => a.id !== id);

  if (articles.length < before) {
    saveArticles();
    res.redirect(getAdminRedirect('Статья удалена'));
  } else {
    res.redirect(getAdminRedirect('Не удалось удалить'));
  }
});

app.post(`${ADMIN_PATH}/learning/create`, requireAdmin, csrfProtection, (req, res) => {
  const lesson = buildLearningLessonFromBody(req.body);
  if (!lesson) {
    return res.redirect(getAdminRedirect('Заголовок и содержание урока обязательны'));
  }

  let slug = generateSlug(lesson.title);
  const baseSlug = slug;
  let counter = 1;
  while (learningLessons.find(item => item.slug === slug)) {
    slug = `${baseSlug}-${counter++}`;
  }

  learningLessons.push({
    ...lesson,
    id: getNextLearningLessonId(),
    slug,
    author: 'Редакция'
  });
  saveLearningLessons();

  res.redirect(getAdminRedirect('Урок успешно создан'));
});

app.post(`${ADMIN_PATH}/learning/update/:id`, requireAdmin, csrfProtection, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const lessonIndex = learningLessons.findIndex(item => item.id === id);
  if (lessonIndex === -1) {
    return res.redirect(getAdminRedirect('Урок не найден'));
  }

  const currentLesson = learningLessons[lessonIndex];
  const lesson = buildLearningLessonFromBody(req.body, currentLesson);
  if (!lesson) {
    return res.redirect(getAdminRedirect('Заголовок и содержание урока обязательны'));
  }

  let slug = req.body.slug ? generateSlug(req.body.slug) : generateSlug(lesson.title);
  const baseSlug = slug;
  let counter = 1;
  while (learningLessons.some(item => item.slug === slug && item.id !== id)) {
    slug = `${baseSlug}-${counter++}`;
  }

  learningLessons[lessonIndex] = {
    ...lesson,
    id,
    slug,
    author: currentLesson.author || 'Редакция'
  };
  saveLearningLessons();

  res.redirect(getAdminRedirect('Урок обновлён'));
});

app.post(`${ADMIN_PATH}/learning/delete/:id`, requireAdmin, csrfProtection, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const before = learningLessons.length;
  learningLessons = learningLessons.filter(item => item.id !== id);

  if (learningLessons.length < before) {
    saveLearningLessons();
    res.redirect(getAdminRedirect('Урок удалён'));
  } else {
    res.redirect(getAdminRedirect('Не удалось удалить урок'));
  }
});

// === API для предпросмотра markdown (опционально, для админки) ===
app.post(`${ADMIN_PATH}/preview`, requireAdmin, csrfProtection, (req, res) => {
  const { content } = req.body;
  const html = renderMarkdownSafe(content || '');
  res.json({ html });
});

// === Real-time DevOps News API (for external parsing, scripts, etc.) ===
app.get('/api/news', (req, res, next) => {
  if (req.query.force === '1' || req.query.refresh === '1') {
    return apiRefreshLimiter(req, res, next);
  }
  return next();
}, async (req, res) => {
  const force = req.query.force === '1' || req.query.refresh === '1';
  const items = await fetchLiveNews(force);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    source: 'Google News RSS + direct Russian RSS feeds',
    sources: NEWS_FEEDS.map(feed => ({
      id: feed.id,
      name: feed.name,
      type: feed.type,
      url: feed.url
    })),
    updated: lastUpdated,
    updatedISO: lastUpdated ? new Date(lastUpdated).toISOString() : null,
    count: items.length,
    items: items.map(i => ({
      title: i.title,
      link: i.link,
      source: i.source,
      provider: i.provider,
      providerId: i.providerId,
      pubDate: i.pubDate,
      summary: i.summary
    }))
  });
});

// Force refresh endpoint (can be called from UI or scripts)
app.post('/api/refresh', apiRefreshLimiter, async (req, res) => {
  const items = await fetchLiveNews(true);
  deliverTelegramNews(items).catch(() => {});
  res.json({ ok: true, count: items.length, updated: lastUpdated });
});

// 404
app.use((req, res) => {
  res.status(404).render('404', { title: 'Страница не найдена — DevOps News' });
});

// Запуск
startNewsJobs();

app.listen(PORT, () => {
  console.log(`🚀 DevOps News запущен: http://localhost:${PORT}`);
  console.log(`   📚 Обучение: http://localhost:${PORT}/learning`);
  console.log(`   Стиль: Google News + реал-тайм DevOps (RSS)`);
  console.log(`   API для парсинга: http://localhost:${PORT}/api/news`);
  console.log(`   Telegram доставка: ${TELEGRAM_NEWS_ENABLED ? 'включена' : 'выключена'}`);
  console.log(`   Админка скрыта за приватным входом. Задайте ADMIN_PATH и ADMIN_COOKIE_SECRET в окружении для продакшена.`);
});
