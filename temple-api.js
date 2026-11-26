/**
 * temple-api.js — 全国の寺社仏閣データ取得モジュール
 *
 * 使うのは無料・APIキー不要のAPIだけです。
 *   - Overpass API (OpenStreetMap) … 神社・寺院の名称 / 緯度経度 / 住所タグ
 *   - Nominatim (OpenStreetMap)    … 住所タグが無いときの逆ジオコーディング（任意・1秒1件まで）
 *   - Wikipedia API (ja)           … 概要文
 *   - Wikidata API                 … 宗派（P140: 宗教・宗派）
 *
 * ブラウザでも Node.js 18 以降でも動きます（標準の fetch を使用）。
 *
 * 主な関数
 *   searchTemplesByPrefecture('京都府', { kind: 'buddhist', limit: 100 })
 *   searchTemplesNearby(35.0116, 135.7681, { radius: 1000 })
 *   fillMissingAddresses(places)   // 住所の無いものを Nominatim で補完
 *   enrichPlaces(places)           // Wikipedia / Wikidata で概要文・宗派を補完
 */

// ─────────────────────────────────────────────
// 設定
// ─────────────────────────────────────────────
export const CONFIG = {
  overpassEndpoints: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.osm.jp/api/interpreter',
  ],
  // 最初のサーバーがこの時間内に返事をしなければ、次のサーバーにも同時に問い合わせる
  overpassHedgeMs: 2000,
  nominatimEndpoint: 'https://nominatim.openstreetmap.org/reverse',
  nominatimSearchEndpoint: 'https://nominatim.openstreetmap.org/search',
  wikipediaApi: 'https://ja.wikipedia.org/w/api.php',
  wikidataApi: 'https://www.wikidata.org/w/api.php',
  // Nominatim の利用規約: 1秒に1リクエストまで
  nominatimIntervalMs: 1100,
  // Node.js から使う場合は連絡先入りの User-Agent を設定してください（ブラウザでは無視されます）
  userAgent: 'TempleSearchApp/0.1 (contact: you@example.com)',
  requestTimeoutMs: 30000,
  // 都道府県全体の検索は1分以上かかることがあるので Overpass だけ長めに待つ
  overpassTimeoutMs: 150000,
};

const IS_BROWSER = typeof window !== 'undefined';

// ─────────────────────────────────────────────
// 都道府県（OSM の ISO3166-2 タグで検索する）
// ─────────────────────────────────────────────
export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
].map((name, i) => ({ name, code: `JP-${String(i + 1).padStart(2, '0')}` }));

/** '京都府' / '京都' / 26 / 'JP-26' のどれでも都道府県を特定する */
export function resolvePrefecture(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (/^JP-\d{2}$/i.test(s)) return PREFECTURES.find((p) => p.code === s.toUpperCase()) || null;
  if (/^\d{1,2}$/.test(s)) return PREFECTURES[Number(s) - 1] || null;
  return (
    PREFECTURES.find((p) => p.name === s) ||
    // 「京都」「東京」「北海道」のように末尾の都道府県を省いた入力にも対応
    PREFECTURES.find((p) => p.name === s + '都' || p.name === s + '道' || p.name === s + '府' || p.name === s + '県') ||
    null
  );
}

// ─────────────────────────────────────────────
// 共通ユーティリティ
// ─────────────────────────────────────────────
// 一部の環境（Claude アプリのプレビュー画面など）では fetch に AbortSignal を渡すと
// "The object can not be cloned" エラーになる。その場合は signal なしで再実行し、
// タイムアウトは Promise.race で代用する。
let signalUnsupported = false;

function isCloneError(e) {
  return e && (e.name === 'DataCloneError' || /can ?not be cloned|could not be cloned/i.test(e.message || ''));
}

async function fetchJSON(url, init = {}) {
  const timeoutMs = init.timeoutMs || CONFIG.requestTimeoutMs;
  const host = new URL(url).host;
  const headers = { Accept: 'application/json', ...(init.headers || {}) };
  if (!IS_BROWSER && CONFIG.userAgent) headers['User-Agent'] = CONFIG.userAgent;
  const base = { method: init.method || 'GET', headers };
  if (init.body != null) base.body = init.body;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`タイムアウト（${timeoutMs / 1000}秒）: ${host}`)), timeoutMs);
  });

  const doFetch = async (useSignal) => {
    const opts = { ...base };
    let ctrl;
    if (useSignal) {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
      if (init.signal) init.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
      timeout.catch(() => ctrl.abort());
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText} (${host})`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  try {
    if (!signalUnsupported) {
      try {
        return await Promise.race([doFetch(true), timeout]);
      } catch (e) {
        if (!isCloneError(e)) throw e;
        signalUnsupported = true; // 以降は signal を使わない
      }
    }
    return await Promise.race([doFetch(false), timeout]);
  } catch (e) {
    if (e.name === 'TypeError') throw new Error(`接続できません（${host}）: ${e.message}`);
    if (isCloneError(e)) throw new Error(`この画面では通信できません（${host}）。Safari や Chrome で開いてください`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function qs(params) {
  return new URLSearchParams(params).toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 2点間の距離（メートル） */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 同時実行数を制限して map する */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** 名称比較用の正規化（空白・括弧書き・全角半角の揺れを除く） */
export function normalizeName(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/\s*[（(][^）)]*[）)]\s*/g, '') // 「八幡神社 (京都市)」→「八幡神社」
    .replace(/[\s・･]/g, '')
    .replace(/^宗教法人/, '')
    .toLowerCase();
}

// ─────────────────────────────────────────────
// 仕様1: Overpass API で神社・寺院を取得
// ─────────────────────────────────────────────
const RELIGION_REGEX = {
  all: '^(shinto|buddhist)$',
  shinto: '^shinto$',
  buddhist: '^buddhist$',
};

/** Overpass QL を組み立てる */
export function buildOverpassQuery({ prefectureCode, around, bbox, kind = 'all', limit = 200 }) {
  const religion = RELIGION_REGEX[kind] || RELIGION_REGEX.all;
  const filter = `["amenity"="place_of_worship"]["religion"~"${religion}"]["name"]`;
  if (prefectureCode) {
    return [
      '[out:json][timeout:120];',
      `area["ISO3166-2"="${prefectureCode}"]["admin_level"="4"]->.pref;`,
      `nwr${filter}(area.pref);`,
      `out center tags qt ${limit};`,
    ].join('\n');
  }
  if (around) {
    const { lat, lon, radius } = around;
    return [
      '[out:json][timeout:60];',
      `nwr${filter}(around:${radius},${lat},${lon});`,
      `out center tags qt ${limit};`,
    ].join('\n');
  }
  if (bbox) {
    const f = (n) => Number(n).toFixed(6);
    return [
      '[out:json][timeout:90];',
      `nwr${filter}(${f(bbox.south)},${f(bbox.west)},${f(bbox.north)},${f(bbox.east)});`,
      `out center tags qt ${limit};`,
    ].join('\n');
  }
  throw new Error('prefectureCode / around / bbox のどれかを指定してください');
}

// ── Overpass サーバーの速さの記録（速いサーバーから順に使う） ──
const STATS_KEY = 'temple-api:overpass-stats';
const endpointStats = (() => {
  try { return new Map(Object.entries(JSON.parse(globalThis.localStorage?.getItem(STATS_KEY) || '{}'))); } catch { return new Map(); }
})();
function recordEndpoint(url, ms, ok) {
  const s = endpointStats.get(url) || { avgMs: null, fails: 0 };
  if (ok) { s.avgMs = s.avgMs == null ? ms : Math.round(s.avgMs * 0.6 + ms * 0.4); s.fails = 0; }
  else s.fails = Math.min(s.fails + 1, 5);
  endpointStats.set(url, s);
  try { globalThis.localStorage?.setItem(STATS_KEY, JSON.stringify(Object.fromEntries(endpointStats))); } catch {}
}
function endpointScore(url) {
  const s = endpointStats.get(url);
  if (!s) return 4000; // まだ使ったことのないサーバーは「そこそこ速い」とみなして試す
  return (s.avgMs ?? 4000) + s.fails * 15000;
}
/** 速い順に並べたサーバー一覧 */
export function rankedOverpassEndpoints() {
  return CONFIG.overpassEndpoints
    .map((url, i) => ({ url, i, score: endpointScore(url) }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((e) => e.url);
}

/**
 * Overpass に問い合わせる。
 * 一番速いサーバーにまず送り、overpassHedgeMs 待っても返事がなければ次のサーバーにも送る。
 * 最初に返ってきた結果を使い、残りは中止する（混雑したサーバーで待たされない）。
 */
export function runOverpass(query, { signal } = {}) {
  const endpoints = rankedOverpassEndpoints();
  const body = 'data=' + encodeURIComponent(query);
  return new Promise((resolve, reject) => {
    const errors = [];
    const ctrls = [];
    const pending = new Map(); // url → 開始時刻
    let started = 0, failed = 0, settled = false, hedgeTimer = null;

    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      // 負けたサーバーは「少なくともこれだけ遅かった」として記録し、次回の順位を下げる
      if (fn === resolve) for (const [u, t] of pending) recordEndpoint(u, Date.now() - t + CONFIG.overpassHedgeMs, true);
      ctrls.forEach((c) => c.abort());
      fn(v);
    };
    const scheduleHedge = () => {
      clearTimeout(hedgeTimer);
      if (started < endpoints.length) hedgeTimer = setTimeout(() => { startNext(); }, CONFIG.overpassHedgeMs);
    };
    const startNext = () => {
      if (settled || started >= endpoints.length) return;
      const url = endpoints[started++];
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const t0 = Date.now();
      pending.set(url, t0);
      fetchJSON(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
        signal: ctrl.signal,
        timeoutMs: CONFIG.overpassTimeoutMs,
      })
        .then((json) => {
          if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error('Overpass: ' + json.remark);
          pending.delete(url);
          recordEndpoint(url, Date.now() - t0, true);
          finish(resolve, json.elements || []);
        })
        .catch((e) => {
          if (settled) return;
          pending.delete(url);
          recordEndpoint(url, null, false);
          errors.push(`${new URL(url).host}: ${e.message}`);
          failed++;
          if (started < endpoints.length) { startNext(); scheduleHedge(); } // 失敗したらすぐ次へ
          else if (failed === started) finish(reject, new Error('Overpass API の全サーバーで失敗しました\n- ' + errors.join('\n- ')));
        });
      scheduleHedge();
    };

    signal?.addEventListener('abort', () => finish(reject, new DOMException('中止しました', 'AbortError')), { once: true });
    startNext();
  });
}

/** OSM の addr:* タグから日本式の住所文字列を作る */
export function addressFromTags(t = {}) {
  if (t['addr:full']) return t['addr:full'];
  const area = [
    t['addr:province'] || t['addr:state'],
    t['addr:county'],
    t['addr:city'],
    t['addr:suburb'],
    t['addr:quarter'],
    t['addr:neighbourhood'],
    t['addr:street'],
  ].filter(Boolean);
  const nums = [t['addr:block_number'], t['addr:housenumber']].filter(Boolean).join('-');
  // 都道府県だけ、のような粗い住所は「住所なし」として扱う
  if (area.length < 2 && !nums) return null;
  return dedupeJoin(area) + nums;
}

function dedupeJoin(parts) {
  const out = [];
  for (const p of parts) if (out[out.length - 1] !== p) out.push(p);
  return out.join('');
}

// OSM の denomination タグ → 日本語の宗派名（Wikidata で取れないときの予備）
const DENOMINATION_JA = {
  jodo_shinshu: '浄土真宗', shin: '浄土真宗', jodo: '浄土宗', pure_land: '浄土宗',
  shingon: '真言宗', tendai: '天台宗', nichiren: '日蓮宗', soto: '曹洞宗',
  rinzai: '臨済宗', obaku: '黄檗宗', zen: '禅宗', ji: '時宗', kegon: '華厳宗',
  hosso: '法相宗', ritsu: '律宗', yuzu_nembutsu: '融通念仏宗', shugendo: '修験道',
  mahayana: '大乗仏教', jinja_honcho: '神社本庁',
};

/** Overpass の要素をアプリで扱いやすい形にそろえる */
export function normalizeElement(el, origin) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const place = {
    id: `${el.type}/${el.id}`,
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    name: t['name:ja'] || t.name,
    kana: t['name:ja-Hira'] || t['name:ja_kana'] || t['name:ja-Kana'] || null,
    religion: t.religion, // 'shinto' | 'buddhist'
    type: t.religion === 'shinto' ? '神社' : '寺院',
    lat,
    lon,
    address: addressFromTags(t),
    addressSource: null,
    postcode: t['addr:postcode'] || null,
    denomination: t.denomination
      ? DENOMINATION_JA[t.denomination] || t.denomination
      : null,
    wikidata: t.wikidata || null,
    wikipedia: t.wikipedia || null, // 例: "ja:清水寺"
    website: t.website || t['contact:website'] || null,
    distance: null,
    wiki: null, // enrichPlace() で埋まる
    tags: t,
  };
  if (place.address) place.addressSource = 'osm';
  if (origin && lat != null) place.distance = Math.round(distanceMeters(origin.lat, origin.lon, lat, lon));
  return place;
}

/**
 * 都道府県内の神社・寺院を取得
 * @param {string|number} prefecture '京都府' / '京都' / 26 / 'JP-26'
 * @param {{kind?: 'all'|'shinto'|'buddhist', limit?: number, signal?: AbortSignal}} opts
 */
export async function searchTemplesByPrefecture(prefecture, { kind = 'all', limit = 200, signal } = {}) {
  const pref = resolvePrefecture(prefecture);
  if (!pref) throw new Error(`都道府県が見つかりません: ${prefecture}`);
  const query = buildOverpassQuery({ prefectureCode: pref.code, kind, limit });
  const elements = await runOverpass(query, { signal });
  return elements
    .map((el) => normalizeElement(el))
    .filter((p) => p.name && p.lat != null)
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

/**
 * 緯度経度の周辺にある神社・寺院を取得（近い順）
 * @param {number} lat
 * @param {number} lon
 * @param {{radius?: number, kind?: 'all'|'shinto'|'buddhist', limit?: number, signal?: AbortSignal}} opts radius はメートル
 */
export async function searchTemplesNearby(lat, lon, { radius = 1000, kind = 'all', limit = 100, signal } = {}) {
  lat = Number(lat);
  lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('緯度・経度が正しくありません');
  radius = Math.min(Math.max(Number(radius) || 1000, 50), 20000);
  const query = buildOverpassQuery({ around: { lat, lon, radius }, kind, limit });
  const elements = await runOverpass(query, { signal });
  return elements
    .map((el) => normalizeElement(el, { lat, lon }))
    .filter((p) => p.name && p.lat != null)
    .sort((a, b) => a.distance - b.distance);
}

/**
 * 地図の表示範囲（南西〜北東）にある神社・寺院を取得（範囲の中心から近い順）
 * @param {{south:number, west:number, north:number, east:number}} bbox
 */
export async function searchTemplesInBounds(bbox, { kind = 'all', limit = 400, signal } = {}) {
  const center = { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };
  const query = buildOverpassQuery({ bbox, kind, limit });
  const elements = await runOverpass(query, { signal });
  return elements
    .map((el) => normalizeElement(el, center))
    .filter((p) => p.name && p.lat != null)
    .sort((a, b) => a.distance - b.distance);
}

// ─────────────────────────────────────────────
// 事前に作った全国データ（地域タイル）の形式
//   data/index.json        … { version, generatedAt, tileLat, tileLon, count, tiles: { "349_1086": 件数, ... } }
//   data/tiles/<key>.json   … { "p": [ 行, 行, ... ] }
//   行 = [id, 緯度, 経度, 名称, 種別(s=神社/b=寺院), 住所, よみ, 宗派, wikidata, wikipedia, website]
//        id は "n123"(node) / "w123"(way) / "r123"(relation)。末尾の空欄は省略
// ─────────────────────────────────────────────
export const TILE_LAT = 0.1;   // 約11km
export const TILE_LON = 0.125; // 約11km（北緯35度付近）

export function tileKeyOf(lat, lon) {
  return `${Math.floor(lat / TILE_LAT)}_${Math.floor(lon / TILE_LON)}`;
}

/** 範囲 {south, west, north, east} にかかるタイルのキー一覧 */
export function tileKeysInBounds(b) {
  const keys = [];
  const i0 = Math.floor(b.south / TILE_LAT), i1 = Math.floor(b.north / TILE_LAT);
  const j0 = Math.floor(b.west / TILE_LON), j1 = Math.floor(b.east / TILE_LON);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) keys.push(`${i}_${j}`);
  return keys;
}

/** タイルの周囲1マス分のキー（先読み用） */
export function neighborTileKeys(keys) {
  const set = new Set(keys);
  const out = new Set();
  for (const k of keys) {
    const [i, j] = k.split('_').map(Number);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const n = `${i + di}_${j + dj}`;
      if (!set.has(n)) out.add(n);
    }
  }
  return [...out];
}

export function rowFromPlace(p) {
  const [type, num] = p.id.split('/');
  const row = [
    type[0] + num, Number(p.lat.toFixed(5)), Number(p.lon.toFixed(5)), p.name,
    p.religion === 'shinto' ? 's' : 'b',
    p.address || '', p.kana || '', p.denomination || '', p.wikidata || '', p.wikipedia || '', p.website || '',
  ];
  while (row.length > 5 && row[row.length - 1] === '') row.pop();
  return row;
}

export function placeFromRow(r) {
  const [id, lat, lon, name, rel, address, kana, denom, wd, wp, web] = r;
  const type = { n: 'node', w: 'way', r: 'relation' }[id[0]];
  const osmId = `${type}/${id.slice(1)}`;
  const shinto = rel === 's';
  return {
    id: osmId, osmUrl: `https://www.openstreetmap.org/${osmId}`, name, kana: kana || null,
    religion: shinto ? 'shinto' : 'buddhist', type: shinto ? '神社' : '寺院', lat, lon,
    address: address || null, addressSource: address ? 'osm' : null, postcode: null,
    denomination: denom || null, wikidata: wd || null, wikipedia: wp || null, website: web || null,
    distance: null, wiki: null,
  };
}

// ─────────────────────────────────────────────
// 住所の補完（Nominatim 逆ジオコーディング・1秒1件）
// ─────────────────────────────────────────────
const nominatimCache = new Map();
let nominatimQueue = Promise.resolve();
/** Nominatim の利用規約（1秒1件）を守るための順番待ち。結果はすぐ返し、次のリクエストとの間だけ空ける */
function nominatimRun(fn) {
  const job = nominatimQueue.then(fn);
  nominatimQueue = job.catch(() => {}).then(() => sleep(CONFIG.nominatimIntervalMs));
  return job;
}

export function addressFromNominatim(a = {}) {
  const area = [
    a.province || a.state,
    a.county,
    a.city || a.town || a.village,
    a.city_district,
    a.suburb,
    a.quarter,
    a.neighbourhood,
    a.hamlet,
  ].filter(Boolean);
  if (!area.length) return null;
  return dedupeJoin(area) + (a.house_number || '');
}

/** 緯度経度 → 住所（キャッシュ・間隔制御つき） */
export function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (nominatimCache.has(key)) return nominatimCache.get(key);
  const job = nominatimRun(async () => {
    const url =
      CONFIG.nominatimEndpoint +
      '?' +
      qs({ format: 'jsonv2', lat, lon, zoom: 18, addressdetails: 1, 'accept-language': 'ja' });
    const json = await fetchJSON(url);
    return addressFromNominatim(json.address);
  });
  nominatimCache.set(key, job);
  job.catch(() => nominatimCache.delete(key)); // 失敗したら次回また試す
  return job;
}

/**
 * 地名・寺社名で全国を検索（Nominatim）。地図をその場所へ動かすために使う
 * @returns {Promise<Array<{id:string|null, name:string, label:string, lat:number, lon:number, isWorship:boolean, kind:string}>>}
 */
export function searchPlaceName(text, { limit = 8 } = {}) {
  return nominatimRun(async () => {
    const url = CONFIG.nominatimSearchEndpoint + '?' +
      qs({ format: 'jsonv2', q: text, countrycodes: 'jp', 'accept-language': 'ja', limit, addressdetails: 1 });
    const list = await fetchJSON(url);
    return list.map((r) => {
      const isWorship = r.category === 'amenity' && r.type === 'place_of_worship';
      const name = r.name || String(r.display_name).split(',')[0];
      return {
        id: r.osm_type && r.osm_id ? `${r.osm_type}/${r.osm_id}` : null,
        name,
        label: addressFromNominatim(r.address) || r.display_name,
        lat: Number(r.lat),
        lon: Number(r.lon),
        isWorship,
        kind: isWorship ? '寺社' : r.addresstype === 'railway' || r.type === 'station' ? '駅' : '地名など',
      };
    });
  });
}

/**
 * address が空の施設だけ Nominatim で住所を補完する（元の配列を書き換えて返す）
 * 1秒1件なので max 件までに制限している
 */
export async function fillMissingAddresses(places, { max = 30, onProgress } = {}) {
  const targets = places.filter((p) => !p.address).slice(0, max);
  let done = 0;
  for (const p of targets) {
    try {
      const addr = await reverseGeocode(p.lat, p.lon);
      if (addr) {
        p.address = addr;
        p.addressSource = 'nominatim';
      }
    } catch (e) {
      p.addressError = e.message;
    }
    onProgress?.(++done, targets.length, p);
  }
  return places;
}

// ─────────────────────────────────────────────
// 仕様2: Wikipedia / Wikidata で概要文・宗派を補完
// ─────────────────────────────────────────────
const MATCH_RADIUS_M = 3000; // 名前が合っていても、この距離より離れていれば別の寺社とみなす
const wikidataLabelCache = new Map();

async function wikipediaQuery(params) {
  return fetchJSON(CONFIG.wikipediaApi + '?' + qs({ action: 'query', format: 'json', formatversion: 2, origin: '*', ...params }));
}

async function wikidataQuery(params) {
  return fetchJSON(CONFIG.wikidataApi + '?' + qs({ format: 'json', origin: '*', ...params }));
}

/** 名称が一致しているか（完全一致 / 片方がもう片方を含む） */
export function nameMatchLevel(placeName, pageTitle) {
  const a = normalizeName(placeName);
  const b = normalizeName(pageTitle);
  if (!a || !b) return 0;
  if (a === b) return 2;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return 1;
  return 0;
}

/** ① 座標の近くにある Wikipedia 記事から名前の合うものを探す（同名寺社の取り違えが起きにくい） */
async function findByGeosearch(place) {
  const json = await wikipediaQuery({
    list: 'geosearch',
    gscoord: `${place.lat}|${place.lon}`,
    gsradius: 1000,
    gslimit: 50,
  });
  const hits = (json.query?.geosearch || [])
    .map((g) => ({ title: g.title, dist: g.dist, level: nameMatchLevel(place.name, g.title) }))
    .filter((g) => g.level > 0)
    .sort((x, y) => y.level - x.level || x.dist - y.dist);
  return hits[0] ? { title: hits[0].title, matchedBy: 'geosearch', confidence: 'high', dist: Math.round(hits[0].dist) } : null;
}

/** ② 名前で全文検索し、記事の座標が近いものを採用する */
async function findByTextSearch(place) {
  const json = await wikipediaQuery({
    generator: 'search',
    gsrsearch: place.name,
    gsrlimit: 10,
    gsrnamespace: 0,
    prop: 'coordinates',
    colimit: 'max',
  });
  const pages = json.query?.pages || [];
  let best = null;
  for (const pg of pages) {
    const level = nameMatchLevel(place.name, pg.title);
    if (!level) continue;
    const c = pg.coordinates?.[0];
    if (c) {
      const dist = distanceMeters(place.lat, place.lon, c.lat, c.lon);
      if (dist > MATCH_RADIUS_M) continue; // 同名の別の寺社
      const cand = { title: pg.title, matchedBy: 'search+coords', confidence: level === 2 ? 'high' : 'medium', dist: Math.round(dist), score: level * 10 - dist / 1000 };
      if (!best || cand.score > best.score) best = cand;
    } else if (level === 2 && !best) {
      // 記事に座標が無い場合は名前の完全一致のみ・信頼度 low
      best = { title: pg.title, matchedBy: 'search(name only)', confidence: 'low', dist: null, score: 0 };
    }
  }
  if (best) delete best.score;
  return best;
}

/** Wikipedia 記事の概要文と Wikidata ID を取得 */
async function fetchWikipediaPage(title) {
  const json = await wikipediaQuery({
    titles: title,
    redirects: 1,
    prop: 'extracts|pageprops|info',
    exintro: 1,
    explaintext: 1,
    ppprop: 'wikibase_item|disambiguation',
    inprop: 'url',
  });
  const pg = json.query?.pages?.[0];
  if (!pg || pg.missing) return null;
  if (pg.pageprops && 'disambiguation' in pg.pageprops) return null; // 曖昧さ回避ページは使わない
  return {
    title: pg.title,
    url: pg.fullurl || `https://ja.wikipedia.org/wiki/${encodeURIComponent(pg.title)}`,
    summary: (pg.extract || '').trim() || null,
    qid: pg.pageprops?.wikibase_item || null,
  };
}

/** Wikidata の項目から日本語版 Wikipedia のタイトルと宗派(P140)を取得 */
async function fetchWikidataInfo(qid) {
  const json = await wikidataQuery({
    action: 'wbgetentities',
    ids: qid,
    props: 'claims|sitelinks',
    sitefilter: 'jawiki',
  });
  const ent = json.entities?.[qid];
  if (!ent || ent.missing !== undefined) return null;
  const sectIds = (ent.claims?.P140 || [])
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
  return {
    jawikiTitle: ent.sitelinks?.jawiki?.title || null,
    sect: await getWikidataLabels(sectIds),
  };
}

/** Wikidata の Q番号 → 日本語ラベル（無ければ英語） */
async function getWikidataLabels(ids) {
  const need = ids.filter((id) => !wikidataLabelCache.has(id));
  if (need.length) {
    const json = await wikidataQuery({ action: 'wbgetentities', ids: need.slice(0, 50).join('|'), props: 'labels', languages: 'ja|en' });
    for (const id of need) {
      const l = json.entities?.[id]?.labels;
      wikidataLabelCache.set(id, l?.ja?.value || l?.en?.value || id);
    }
  }
  return ids.map((id) => wikidataLabelCache.get(id));
}

/**
 * 1件の寺社に Wikipedia / Wikidata の情報を補完する
 * 結果は place.wiki に入る:
 *   { title, url, summary, qid, sect: string[], matchedBy, confidence, dist } または { notFound: true }
 */
export async function enrichPlace(place) {
  let title = null;
  let qid = place.wikidata;
  let match = null;

  // 1) OSM に wikipedia / wikidata タグがあればそれを最優先（確実）
  if (place.wikipedia) {
    const m = place.wikipedia.match(/^ja:(.+)$/);
    if (m) {
      title = m[1];
      match = { matchedBy: 'osm:wikipedia', confidence: 'high' };
    }
  }
  let wd = null;
  if (!title && qid) {
    wd = await fetchWikidataInfo(qid);
    if (wd?.jawikiTitle) {
      title = wd.jawikiTitle;
      match = { matchedBy: 'osm:wikidata', confidence: 'high' };
    }
  }

  // 2) タグが無ければ、座標検索 → 名前検索 の順で探す
  if (!title && !qid) {
    match = (await findByGeosearch(place)) || (await findByTextSearch(place));
    title = match?.title || null;
  }

  let page = null;
  if (title) {
    page = await fetchWikipediaPage(title);
    if (page?.qid && !qid) qid = page.qid;
  }
  if (qid && !wd) wd = await fetchWikidataInfo(qid);

  if (!page && !wd) {
    place.wiki = { notFound: true };
    return place;
  }

  let sect = wd?.sect || [];
  // 神社の P140 は「神道」だけのことが多い。OSM の宗派タグがあれば補う
  if (place.denomination && !sect.includes(place.denomination)) sect = [...sect, place.denomination];

  place.wiki = {
    title: page?.title || null,
    url: page?.url || null,
    summary: page?.summary || null,
    qid: qid || null,
    wikidataUrl: qid ? `https://www.wikidata.org/wiki/${qid}` : null,
    sect,
    matchedBy: match?.matchedBy || 'osm:wikidata',
    confidence: match?.confidence || 'high',
    dist: match?.dist ?? null,
  };
  return place;
}

/** 複数件をまとめて補完（同時3件まで） */
export async function enrichPlaces(places, { concurrency = 3, onProgress } = {}) {
  let done = 0;
  await mapLimit(places, concurrency, async (p) => {
    try {
      await enrichPlace(p);
    } catch (e) {
      p.wiki = { error: e.message };
    }
    onProgress?.(++done, places.length, p);
  });
  return places;
}
