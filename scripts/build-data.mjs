#!/usr/bin/env node
/**
 * 全国の神社・寺院データを OpenStreetMap（Overpass API）から取得し、
 * 地図アプリがすばやく読み込めるよう地域タイル（data/tiles/*.json）に分けて保存する。
 *
 *   node scripts/build-data.mjs
 *
 * GitHub Actions（.github/workflows/update-data.yml）から週1回自動で実行される。
 * 環境変数:
 *   PREF_CODES=JP-26,JP-13  … 一部の都道府県だけ取得（テスト用）
 *   OUT_DIR=data            … 出力先
 */
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG, PREFECTURES, normalizeElement, rowFromPlace, tileKeyOf, TILE_LAT, TILE_LON,
} from '../temple-api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || 'data');
const TILE_DIR = path.join(OUT_DIR, 'tiles');
const PREFS = process.env.PREF_CODES
  ? PREFECTURES.filter((p) => process.env.PREF_CODES.split(',').includes(p.code))
  : PREFECTURES;
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 3000);    // 都道府県ごとの間隔（公開サーバーへの配慮）
const RETRIES = Number(process.env.RETRIES ?? 4);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);  // 同時に取得する都道府県の数（公開サーバーの1IPあたりの上限に合わせて2）
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 5 * 60 * 1000);
const UA = 'temples-shrines_search data builder (https://github.com/Paji94/temples-shrines_search)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function prefectureQuery(code) {
  return [
    '[out:json][timeout:280][maxsize:536870912];',
    `area["ISO3166-2"="${code}"]["admin_level"="4"]->.pref;`,
    'nwr["amenity"="place_of_worship"]["religion"~"^(shinto|buddhist)$"]["name"](area.pref);',
    'out center tags qt;',
  ].join('\n');
}

/** 1つの都道府県を取得（サーバーを順に試し、混雑時は待って再試行） */
async function fetchPrefecture(pref) {
  const body = 'data=' + encodeURIComponent(prefectureQuery(pref.code));
  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    for (const url of CONFIG.overpassEndpoints) {
      const host = new URL(url).host;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': UA, Accept: 'application/json' },
          body,
          signal: ctrl.signal,
        }).finally(() => clearTimeout(timer));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark);
        if (!Array.isArray(json.elements)) throw new Error('elements がありません');
        // 混雑したサーバーは空の結果を返すことがある。寺社が0件の都道府県はないので失敗として扱う
        if (json.elements.length === 0) throw new Error('0件（サーバーの不調とみなして再取得）');
        return json.elements;
      } catch (e) {
        lastErr = new Error(`${host}: ${e.message}`);
        log(`  ${pref.name}: ${lastErr.message}`);
      }
    }
    const wait = 30000 * (attempt + 1);
    log(`  ${pref.name}: ${wait / 1000}秒待って再試行（${attempt + 1}/${RETRIES}）`);
    await sleep(wait);
  }
  throw lastErr;
}

async function readJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function main() {
  log(`取得開始: ${PREFS.length}都道府県 → ${path.relative(ROOT, OUT_DIR)}/`);
  const places = new Map();
  const perPref = {};
  let next = 0, done = 0;
  async function worker() {
    while (next < PREFS.length) {
      const pref = PREFS[next++];
      const t0 = Date.now();
      const elements = await fetchPrefecture(pref);
      let n = 0;
      for (const el of elements) {
        const p = normalizeElement(el);
        if (!p.name || p.lat == null || !/^(shinto|buddhist)$/.test(p.religion)) continue;
        if (!places.has(p.id)) places.set(p.id, p);
        n++;
      }
      perPref[pref.name] = n;
      log(`${String(++done).padStart(2)}/${PREFS.length} ${pref.name}: ${n}件（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
      if (n === 0) throw new Error(`${pref.name} の寺社が0件でした`);
      if (next < PREFS.length) await sleep(PAUSE_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, PREFS.length) }, worker));

  // 前回より極端に少ない場合は、取得の失敗とみなして上書きしない
  const prevIndex = await readJSON(path.join(OUT_DIR, 'index.json'));
  if (!process.env.PREF_CODES && prevIndex?.count && places.size < prevIndex.count * 0.8) {
    throw new Error(`件数が前回（${prevIndex.count}）より大きく減っています（${places.size}）。保存を中止しました`);
  }

  // タイルに振り分け
  const tiles = new Map();
  for (const p of places.values()) {
    const key = tileKeyOf(p.lat, p.lon);
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(rowFromPlace(p));
  }

  await mkdir(TILE_DIR, { recursive: true });
  const hash = createHash('sha1');
  const counts = {};
  let written = 0;
  for (const key of [...tiles.keys()].sort()) {
    const rows = tiles.get(key).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const text = JSON.stringify({ p: rows });
    hash.update(key).update(text);
    counts[key] = rows.length;
    const file = path.join(TILE_DIR, `${key}.json`);
    const old = await readFile(file, 'utf8').catch(() => null);
    if (old !== text) { await writeFile(file, text); written++; }
  }
  // 使われなくなったタイルを削除
  let removed = 0;
  for (const f of await readdir(TILE_DIR)) {
    if (f.endsWith('.json') && !tiles.has(f.slice(0, -5))) { await unlink(path.join(TILE_DIR, f)); removed++; }
  }

  const version = hash.digest('hex').slice(0, 12);
  if (prevIndex?.version === version) {
    log(`データに変更はありません（${places.size}件・${tiles.size}タイル）`);
    return;
  }
  const index = {
    version,
    generatedAt: new Date().toISOString(),
    source: 'OpenStreetMap contributors (ODbL) via Overpass API',
    tileLat: TILE_LAT,
    tileLon: TILE_LON,
    count: places.size,
    tiles: counts,
  };
  await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(index));
  log(`保存しました: ${places.size}件・${tiles.size}タイル（更新 ${written}・削除 ${removed}）version=${version}`);
}

main().catch((e) => {
  console.error('失敗:', e.message);
  process.exit(1);
});
