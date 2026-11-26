# 寺社めぐり 御朱印マップ

全国の神社・寺院を地図で探し、御朱印の記録を残せる Web アプリです。
APIキー不要・無料の API だけで動きます。

公開URL: https://paji94.github.io/temples-shrines_search/

## ファイル

| ファイル | 内容 |
| --- | --- |
| `index.html` | 御朱印マップ本体（トップページ）。1ファイルで動作 |
| `temple-test.html` | データ取得のテスト画面 |
| `temple-api.js` | データ取得処理のソース（`index.html` と `temple-test.html` に埋め込み済み） |
| `data/` | 全国の寺社データ（地域タイル）。GitHub Actions が自動で作成・更新 |
| `scripts/build-data.mjs` | `data/` を作るスクリプト |
| `.github/workflows/update-data.yml` | 毎週月曜 3:17（日本時間）に `data/` を自動更新 |

## 使っているデータ・API

- 寺社の位置・名称・住所: OpenStreetMap（Overpass API）
  - 事前に全国分を取得して `data/` に保存し、アプリはそれを読み込む（高速）
  - `data/` が無い・読めないときは、その場で Overpass API に問い合わせる
  - 「このエリアを検索」を2回続けて押すと、Overpass API から最新情報を取り直す
- 住所の補完: Nominatim（1秒1件まで）
- 概要文: Wikipedia（日本語版）
- 宗派: Wikidata
- 地図: OpenStreetMap（初期表示）/ 国土地理院 淡色地図、表示は Leaflet

## 全国データ（data/）の更新

- 自動: 毎週月曜に GitHub Actions が実行され、変更があればコミットされます
- 手動: GitHub の「Actions」→「寺社データを更新」→「Run workflow」
- 手元で作る場合: `node scripts/build-data.mjs`（Node.js 20 以上、30分程度かかります）

データは © OpenStreetMap contributors（ODbL ライセンス）です。

## 御朱印の記録について

記録（写真を含む）は、使っているブラウザの中（IndexedDB）にだけ保存されます。
サーバーや GitHub には送信されません。端末やブラウザごとに別々なので、
アプリ内の「御朱印帳 → バックアップを保存」で定期的にバックアップしてください。
iPhone / iPad では「ホーム画面に追加」して使うと、データが消えにくくなります。
