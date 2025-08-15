import fs from 'node:fs';
import path from 'node:path';
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import { franc } from 'franc-min';
import { htmlToText } from 'html-to-text';

const TARGET_LANG = 'fa';
// Default: use LibreTranslate public endpoint unless user overrides
const PROVIDER = (process.env.TRANSLATE_PROVIDER || 'libre').toLowerCase();
const LIBRE_URL = process.env.LIBRE_URL || 'https://libretranslate.com/translate';

// Persian display names for sources (no English on UI)
const SOURCE_FA = new Map(Object.entries({
  'The New York Times — Home':'نیویورک تایمز',
  'The Washington Post — Home':'واشنگتن پست',
  'The Guardian — World':'گاردین',
  'Financial Times — News Feed':'فایننشال تایمز',
  'BBC News — Front Page':'بی‌بی‌سی',
  'CNN International — Top':'سی‌ان‌ان',
  'Al Jazeera English — All':'الجزیره انگلیسی',
  'DW (Deutsche Welle) — English':'دویچه‌وله',
  'Reuters — Top News':'رویترز',
  'Bloomberg — Markets':'بلومبرگ',
  'Bloomberg — Business':'بلومبرگ کسب‌وکار',
  'Nature — Main':'نیچر',
  'TechCrunch — All':'تک‌کرانچ',
  'MIT Technology Review — All':'مرور فناوری ام‌آی‌تی',
  'The Lancet — Current Issue':'لنست'
}));

const SOURCES = [
  { name: 'The New York Times — Home', url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', type: 'rss' },
  { name: 'The Washington Post — Home', url: 'https://feeds.washingtonpost.com/rss/homepage/', type: 'rss' },
  { name: 'The Guardian — World', url: 'https://www.theguardian.com/world/rss', type: 'rss' },
  { name: 'Financial Times — News Feed', url: 'https://www.ft.com/news-feed?format=rss', type: 'rss' },
  { name: 'BBC News — Front Page', url: 'https://feeds.bbci.co.uk/news/rss.xml?edition=int', type: 'rss' },
  { name: 'CNN International — Top', url: 'https://rss.cnn.com/rss/edition.rss', type: 'rss' },
  { name: 'Al Jazeera English — All', url: 'https://www.aljazeera.com/xml/rss/all.xml', type: 'rss' },
  { name: 'DW (Deutsche Welle) — English', url: 'https://rss.dw.com/rdf/rss-en-all', type: 'rss' },
  { name: 'Reuters — Top News', url: 'https://feeds.reuters.com/reuters/topNews', type: 'rss' },
  { name: 'Bloomberg — Markets', url: 'https://feeds.bloomberg.com/markets/news.rss', type: 'rss' },
  { name: 'Bloomberg — Business', url: 'https://feeds.bloomberg.com/business/news.rss', type: 'rss' },
  { name: 'Nature — Main', url: 'https://www.nature.com/nature.rss', type: 'rss' },
  { name: 'TechCrunch — All', url: 'https://techcrunch.com/feed/', type: 'rss' },
  { name: 'MIT Technology Review — All', url: 'https://www.technologyreview.com/feed/', type: 'rss' },
  { name: 'The Lancet — Current Issue', url: 'https://thelancet.com/rssfeed/lancet_current.xml', type: 'rss' }
];

const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'media:content'],
      ['media:thumbnail', 'media:thumbnail'],
      ['content:encoded', 'content:encoded']
    ]
  }
});

function classify(text) {
  const rules = {
    tech: /(AI|هوش مصنوعی|technology|tech|Apple|Google|Microsoft|chip|semiconductor|startup|استارتاپ|تکنولوژی)/i,
    business: /(economy|market|stock|IPO|merger|acquisition|بازار|سهام|اقتصاد)/i,
    sport: /(league|cup|football|tennis|match|goal|ورزش|فوتبال)/i,
    science: /(science|research|study|journal|دانش|پژوهش|علم)/i,
    world: /(president|minister|election|diplomacy|UN|سازمان ملل|انتخابات|G7|NATO|جنگ|آتش‌بس)/i
  };
  for (const [k, re] of Object.entries(rules)) if (re.test(text)) return k;
  return 'general';
}

function detectLang(text) {
  const code = franc(text || '', { minLength: 10 });
  return code === 'und' ? 'und' : code;
}

async function translateText(text, target = 'fa') {
  if (!text) return text;
  try {
    if (PROVIDER === 'deepl') {
      const key = process.env.DEEPL_API_KEY;
      if (!key) return text;
      const resp = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ auth_key: key, text, target_lang: target.toUpperCase() })
      });
      const json = await resp.json();
      return json.translations?.[0]?.text || text;
    } else if (PROVIDER === 'google') {
      const key = process.env.GOOGLE_KEY;
      if (!key) return text;
      const resp = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, target })
      });
      const json = await resp.json();
      return json.data?.translations?.[0]?.translatedText || text;
    } else { // libre (default)
      const resp = await fetch(LIBRE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: 'auto', target: target, format: 'text' })
      });
      const json = await resp.json();
      return json.translatedText || text;
    }
  } catch {
    return text;
  }
}

function absoluteUrl(u, base) {
  try { return new URL(u, base).toString(); } catch { return u; }
}

function extractImage(item, baseUrl) {
  let u = item.enclosure?.url;
  if (!u && item['media:content']?.url) u = item['media:content'].url;
  if (!u && item['media:thumbnail']?.url) u = item['media:thumbnail'].url;
  if (u) return absoluteUrl(u, baseUrl);
  const html = item['content:encoded'] || item.content || '';
  if (html) {
    const $ = cheerio.load(html);
    const img = $('img[src]').first().attr('src');
    if (img) return absoluteUrl(img, baseUrl);
  }
  return undefined;
}

async function fetchOgImage(url) {
  try {
    const resp = await fetch(url, { redirect: 'follow' });
    const html = await resp.text();
    const $ = cheerio.load(html);
    const og = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
    return og ? absoluteUrl(og, url) : undefined;
  } catch { return undefined; }
}

function cleanSummary(raw) {
  if (!raw) return '';
  try {
    let txt = htmlToText(raw, { selectors: [{ selector: 'a', options: { ignoreHref: true } }], wordwrap: false });
    txt = txt.replace(/\s+/g, ' ').trim();
    if (txt.length > 420) txt = txt.slice(0, 420) + '…';
    return txt;
  } catch { return raw; }
}

async function run() {
  const results = [];
  for (const s of SOURCES) {
    try {
      const feed = await parser.parseURL(s.url);
      for (const item of feed.items) {
        if (!item.link || !item.title) continue;
        const url = item.link;
        const title = item.title;
        const publishedAt = item.isoDate ? new Date(item.isoDate) : new Date();
        let summaryRaw = item.contentSnippet || item.summary || item.content || '';
        if (!summaryRaw && item['content:encoded']) summaryRaw = item['content:encoded'];
        const summary = cleanSummary(summaryRaw);

        let imageUrl = extractImage(item, url);
        if (!imageUrl) imageUrl = await fetchOgImage(url);

        const cat = classify(`${title} ${summary}`);
        const lang = detectLang(`${title}\n${summary}`);
        const titleFa = await translateText(title, TARGET_LANG);
        const summaryFa = summary ? await translateText(summary, TARGET_LANG) : '';

        results.push({
          id: `${s.name}:${url}`.slice(0,190),
          url, source: SOURCE_FA.get(s.name) || 'منبع خارجی',
          title, titleFa, summary, summaryFa,
          imageUrl, category: cat,
          publishedAt, langOriginal: lang, langTranslated: TARGET_LANG
        });
      }
    } catch (e) {
      console.error('Fetch error for', s.name, e?.message || e);
    }
  }

  const map = new Map();
  for (const r of results) if (!map.has(r.url)) map.set(r.url, r);
  const items = Array.from(map.values()).sort((a,b)=> new Date(b.publishedAt) - new Date(a.publishedAt));

  const outDir = path.join(process.cwd(), 'public');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'articles.json'), JSON.stringify(items, null, 2), 'utf-8');
  console.log('Wrote public/articles.json with', items.length, 'items');
}

run();
