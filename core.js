/* Kimi core — pure logic shared by the app (window) and the service worker (importScripts).
   Dates are stored as local "YYYY-MM-DDTHH:MM" strings. No DOM access in this file. */
(function (root) {
  'use strict';

  /* ───────── Date helpers ───────── */
  const pad = n => String(n).padStart(2, '0');
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function toLocal(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fromLocal(s) {
    if (!s) return null;
    const [date, time = '09:00'] = s.split('T');
    const [y, m, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    return new Date(y, m - 1, d, h || 0, mi || 0, 0, 0);
  }
  function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function addMonths(d, n, anchorDay) {
    const day = anchorDay || d.getDate();
    const x = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes());
    x.setDate(Math.min(day, daysInMonth(x.getFullYear(), x.getMonth())));
    return x;
  }
  function setTime(d, h, m) { const x = new Date(d); x.setHours(h, m || 0, 0, 0); return x; }
  function dayDiff(a, b) { return Math.round((dateOnly(b) - dateOnly(a)) / 86400000); }
  function parseHM(s) { const [h, m] = String(s || '09:00').split(':').map(Number); return [h || 0, m || 0]; }

  /* ───────── Recurrence ─────────
     repeat = null | { freq: 'day'|'week'|'month'|'year', n: 1, weekdays?: true, day?: 1-31 } */
  const REPEAT_PRESETS = {
    none: null,
    daily: { freq: 'day', n: 1 },
    weekdays: { freq: 'day', n: 1, weekdays: true },
    weekly: { freq: 'week', n: 1 },
    biweekly: { freq: 'week', n: 2 },
    monthly: { freq: 'month', n: 1 },
    quarterly: { freq: 'month', n: 3 },
    yearly: { freq: 'year', n: 1 }
  };
  function repeatKey(r) {
    if (!r) return 'none';
    for (const k in REPEAT_PRESETS) {
      const p = REPEAT_PRESETS[k];
      if (p && p.freq === r.freq && p.n === (r.n || 1) && !!p.weekdays === !!r.weekdays) return k;
    }
    return 'custom';
  }
  function nextOccurrence(dueStr, repeat) {
    const d = fromLocal(dueStr);
    if (!repeat || !d) return null;
    const n = repeat.n || 1;
    let x;
    if (repeat.freq === 'day') {
      x = addDays(d, n);
      if (repeat.weekdays) while (x.getDay() === 0 || x.getDay() === 6) x = addDays(x, 1);
    } else if (repeat.freq === 'week') x = addDays(d, 7 * n);
    else if (repeat.freq === 'month') x = addMonths(d, n, repeat.day);
    else if (repeat.freq === 'year') x = addMonths(d, 12 * n, repeat.day);
    else return null;
    return toLocal(x);
  }
  function repeatLabel(r, dueStr) {
    if (!r) return 'One time';
    const n = r.n || 1;
    const d = fromLocal(dueStr);
    if (r.freq === 'day') return r.weekdays ? 'Every weekday' : n === 1 ? 'Every day' : 'Every ' + n + ' days';
    if (r.freq === 'week') {
      const dn = d ? DAYS[d.getDay()][0].toUpperCase() + DAYS[d.getDay()].slice(1) : '';
      if (n === 1) return dn ? 'Every ' + dn : 'Every week';
      if (n === 2) return dn ? 'Every other ' + dn : 'Every 2 weeks';
      return 'Every ' + n + ' weeks';
    }
    if (r.freq === 'month') {
      const day = r.day || (d && d.getDate());
      if (n === 1) return day ? 'Monthly on the ' + ordinal(day) : 'Every month';
      if (n === 3) return 'Every 3 months';
      return 'Every ' + n + ' months';
    }
    if (r.freq === 'year') return n === 1 ? (d ? 'Yearly on ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate() : 'Every year') : 'Every ' + n + ' years';
    return 'Repeats';
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  /* Rough monthly cost of a recurring amount */
  function monthlyEquivalent(amount, r) {
    if (!amount) return 0;
    if (!r) return 0;
    const n = r.n || 1;
    if (r.freq === 'day') return r.weekdays ? amount * 21.7 : amount * 30.44 / n;
    if (r.freq === 'week') return amount * 4.345 / n;
    if (r.freq === 'month') return amount / n;
    if (r.freq === 'year') return amount / (12 * n);
    return 0;
  }

  /* ───────── Actions shared with the service worker ───────── */
  function completeReminder(rem, now) {
    now = now || new Date();
    rem.history = rem.history || [];
    rem.history.unshift({ at: toLocal(now), due: rem.base || rem.due });
    if (rem.history.length > 24) rem.history.length = 24;
    rem.lastDoneAt = toLocal(now);
    if (rem.repeat) {
      let next = nextOccurrence(rem.base || rem.due, rem.repeat);
      // Tasks catch up to the future; bills advance one period at a time (each period is a payment)
      if (rem.type === 'task') {
        let guard = 0;
        while (next && fromLocal(next) <= now && guard++ < 1000) next = nextOccurrence(next, rem.repeat);
      }
      rem.base = next;
      rem.due = next;
      rem.alertedFor = null;
      return { next };
    }
    rem.done = true;
    rem.doneAt = toLocal(now);
    return { next: null };
  }
  function snoozeReminder(rem, untilDate) {
    if (!rem.base) rem.base = rem.due;
    rem.due = toLocal(untilDate);
    rem.alertedFor = null;
    rem.snoozed = (rem.snoozed || 0) + 1;
  }
  function dueReminders(state, now) {
    now = now || new Date();
    return (state.reminders || []).filter(r => !r.done && r.due && fromLocal(r.due) <= now && r.alertedFor !== r.due);
  }

  /* ───────── Formatting ───────── */
  function fmtTime(d) {
    let h = d.getHours(); const m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + (m ? ':' + pad(m) : '') + ' ' + ap;
  }
  function whenLabel(dueStr, now) {
    now = now || new Date();
    const d = fromLocal(dueStr);
    if (!d) return 'No date';
    const diff = dayDiff(now, d);
    let day;
    if (diff === 0) day = 'Today';
    else if (diff === 1) day = 'Tomorrow';
    else if (diff === -1) day = 'Yesterday';
    else if (diff > 1 && diff < 7) day = DAYS_SHORT[d.getDay()];
    else day = DAYS_SHORT[d.getDay()] + ', ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
    return day + ' · ' + fmtTime(d);
  }
  function speakWhen(dueStr, now) {
    now = now || new Date();
    const d = fromLocal(dueStr);
    if (!d) return '';
    const diff = dayDiff(now, d);
    const t = fmtTime(d).replace(':00', '').replace(' AM', ' a.m.').replace(' PM', ' p.m.');
    if (diff === 0) return 'today at ' + t;
    if (diff === 1) return 'tomorrow at ' + t;
    const dn = DAYS[d.getDay()][0].toUpperCase() + DAYS[d.getDay()].slice(1);
    if (diff > 1 && diff < 7) return dn + ' at ' + t;
    return dn + ', ' + MONTHS[d.getMonth()][0].toUpperCase() + MONTHS[d.getMonth()].slice(1) + ' ' + d.getDate() + ' at ' + t;
  }
  function relative(dueStr, now) {
    now = now || new Date();
    const d = fromLocal(dueStr);
    const mins = Math.round((d - now) / 60000);
    const abs = Math.abs(mins);
    let s;
    if (abs < 1) return 'now';
    if (abs < 60) s = abs + ' min';
    else if (abs < 60 * 24) s = Math.round(abs / 60) + ' hr';
    else { const days = Math.abs(dayDiff(now, d)); s = days + (days === 1 ? ' day' : ' days'); }
    return mins < 0 ? s + ' ago' : 'in ' + s;
  }
  const CURRENCIES = {
    PHP: { sym: '₱', label: 'Philippine peso' }, USD: { sym: '$', label: 'US dollar' }, AUD: { sym: 'A$', label: 'Australian dollar' },
    NZD: { sym: 'NZ$', label: 'NZ dollar' }, SGD: { sym: 'S$', label: 'Singapore dollar' }, CAD: { sym: 'C$', label: 'Canadian dollar' },
    EUR: { sym: '€', label: 'Euro' }, GBP: { sym: '£', label: 'British pound' }, JPY: { sym: '¥', label: 'Japanese yen' }
  };
  function money(amount, cur) {
    if (amount == null || isNaN(amount)) return '';
    const sym = (CURRENCIES[cur] || { sym: (cur || '') + ' ' }).sym;
    const dec = Math.abs(amount % 1) > 0.001 ? 2 : 0;
    return sym + Number(amount).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: 2 });
  }

  /* ───────── Natural-language parser ───────── */
  const NUM_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, 'fourty five': 45, 'forty five': 45
  };
  const ORD_WORDS = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
    eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty-first': 21, 'twenty first': 21, 'twenty-second': 22,
    'twenty second': 22, 'twenty-third': 23, 'twenty third': 23, 'twenty-fourth': 24, 'twenty fourth': 24,
    'twenty-fifth': 25, 'twenty fifth': 25, 'twenty-sixth': 26, 'twenty sixth': 26, 'twenty-seventh': 27,
    'twenty seventh': 27, 'twenty-eighth': 28, 'twenty eighth': 28, 'twenty-ninth': 29, 'twenty ninth': 29,
    thirtieth: 30, 'thirty-first': 31, 'thirty first': 31
  };
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const DAY_RE = '(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?';
  const monthIndex = s => MONTHS.findIndex(m => m.startsWith(s.toLowerCase().slice(0, 3)));
  const dayIndex = s => DAYS.findIndex(d => d.startsWith(s.toLowerCase().slice(0, 3)));
  const num = s => parseFloat(String(s).replace(/,/g, ''));

  const SUB_WORDS = /\b(subscriptions?|subscribe|membership|netflix|spotify|canva|youtube premium|youtube|disney\+?|icloud|google one|google workspace|chatgpt|claude|adobe|microsoft 365|office 365|domain|hosting|premium|apple music|prime video|amazon prime|hbo|viu|vivamax|notion|zoom|dropbox|patreon|gym membership|renew(?:al)?)\b/i;
  const BILL_WORDS = /\b(pay|paying|bills?|payment|rent|electric(?:ity)?|meralco|veco|water bill|maynilad|manila water|internet|pldt|globe|converge|smart|sky ?cable|wi-?fi|loan|amortization|installment|insurance|credit card|card due|tuition|tax(?:es)?|dues|association dues|sss|pag-?ibig|philhealth|bir|mortgage|condo|utilities|phone bill|postpaid)\b/i;

  /* Light Taglish support: map common Filipino time words to English before parsing */
  const TAGLISH = [
    [/\bmamayang gabi\b/gi, 'tonight'], [/\bmamayang hapon\b/gi, 'this afternoon'], [/\bmamaya\b/gi, 'later today'],
    [/\bbukas ng umaga\b/gi, 'tomorrow morning'], [/\bbukas ng gabi\b/gi, 'tomorrow night'], [/\bbukas ng hapon\b/gi, 'tomorrow afternoon'],
    [/\bsa makalawa\b/gi, 'day after tomorrow'], [/\bbukas\b/gi, 'tomorrow'], [/\bngayong araw\b/gi, 'today'], [/\bngayon\b/gi, 'today'],
    [/\b(araw-araw|araw araw)\b/gi, 'every day'], [/\b(buwan-buwan|buwan buwan|kada buwan|tuwing buwan)\b/gi, 'every month'],
    [/\b(linggo-linggo|kada linggo)\b/gi, 'every week'], [/\b(taon-taon|kada taon)\b/gi, 'every year'],
    [/\b(magbayad ng|magbayad|bayaran ang|bayaran|bayad sa|bayad)\b/gi, 'pay'], [/\bpaalala(han mo ako)?\b/gi, 'remind me'],
    [/\b(piso)\b/gi, 'pesos']
  ];

  function parse(input, opts) {
    opts = opts || {};
    const now = opts.now ? new Date(opts.now) : new Date();
    const defCur = opts.currency || 'PHP';
    const [defH, defM] = parseHM(opts.defaultTime || '09:00');
    const raw = String(input || '').trim();

    let w = ' ' + raw + ' ';
    const lower = () => w.toLowerCase();
    // Remove every remaining occurrence (used for repeat phrases said twice, e.g. "monthly ... every month")
    const takeAll = (re, fn) => { let m, first = null, g = 0; while (g++ < 5 && (m = take(re, fn))) first = first || m; return first; };
    const take = (re, fn) => {
      const m = w.match(re);
      if (!m) return null;
      const r = fn ? fn(m) : true;
      if (r === false) return null;
      w = w.slice(0, m.index) + ' ' + w.slice(m.index + m[0].length);
      return m;
    };

    // Normalise
    for (const [re, rep] of TAGLISH) w = w.replace(re, rep);
    w = w.replace(/\b(a|p)\.\s?m\.?/gi, (m, x) => x.toLowerCase() + 'm')
      .replace(/\bo'?\s?clock\b/gi, '')
      .replace(/\b(tmrw|tmr|tomorow|tommorow|tommorrow)\b/gi, 'tomorrow')
      .replace(/\btoday's\b/gi, 'today')
      .replace(/\bhalf an hour\b/gi, '30 minutes')
      .replace(/\bhalf a day\b/gi, '12 hours')
      .replace(/\ban hour and a half\b/gi, '90 minutes')
      .replace(/\b(couple of|couple)\b/gi, '2')
      .replace(/\b(few)\b/gi, '3');
    // ordinal words ("the fifteenth")
    for (const k of Object.keys(ORD_WORDS).sort((a, b) => b.length - a.length)) {
      w = w.replace(new RegExp('\\b' + k + '\\b', 'gi'), ORD_WORDS[k] + 'th');
    }
    // number words in time/date contexts
    const NW = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|');
    w = w.replace(new RegExp('\\b(in|at|every|for|around|by)\\s+(' + NW + ')\\b', 'gi'), (m, p, n) => p + ' ' + NUM_WORDS[n.toLowerCase()]);
    const NW2 = NW.split('|').filter(x => x !== 'a' && x !== 'an').join('|');
    w = w.replace(new RegExp('\\b(' + NW2 + ')\\s+(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|am|pm)\\b', 'gi'), (m, n, u) => NUM_WORDS[n.toLowerCase()] + ' ' + u);
    // "1,299.00" keep, but "1 299" no.

    const out = { title: '', type: 'task', due: null, repeat: null, amount: null, currency: defCur, guessed: false, heard: raw };
    let date = null;          // Date (day precision)
    let exact = null;         // Date with exact time (relative "in 2 hours")
    let time = null;          // [h, m]
    let part = null;          // morning|afternoon|evening|night
    let monthDay = null;      // anchor day for monthly repeats
    let weekDay = null;       // anchor weekday for weekly repeats

    // Strip assistant trigger phrases
    take(/^\s*(hey|hi|ok|okay|hello)?[\s,]*(kimi)?[\s,!.]*/i);
    take(/^\s*(please\s+)?((can|could|would|will) you\s+)?(please\s+)?(set|add|create|make|put)\s+(a|an|me a)?\s*(new\s+)?(reminder|task|note|alarm)\s*(for me\s*)?(to|that|about|for)?\s+/i);
    take(/^\s*(please\s+)?((can|could|would|will) you\s+)?(please\s+)?(remind me|remember|don'?t let me forget|don'?t forget|do not forget|i need to remember|i have to remember|note that)(\s+(to|that|about|of))?\s+/i);
    take(/^\s*(i\s+)?(need to|have to|got to|gotta|must|should|want to|wanna|'ve got to|ve got to)\s+/i);
    // mid-sentence "remind me"
    while (take(/[,.;]?\s*(and\s+)?(please\s+)?(remind me|reminder)(\s+(to|about|of|that))?\b/i)) { /* strip */ }

    /* Amounts with currency (before times so "at 3" isn't money) */
    const curMap = s => {
      s = s.toLowerCase().replace(/\s/g, '');
      if (/^(₱|php|p|pesos?|piso)$/.test(s)) return 'PHP';
      if (/^(a\$|aud|australiandollars?)$/.test(s)) return 'AUD';
      if (/^(us\$|usd|usdollars?)$/.test(s)) return 'USD';
      if (/^(nz\$|nzd)$/.test(s)) return 'NZD';
      if (/^(s\$|sgd)$/.test(s)) return 'SGD';
      if (/^(c\$|cad)$/.test(s)) return 'CAD';
      if (/^(€|eur|euros?)$/.test(s)) return 'EUR';
      if (/^(£|gbp|pounds?)$/.test(s)) return 'GBP';
      if (/^(¥|jpy|yen)$/.test(s)) return 'JPY';
      if (/^(\$|dollars?|bucks)$/.test(s)) return ['AUD', 'USD', 'NZD', 'SGD', 'CAD'].includes(defCur) ? defCur : 'USD';
      return defCur;
    };
    const kMult = k => (k && /k/i.test(k) ? 1000 : 1);
    take(/(?:^|\s)(₱|php|a\$|us\$|nz\$|s\$|c\$|aud|usd|nzd|sgd|cad|eur|gbp|jpy|€|£|¥|\$|P(?=\d))\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k\b)?/i, m => {
      out.amount = num(m[2]) * kMult(m[3]); out.currency = curMap(m[1]);
    }) ||
    take(/(\d[\d,]*(?:\.\d{1,2})?)\s?(k\b)?\s*(pesos?|piso|php|dollars?|bucks|usd|aud|nzd|sgd|cad|euros?|eur|pounds?|gbp|yen|jpy)\b/i, m => {
      out.amount = num(m[1]) * kMult(m[2]); out.currency = curMap(m[3]);
    });

    /* Recurrence */
    const setRepeat = r => { if (!out.repeat) out.repeat = r; };
    takeAll(/\b(every|each)\s+(other|second|2nd)\s+week\b|\bbi-?weekly\b|\bfortnightly\b|\bevery\s+2\s+weeks\b/i, () => setRepeat({ freq: 'week', n: 2 }));
    takeAll(/\b(every|each|on)\s+(weekdays?|work\s?days?|business days?)\b|\bweekdays\b|\bmonday (to|through|thru) friday\b/i, () => setRepeat({ freq: 'day', n: 1, weekdays: true }));
    take(new RegExp('\\b(every|each)\\s+(other\\s+)?' + DAY_RE + 's?\\b', 'i'), m => {
      weekDay = dayIndex(m[3]); setRepeat({ freq: 'week', n: m[2] ? 2 : 1 });
    }) ||
    takeAll(new RegExp('\\b(?:on\\s+)?' + DAY_RE.replace('(?:day)?', 'days') + '\\b', 'i'), m => { if (weekDay == null) weekDay = dayIndex(m[1]); setRepeat({ freq: 'week', n: 1 }); });
    take(/\b(?:every|each)\s+(\d+)\s+(day|week|month|year)s?\b/i, m => setRepeat({ freq: m[2].toLowerCase(), n: parseInt(m[1], 10) }));
    take(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+)?of\s+(?:every|each|the)\s+month\b/i, m => { monthDay = parseInt(m[1], 10); setRepeat({ freq: 'month', n: 1 }); });
    take(/\b(?:every|each)\s+(?:month\s+on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b(?:\s+of\s+the\s+month)?/i, m => { monthDay = parseInt(m[1], 10); setRepeat({ freq: 'month', n: 1 }); });
    take(/\b(every|each)\s+(morning|night|evening|afternoon)\b/i, m => { part = m[2].toLowerCase(); setRepeat({ freq: 'day', n: 1 }); });
    takeAll(/\b(every\s?day|each day|daily|everyday|every single day|per day|a day)\b/i, m => {
      if (/^(per day|a day)$/i.test(m[1]) && out.amount == null && !/\d/.test(raw)) return false;
      setRepeat({ freq: 'day', n: 1 });
    });
    takeAll(/\b(every|each)\s+quarter\b|\bquarterly\b|\bevery\s+3\s+months\b/i, () => setRepeat({ freq: 'month', n: 3 }));
    takeAll(/\b(every|each)\s+week\b|\bweekly\b|\bper week\b|\ba week\b|\/\s?w(ee)?k\b/i, m => {
      if (/^a week$/i.test(m[0]) && out.amount == null && !/\d/.test(raw)) return false;
      setRepeat({ freq: 'week', n: 1 });
    });
    takeAll(/\b(every|each)\s+month\b|\bmonthly\b|\bper month\b|\ba month\b|\/\s?mo(nth)?\b|\bmonth(ly)? subscription\b/i, m => {
      if (/^a month$/i.test(m[0]) && out.amount == null && !/\d/.test(raw)) return false;
      if (/subscription/i.test(m[0])) { setRepeat({ freq: 'month', n: 1 }); return false; }
      setRepeat({ freq: 'month', n: 1 });
    });
    takeAll(/\b(every|each)\s+year\b|\byearly\b|\bannually\b|\bannual\b|\bper year\b|\ba year\b|\/\s?y(ea)?r\b/i, m => {
      if (/^a year$/i.test(m[0]) && out.amount == null && !/\d/.test(raw)) return false;
      setRepeat({ freq: 'year', n: 1 });
    });
    if (out.repeat && out.repeat.freq === 'month' && monthDay) out.repeat.day = monthDay;

    /* Part of day */
    take(/\b(tonight|this evening|this afternoon|this morning)\b/i, m => {
      const s = m[1].toLowerCase();
      date = dateOnly(now);
      part = s === 'tonight' ? 'night' : s.split(' ')[1];
    });
    w = w.replace(new RegExp('\\b(tomorrow|today|' + DAY_RE + ')\\s+(morning|afternoon|evening|night)\\b', 'i'), (m, d, x, p) => { part = p.toLowerCase(); return d; });
    take(/\b(?:(?:in the|at|during the|during|by|before|after|over|around)\s+(morning|afternoon|evening|night|lunch\s?time|lunch))\b|\b(noon|midday|midnight|lunchtime|end of (?:the )?day|eod|after work|before bed|bedtime)\b/i, m => {
      m = [m[0], m[1] || m[2]];
      const s = m[1].toLowerCase().replace(/\s/g, '');
      if (/lunch|noon|midday/.test(s)) time = [12, 0];
      else if (s === 'midnight') time = [23, 59];
      else if (/endof|eod|afterwork/.test(s)) time = [17, 0];
      else if (/bed/.test(s)) time = [21, 30];
      else part = s;
    });

    /* Relative: in N minutes/hours/days/weeks/months */
    w = w.replace(/\b(\d+|a|an)\s+(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+from\s+(now|today)\b/i, (m, n, u) => 'in ' + (/^an?$/i.test(n) ? 1 : n) + ' ' + u);
    take(/\bin\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b/i, m => {
      const n = parseFloat(m[1]); const u = m[2].toLowerCase();
      if (/^m(in|inute)/.test(u)) exact = new Date(now.getTime() + n * 60000);
      else if (/^h/.test(u)) exact = new Date(now.getTime() + n * 3600000);
      else if (/^d/.test(u)) date = addDays(dateOnly(now), n);
      else if (/^w/.test(u)) date = addDays(dateOnly(now), 7 * n);
      else if (/^mo/.test(u)) date = addMonths(dateOnly(now), n);
      else if (/^y/.test(u)) date = addMonths(dateOnly(now), 12 * n);
    }) ||
    take(/\b(in a (bit|while|few|moment|sec)|shortly|soon|later)\b(?!\s+today)/i, () => { exact = new Date(now.getTime() + 30 * 60000); });
    take(/\blater today\b/i, () => {
      const t = new Date(now.getTime() + 3 * 3600000);
      exact = t.getDate() === now.getDate() ? new Date(Math.ceil(t.getTime() / 900000) * 900000) : setTime(now, 21, 0);
    });

    /* Named days */
    take(/\b(?:the\s+)?day after tomorrow\b/i, () => { date = addDays(dateOnly(now), 2); });
    take(/\btomorrow\b/i, () => { date = addDays(dateOnly(now), 1); });
    take(/\btoday\b|\bnow\b/i, () => { if (!date) date = dateOnly(now); });
    take(/\b(?:at the\s+|by the\s+)?end of (?:the\s+)?(week|month|year)\b|\b(?:by\s+)?(?:the\s+)?(?:start|beginning) of (?:the\s+)?(next\s+)?(week|month|year)\b/i, m => {
      const t = dateOnly(now);
      if (m[1]) {
        const u = m[1].toLowerCase();
        if (u === 'week') date = addDays(t, (5 - t.getDay() + 7) % 7);
        else if (u === 'month') date = new Date(t.getFullYear(), t.getMonth(), daysInMonth(t.getFullYear(), t.getMonth()));
        else date = new Date(t.getFullYear(), 11, 31);
      } else {
        const u = m[3].toLowerCase();
        if (u === 'week') date = addDays(t, ((1 - t.getDay() + 7) % 7) || 7);
        else if (u === 'month') date = new Date(t.getFullYear(), t.getMonth() + 1, 1);
        else date = new Date(t.getFullYear() + 1, 0, 1);
      }
    });
    take(/\bnext\s+(week|month|year)\b/i, m => {
      const t = dateOnly(now); const u = m[1].toLowerCase();
      if (u === 'week') date = addDays(t, ((1 - t.getDay() + 7) % 7) || 7);
      else if (u === 'month') date = new Date(t.getFullYear(), t.getMonth() + 1, 1);
      else date = new Date(t.getFullYear() + 1, 0, 1);
    });
    take(/\b(this|next)?\s*weekend\b/i, m => {
      const t = dateOnly(now);
      let d = addDays(t, (6 - t.getDay() + 7) % 7);
      if (m[1] && m[1].toLowerCase() === 'next') d = addDays(d, 7);
      date = d;
    });

    /* Month + day ("October 15", "15th of October", "Oct 15 2027", "December") */
    const pickYear = (mi, d, y) => {
      if (y) return new Date(y, mi, d);
      let x = new Date(now.getFullYear(), mi, d);
      if (x < dateOnly(now)) x = new Date(now.getFullYear() + 1, mi, d);
      return x;
    };
    take(new RegExp('\\b(?:on\\s+|by\\s+|the\\s+)*' + MONTH_RE + '\\.?\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s*(\\d{4}))?\\b', 'i'), m => {
      date = pickYear(monthIndex(m[1]), parseInt(m[2], 10), m[3] && parseInt(m[3], 10));
    }) ||
    take(new RegExp('\\b(?:on\\s+|by\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MONTH_RE + '\\b(?:,?\\s*(\\d{4}))?', 'i'), m => {
      date = pickYear(monthIndex(m[2]), parseInt(m[1], 10), m[3] && parseInt(m[3], 10));
    }) ||
    take(new RegExp('\\b(in|on|by|this|next|of|during|until|before|for|start of|end of)\\s+' + MONTH_RE + '\\b(?:\\s+(\\d{4}))?', 'i'), m => {
      const mi = monthIndex(m[2]);
      const y = m[3] ? parseInt(m[3], 10) : null;
      const end = /end of/i.test(m[1]);
      if (y) date = new Date(y, mi, end ? daysInMonth(y, mi) : 1);
      else {
        let yy = now.getFullYear();
        if (mi < now.getMonth()) yy++;
        date = new Date(yy, mi, end ? daysInMonth(yy, mi) : 1);
        if (mi === now.getMonth() && !end) date = dateOnly(now);
        if (date < dateOnly(now)) date = new Date(yy + 1, mi, end ? daysInMonth(yy + 1, mi) : 1);
      }
    }) ||
    take(new RegExp('\\b(jan(?:uary)?|feb(?:ruary)?|april|june|july|aug(?:ust)?|sept(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b', 'i'), m => {
      const mi = monthIndex(m[1]);
      let yy = now.getFullYear(); if (mi < now.getMonth()) yy++;
      date = mi === now.getMonth() ? dateOnly(now) : new Date(yy, mi, 1);
    });
    /* Numeric dates 10/15 or 15/10(/2026) — month first unless impossible */
    take(/\b(?:on\s+|by\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, m => {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      let mo = a, d = b;
      if (opts.dayFirst || a > 12) { mo = b; d = a; }
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
      let y = m[3] ? parseInt(m[3], 10) : null; if (y && y < 100) y += 2000;
      date = pickYear(mo - 1, d, y);
    });

    /* Weekday ("on Friday", "next Monday", "this Thursday") */
    take(new RegExp('\\b(?:on\\s+|by\\s+|until\\s+|before\\s+)?(this|next|coming|this coming)?\\s*' + DAY_RE + '\\b', 'i'), m => {
      const wd = dayIndex(m[2]);
      const t = dateOnly(now);
      let diff = (wd - t.getDay() + 7) % 7;
      const mod = (m[1] || '').toLowerCase();
      if (diff === 0 && mod !== 'this') diff = 7;
      if (out.repeat && out.repeat.freq === 'week') { weekDay = wd; return; }
      date = addDays(t, diff);
    });

    /* "on the 15th" / "every 15th" handled; plain "the 15th" -> next occurrence of that day */
    take(/\b(?:on|by|before|until)?\s*the\s+(\d{1,2})(?:st|nd|rd|th)\b|\b(?:on|by)\s+(\d{1,2})(?:st|nd|rd|th)\b/i, m => {
      const d = parseInt(m[1] || m[2], 10);
      if (d < 1 || d > 31) return false;
      if (out.repeat && out.repeat.freq === 'month') { monthDay = d; out.repeat.day = d; return; }
      const t = dateOnly(now);
      let x = new Date(t.getFullYear(), t.getMonth(), Math.min(d, daysInMonth(t.getFullYear(), t.getMonth())));
      if (x < t) x = addMonths(new Date(t.getFullYear(), t.getMonth(), 1), 1, d);
      date = x;
    });

    /* Times */
    const applyMeridiem = (h, ap) => {
      ap = (ap || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      return h;
    };
    take(/\b(?:at|by|around|before|@)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i, m => {
      time = [applyMeridiem(parseInt(m[1], 10), m[3]), m[2] ? parseInt(m[2], 10) : 0];
      if (time[0] > 23 || time[1] > 59) { time = null; return false; }
    }) ||
    take(/\b(?:at|by|around|before|@)\s*(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:st|nd|rd|th|days?|weeks?|months?|years?|pesos?|php|dollars?|%))/i, m => {
      let h = parseInt(m[1], 10); const mi = m[2] ? parseInt(m[2], 10) : 0;
      if (h > 23 || mi > 59) return false;
      if (h <= 12) {
        if (part === 'afternoon' || part === 'evening' || part === 'night') { if (h < 12) h += 12; }
        else if (part === 'morning') { if (h === 12) h = 0; }
        else if (h >= 1 && h <= 6) h += 12; // "at 3" → 3 PM
        else if (h === 12) h = 12;
      }
      time = [h, mi];
    }) ||
    take(/\b(\d{1,2}):(\d{2})\b/, m => {
      const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
      if (h > 23 || mi > 59) return false;
      time = [h, mi];
    });
    if (time && part && time[0] < 12 && (part === 'evening' || part === 'night' || part === 'afternoon')) time[0] += 12;

    /* Bare amount when the sentence is clearly about money */
    const lw = raw.toLowerCase();
    const moneyish = SUB_WORDS.test(lw) || BILL_WORDS.test(lw) || /\b(costs?|price|fee|amount|worth|total|owe)\b/i.test(lw);
    if (out.amount == null && moneyish) {
      take(/(?:^|\s)(?:is|of|for|costs?|at|worth|=|amount(?: of)?|owe|pay)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{2,7}(?:\.\d{1,2})?)\b(?!\s*(?:st|nd|rd|th|am|pm|:|minutes?|hours?|days?|weeks?|months?|years?))/i, m => {
        const v = num(m[1]);
        if (v >= 1900 && v <= 2100 && !/,/.test(m[1])) return false; // looks like a year
        out.amount = v;
      });
    }

    /* Type */
    if (SUB_WORDS.test(lw)) out.type = 'subscription';
    else if (BILL_WORDS.test(lw) || (out.amount != null && out.repeat)) out.type = 'bill';
    else if (out.amount != null) out.type = 'bill';
    if (out.type === 'subscription' && !/\b(subscriptions?|membership|renew(al)?|domain|hosting|premium|plan)\b/i.test(lw) && !out.repeat && out.amount == null && BILL_WORDS.test(lw)) out.type = 'bill';

    /* Resolve due date/time */
    const partTime = { morning: [9, 0], afternoon: [14, 0], evening: [18, 0], night: [20, 0] };
    if (!time && part) time = partTime[part] || null;
    let due;
    if (exact) {
      due = exact;
      if (date && dayDiff(dateOnly(exact), date) !== 0) due = setTime(date, exact.getHours(), exact.getMinutes());
    } else if (date) {
      due = setTime(date, ...(time || [defH, defM]));
    } else if (out.repeat && out.repeat.freq === 'week' && weekDay != null) {
      const t = dateOnly(now);
      let x = addDays(t, (weekDay - t.getDay() + 7) % 7);
      x = setTime(x, ...(time || [defH, defM]));
      if (x <= now) x = addDays(x, 7);
      due = x;
    } else if (out.repeat && out.repeat.freq === 'month' && monthDay) {
      const t = dateOnly(now);
      let x = setTime(new Date(t.getFullYear(), t.getMonth(), Math.min(monthDay, daysInMonth(t.getFullYear(), t.getMonth()))), ...(time || [defH, defM]));
      if (x <= now) x = addMonths(x, 1, monthDay);
      due = x;
    } else if (time) {
      due = setTime(dateOnly(now), ...time);
      if (due <= now) due = addDays(due, 1);
      if (out.repeat && out.repeat.weekdays) while (due.getDay() === 0 || due.getDay() === 6) due = addDays(due, 1);
    } else if (out.repeat) {
      if (out.type !== 'task' && out.repeat.freq !== 'day') {
        // Money: assume it was just paid, so the next one is one period away
        due = fromLocal(nextOccurrence(toLocal(setTime(dateOnly(now), defH, defM)), out.repeat));
      } else {
        due = setTime(dateOnly(now), defH, defM);
        if (due <= now) due = addDays(due, 1);
        if (out.repeat.weekdays) while (due.getDay() === 0 || due.getDay() === 6) due = addDays(due, 1);
      }
    } else {
      // Nothing said about "when": pick a sensible slot and flag it so the UI asks
      out.guessed = true;
      due = now.getHours() < 17 ? setTime(dateOnly(now), 18, 0) : setTime(addDays(dateOnly(now), 1), defH, defM);
    }
    if (out.repeat && out.repeat.freq === 'week' && weekDay != null && due.getDay() !== weekDay) {
      let x = addDays(dateOnly(due), (weekDay - due.getDay() + 7) % 7);
      due = setTime(x, due.getHours(), due.getMinutes());
    }
    if (out.repeat && out.repeat.freq === 'month' && !out.repeat.day && due.getDate() > 28) out.repeat.day = due.getDate();
    if (out.repeat && out.repeat.weekdays) while (due.getDay() === 0 || due.getDay() === 6) due = addDays(due, 1);
    out.due = toLocal(due);

    /* Title */
    let t = w.replace(/\s+/g, ' ');
    t = t.replace(/[,;:!?]+/g, ' ').replace(/\s+\./g, ' ').replace(/\.+\s*$/, '').replace(/\s+/g, ' ').trim();
    const LEAD = /^(and|to|that|about|of|on|at|in|by|is|for|so|then|also|please|just|i have an?|i've got an?|there's an?|there is an?|i have|i|a reminder|reminder|me|due|starting|from|every|my\s+(?=reminder))\b\s*/i;
    const TRAIL = /\s*\b(on|at|in|by|for|and|to|is|are|the|every|each|of|that|due|due on|due date|this|next|starting|from|around|until|before|please|it|its|it's|which is|which|costs?|price|was|will be|be|remind me|reminder|for me|me|now|then|also|about|again|lang|po)$/i;
    let guard = 0, prev;
    do { prev = t; t = t.replace(LEAD, '').replace(TRAIL, '').trim(); } while (t !== prev && guard++ < 20);
    t = t.replace(/^my\s+/i, m => (out.type !== 'task' ? '' : m));
    t = t.replace(/\b(subscription|bill)\s+(is|are)\b/i, '$1').trim();
    t = t.replace(/\s{2,}/g, ' ').trim();
    if (!t || t.length < 2) t = out.type === 'bill' ? 'Bill payment' : out.type === 'subscription' ? 'Subscription' : (raw || 'Reminder');
    out.title = t.charAt(0).toUpperCase() + t.slice(1);
    return out;
  }

  /* ───────── Calendar export (.ics) ───────── */
  function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
  function icsDate(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + '00'; }
  function icsRule(r, dueStr) {
    if (!r) return '';
    const n = r.n || 1;
    if (r.freq === 'day') return r.weekdays ? 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' : 'FREQ=DAILY;INTERVAL=' + n;
    if (r.freq === 'week') return 'FREQ=WEEKLY;INTERVAL=' + n;
    if (r.freq === 'month') return 'FREQ=MONTHLY;INTERVAL=' + n + ';BYMONTHDAY=' + (r.day && r.day <= 28 ? r.day : fromLocal(dueStr).getDate() > 28 ? -1 : fromLocal(dueStr).getDate());
    if (r.freq === 'year') return 'FREQ=YEARLY;INTERVAL=' + n;
    return '';
  }
  function buildICS(reminders) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kimi//Reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    const stamp = new Date();
    const dtstamp = stamp.getUTCFullYear() + pad(stamp.getUTCMonth() + 1) + pad(stamp.getUTCDate()) + 'T' + pad(stamp.getUTCHours()) + pad(stamp.getUTCMinutes()) + '00Z';
    for (const r of reminders) {
      const d = fromLocal(r.due);
      if (!d) continue;
      const end = new Date(d.getTime() + 15 * 60000);
      const desc = [r.amount != null ? 'Amount: ' + money(r.amount, r.currency) : '', r.notes || '', 'Added by Kimi'].filter(Boolean).join('\n');
      lines.push('BEGIN:VEVENT', 'UID:' + r.id + '@kimi.app', 'DTSTAMP:' + dtstamp, 'DTSTART:' + icsDate(d), 'DTEND:' + icsDate(end),
        'SUMMARY:' + icsEscape((r.type === 'task' ? '' : r.type === 'bill' ? '🧾 ' : '🔁 ') + r.title + (r.amount != null ? ' (' + money(r.amount, r.currency) + ')' : '')),
        'DESCRIPTION:' + icsEscape(desc));
      const rule = icsRule(r.repeat, r.due);
      if (rule) lines.push('RRULE:' + rule);
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape(r.title), 'TRIGGER:-PT0M', 'END:VALARM');
      if (r.type !== 'task') lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape('Tomorrow: ' + r.title), 'TRIGGER:-P1D', 'END:VALARM');
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  const Core = {
    pad, toLocal, fromLocal, dateOnly, addDays, addMonths, setTime, dayDiff, parseHM,
    MONTHS, MONTHS_SHORT, DAYS, DAYS_SHORT, CURRENCIES, REPEAT_PRESETS,
    repeatKey, nextOccurrence, repeatLabel, ordinal, monthlyEquivalent,
    completeReminder, snoozeReminder, dueReminders,
    fmtTime, whenLabel, speakWhen, relative, money,
    parse, buildICS
  };
  root.KimiCore = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof self !== 'undefined' ? self : globalThis);
