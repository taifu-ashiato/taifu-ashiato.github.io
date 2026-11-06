# 台風の足あと 3D

気象庁の台風の記録と、NASA の衛星が撮った地球の写真を使って、台風が通った道を 3D の地球の上でたどるページです。

- 令和元年東日本台風（2019年）、伊勢湾台風（1959年）
- 2026年に日本へ接近・上陸した13個（第14号から後は気象庁の速報値）

## データと出典

- 台風の記録：気象庁「RSMC Best Track Data」「台風位置表」「台風の統計資料」を加工して作成（出典：気象庁ホームページ、公共データ利用規約 第1.0版）
- 衛星画像：NASA GIBS（Blue Marble、VIIRS〈Suomi NPP・NOAA-21〉、MODIS〈Terra〉）をページを開いたときに読み込みます。
  We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).
- 都道府県の境界：Natural Earth（パブリックドメイン。奄美群島を鹿児島県に直して使用）
- 3D の地球：CesiumJS（Apache License 2.0）
- 雲の絵（衛星写真風・浮世絵風）は生成AIで描いたイメージです。
- 都道府県を通った時刻や距離は、記録をなめらかにつないだ経路から求めた目安です。

AI（Claude）と協業して作りました。
