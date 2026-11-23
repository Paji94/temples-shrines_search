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

## 使っているデータ・API

- 寺社の位置・名称・住所: OpenStreetMap（Overpass API）
- 住所の補完: Nominatim（1秒1件まで）
- 概要文: Wikipedia（日本語版）
- 宗派: Wikidata
- 地図: 国土地理院 淡色地図 / OpenStreetMap、表示は Leaflet

## 御朱印の記録について

記録（写真を含む）は、使っているブラウザの中（IndexedDB）にだけ保存されます。
サーバーや GitHub には送信されません。端末やブラウザごとに別々なので、
アプリ内の「御朱印帳 → バックアップを保存」で定期的にバックアップしてください。
iPhone / iPad では「ホーム画面に追加」して使うと、データが消えにくくなります。
