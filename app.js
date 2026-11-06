// 台風の足あと 3D：CesiumJS ＋ NASA GIBS の衛星画像。データは data/<国際番号>.json（export_web.py で作る）
(() => {
  const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/';
  const C = Cesium;
  const SHU = C.Color.fromCssColorString('#c23b22');
  const AI = C.Color.fromCssColorString('#1d3461');
  const YEL = C.Color.fromCssColorString('#f5cd00');
  const RED = C.Color.fromCssColorString('#e2281e');
  const STAGE = { 2: '熱帯低気圧', 3: '台風', 4: '台風', 5: '台風', 9: '台風', 6: '温帯低気圧', 7: '台風' };
  const $ = id => document.getElementById(id);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rad = C.Math.toRadians;

  const viewer = new C.Viewer('globe', {
    baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false, infoBox: false,
    selectionIndicator: false, shouldAnimate: false,
  });
  viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
    url: GIBS + 'BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
    maximumLevel: 8, credit: new C.Credit('NASA GIBS: Blue Marble'),
  }));
  viewer.scene.globe.baseColor = C.Color.fromCssColorString('#0b1a33');
  if (/[?&]debug\b/.test(location.search)) window.__viewer = viewer;   // 確かめるとき用（?debug を付けて開く）

  // ---------- 台風の状態 ----------
  let D = null, T0 = null, HMAX = 0, KNOTS = new Set();
  const atH = hf => {
    const P = D.pts;
    const i = Math.max(0, Math.min(P.length - 2, Math.floor(hf - P[0][0])));
    const a = P[i], b = P[i + 1], t = Math.max(0, Math.min(1, hf - a[0]));
    const v = k => lerp(a[k], b[k], t);
    // 風の範囲：片方に記録がなければ前の記録のまま（0 へ向けてつなぐと、記録にない縮む円になる）
    const c = r => (a[r] > 0 && b[r] > 0 ? [v(r), v(r + 1), v(r + 2)] : [a[r], a[r + 1], a[r + 2]]);
    const [r30, e30, n30] = c(6), [r50, e50, n50] = c(9);
    return { lat: v(1), lon: v(2), p: v(3), w: a[4] > 0 && b[4] > 0 ? v(4) : a[4], g: a[5], r30, e30, n30, r50, e50, n50 };
  };
  const shift = (lat, lon, e, n) => [lat + n / 111, lon + e / (111 * Math.cos(rad(lat)))];
  const dest = (lat, lon, brg, km) => {
    const R = 6371, p1 = rad(lat), l1 = rad(lon), b = rad(brg), d = km / R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [C.Math.toDegrees(p2), C.Math.toDegrees(l2)];
  };
  const bearing = (a, b) => {
    const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lon - a.lon);
    return (C.Math.toDegrees(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))) + 360) % 360;
  };
  const circle = (lat, lon, km, height, n = 72) => {
    const out = [];
    for (let k = 0; k <= n; k++) { const [la, lo] = dest(lat, lon, k * 360 / n, km); out.push(lo, la, height); }
    return C.Cartesian3.fromDegreesArrayHeights(out);
  };
  const hNow = () => (D ? C.JulianDate.secondsDifference(viewer.clock.currentTime, T0) / 3600 : 0);
  const jst = hf => { const d = new Date(Date.parse(D.t0) + (hf + 9) * 3600e3); return { M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes() }; };
  const era = y => y >= 2019 ? '令和' + (y === 2019 ? '元' : y - 2018) + '年' : y >= 1989 ? '平成' + (y === 1989 ? '元' : y - 1988) + '年' : '昭和' + (y - 1925) + '年';

  // ---------- 雲 ----------
  let cloud = 'sat';             // はじめは衛星写真風。1つの台風の画面で選び直したら、台風を替えてもその見せ方のまま
  let chosenCloud = null;
  const IMG = { sat: 'art/cloud_sat.png', ukiyo: 'art/cloud_ukiyo.png' };
  const cl = { rect: C.Rectangle.fromDegrees(0, 0, 1, 1), alpha: 0, rot: 0, show: false };
  // 雲の絵は canvas の上で回してから貼る。Cesium の stRotation で回すと、絵が縮んで四角の角に絵の繰り返しが出る。
  // 絵は丸く、四隅が透明なので、同じ大きさの canvas の中で回しても切れない。
  const cloudSrc = {};
  for (const k in IMG) { cloudSrc[k] = new Image(); cloudSrc[k].src = IMG[k]; }
  const rotCv = [0, 1].map(() => Object.assign(document.createElement('canvas'), { width: 768, height: 768 }));
  let rotFlip = 0, rotImg = rotCv[0], rotKind = '', rotDone = NaN, rotAt = 0;
  function cloudImage() {
    const kind = cloud === 'ukiyo' ? 'ukiyo' : 'sat', im = cloudSrc[kind];
    if (!im.complete || !im.naturalWidth) return rotImg;
    const now = performance.now();
    // 1度以上回ったら描き直す（多くても毎秒25回）。同じ canvas を返すと Cesium が描き直さないので2枚を交互に使う
    if (kind === rotKind && (Math.abs(cl.rot - rotDone) < rad(1) || now - rotAt < 40)) return rotImg;
    rotKind = kind; rotDone = cl.rot; rotAt = now;
    rotFlip ^= 1; rotImg = rotCv[rotFlip];
    const g = rotImg.getContext('2d'), S = rotImg.width;
    g.clearRect(0, 0, S, S);
    g.save();
    g.translate(S / 2, S / 2);
    g.rotate(-cl.rot);            // canvas は下向きが正なので、マイナスで反時計回り（北が上の地図で見て）
    g.drawImage(im, -S / 2, -S / 2, S, S);
    g.restore();
    return rotImg;
  }
  function updCloud(hf) {
    const s = atH(hf);
    const inten = Math.max(0, Math.min(1, (1010 - s.p) / 115));
    let Dkm = Math.max(250 + 750 * inten, 2.1 * s.r30), a = 0.28 + 0.52 * inten;
    if (D.land && hf > D.land[0]) a *= Math.max(0.35, 1 - (hf - D.land[0]) / 14);
    if (s.g === 6) { a *= 0.55; Dkm *= 1.15; } else if (s.g === 2) a *= 0.85;
    const [clat, clon] = shift(s.lat, s.lon, s.e30 * 0.5, s.n30 * 0.5);
    const hl = Dkm / 2 / 111, hw = Dkm / 2 / (111 * Math.cos(rad(clat)));
    cl.rect = C.Rectangle.fromDegrees(clon - hw, clat - hl, clon + hw, clat + hl);
    cl.alpha = a;
    cl.rot = rad((hf * 20) % 360);           // 反時計回り
    cl.show = cloud === 'sat' || cloud === 'ukiyo';
  }

  // ---------- NASA の実写真（その日の1枚） ----------
  let nasaLayer = null, nasaDate = null;
  // 日付ごとに写真のある衛星：2025年からは NOAA-21（Suomi NPP は2026年10月の写真がなかった）、その前は Suomi NPP、2000年からは Terra
  const SATS = [['2025-01-01', 'VIIRS_NOAA21_CorrectedReflectance_TrueColor', 'NOAA-21'],
    ['2015-11-24', 'VIIRS_SNPP_CorrectedReflectance_TrueColor', 'Suomi NPP'],
    ['2000-02-24', 'MODIS_Terra_CorrectedReflectance_TrueColor', 'Terra']];
  const product = d => SATS.find(s => d >= s[0]) || null;
  let noteText = null;
  const setNote = t => { if (t !== noteText) { noteText = t; $('cN').textContent = t; } };
  function updNasa() {
    const want = cloud === 'nasa' && (season || (D && D.year >= 2000));
    if (!want) {
      if (nasaLayer) { viewer.imageryLayers.remove(nasaLayer); nasaLayer = null; nasaDate = null; }
      setNote('');
      return;
    }
    // 日本付近の撮影はおよそ世界時4時半ごろ（日本時間の昼過ぎ）なので、その時刻で日付を切り替える
    const d = C.JulianDate.toIso8601(C.JulianDate.addHours(viewer.clock.currentTime, -4.5, new C.JulianDate())).slice(0, 10);
    if (nasaDate) {
      const [, m, dd] = nasaDate.split('-').map(Number);
      setNote(`雲の写真：${m}月${dd}日の昼ごろ（NASA の衛星 ${product(nasaDate)[2]}）`);
    }
    if (d === nasaDate) return;
    if (season && viewer.clock.shouldAnimate) return;     // まとめて見る画面では、早送りのあいだは写真を替えない（止めたら替える）
    const sat = product(d);
    if (!sat) return;
    const prod = sat[1];
    const layer = viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
      url: GIBS + prod + '/default/' + d + '/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpeg',
      maximumLevel: 9, credit: new C.Credit('NASA GIBS: ' + prod.split('_')[0] + ' ' + d),
    }));
    layer.alpha = 0;
    const old = nasaLayer;
    nasaLayer = layer; nasaDate = d;
    const t0 = performance.now();
    const fade = () => {
      const f = Math.min(1, (performance.now() - t0) / 700);
      layer.alpha = f;
      if (old) old.alpha = 1 - f;
      if (f < 1) requestAnimationFrame(fade); else if (old) viewer.imageryLayers.remove(old);
    };
    requestAnimationFrame(fade);
  }

  // ---------- 図形 ----------
  let parts = [];
  function clearParts() { parts.forEach(e => viewer.entities.remove(e)); parts = []; }
  const add = o => { const e = viewer.entities.add(o); parts.push(e); return e; };

  function build() {
    clearParts();
    const P = D.pts;
    const pos = p => C.Cartesian3.fromDegrees(p[2], p[1], 1500);
    add({ polyline: { positions: P.map(pos), width: 2, material: C.Color.WHITE.withAlpha(0.45) } });
    add({ polyline: { width: 5, material: SHU, positions: new C.CallbackProperty(() => {
      const hf = hNow(), out = [];
      for (const p of P) { if (p[0] > hf) break; out.push(pos(p)); }
      const s = atH(hf); out.push(C.Cartesian3.fromDegrees(s.lon, s.lat, 1500));
      return out.length > 1 ? out : [];
    }, false) } });
    // 雲（イメージ）
    add({ rectangle: {
      coordinates: new C.CallbackProperty(() => cl.rect, false), height: 6000,
      show: new C.CallbackProperty(() => cl.show, false),
      material: new C.ImageMaterialProperty({
        image: new C.CallbackProperty(cloudImage, false), transparent: true,
        color: new C.CallbackProperty(() => C.Color.WHITE.withAlpha(cl.alpha), false),
      }),
    } });
    // 強風域・暴風域（記録された半径）
    for (const [key, col, w] of [['r30', YEL, 3], ['r50', RED, 4]]) {
      add({ polyline: { width: w, material: col, positions: new C.CallbackProperty(() => {
        const s = atH(hNow()), R = s[key];
        if (R < 5) return [];
        const [la, lo] = shift(s.lat, s.lon, key === 'r30' ? s.e30 : s.e50, key === 'r30' ? s.n30 : s.n50);
        return circle(la, lo, R, 9000);
      }, false) } });
    }
    // 風の矢印：反時計回りに巻きながら吹き込む（向きは北半球の台風のとおり、速さはイメージ）
    // 不透明の線（藍に白縁）で、軸と「く」の字の矢じりを描く。半透明の矢印（PolylineArrow）は雲の絵に塗りつぶされて見えなくなる。
    const arrowMat = new C.PolylineOutlineMaterialProperty({ color: AI, outlineColor: C.Color.WHITE, outlineWidth: 2 });
    const arrow = (k, n, off, fr) => {
      const hf = hNow(), s = atH(hf);
      const R = s.r50 > 30 ? s.r50 : 0.3 * s.r30;
      if (R < 20) return null;
      const th = ((k * 360 / n + off - 60 * hf) % 360 + 360) % 360;
      const [la, lo] = dest(s.lat, s.lon, th, fr * R);        // 根もと
      const hd = (th - 110 + 360) % 360;                       // 向き：円に沿って反時計回り＋内向き20°
      const L = Math.max(25, 0.16 * R);
      const [la2, lo2] = dest(la, lo, hd, L);                  // 先
      const [la3, lo3] = dest(la2, lo2, (hd + 148) % 360, 0.45 * L);
      const [la4, lo4] = dest(la2, lo2, (hd + 212) % 360, 0.45 * L);
      return { shaft: [lo, la, 9400, lo2, la2, 9400], head: [lo3, la3, 9500, lo2, la2, 9500, lo4, la4, 9500] };
    };
    const rings = [[0.45, 6, 0], [0.8, 9, 20], [1.1, 12, 7]];
    for (const [fr, n, off] of rings) {
      for (let k = 0; k < n; k++) {
        for (const part of ['shaft', 'head']) {
          add({ polyline: { width: 7, material: arrowMat, positions: new C.CallbackProperty(() => {
            const a = arrow(k, n, off, fr);
            return a ? C.Cartesian3.fromDegreesArrayHeights(a[part]) : [];
          }, false) } });
        }
      }
    }
    // 台風の目
    const sp = new C.SampledPositionProperty();
    for (const p of P) sp.addSample(C.JulianDate.addHours(T0, p[0], new C.JulianDate()), C.Cartesian3.fromDegrees(p[2], p[1], 0));
    // viewFrom：追いかけるときのカメラの位置（台風の南 900km・上空 1300km。指定しないと海面すれすれまで寄ってしまう）
    const eye = add({ position: sp, viewFrom: new C.Cartesian3(0, -900e3, 1300e3), point: { pixelSize: 11, color: SHU, outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    eyeEntity = eye;
    const after = h => new C.TimeIntervalCollection([new C.TimeInterval({ start: C.JulianDate.addHours(T0, h, new C.JulianDate()), stop: C.JulianDate.addHours(T0, HMAX + 1, new C.JulianDate()) })]);
    const label = (h, lat, lon, text) => add({ availability: after(h), position: C.Cartesian3.fromDegrees(lon, lat, 0),
      point: { pixelSize: 8, color: SHU, outlineColor: C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text, font: '600 15px "Zen Kaku Gothic New", sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(12, -10), horizontalOrigin: C.HorizontalOrigin.LEFT, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    const pk = atH(D.peak), jp = jst(D.peak);
    label(D.peak, pk.lat, pk.lon, `最も強い ${Math.round(pk.p)}hPa（${jp.M}月${jp.D}日）`);
    if (D.land) {
      const [lh, la, lo] = D.land, jl = jst(Math.round(lh));          // 「〜時ごろ」は四捨五入
      const first = (D.passes || []).find(x => !x.isle && Math.abs(x.h_in - lh) < 1);
      label(lh, la, lo, `${first ? first.name + 'に' : ''}上陸（${jl.M}月${jl.D}日${jl.h}時ごろ）`);
      // 上陸の波紋
      for (let j = 0; j < 3; j++) {
        add({ polyline: { width: 5, material: SHU, positions: new C.CallbackProperty(() => {   // 不透明（半透明だと雲に隠れる）
          const f = (hNow() - lh - j * 0.25) / 0.75;
          return f >= 0 && f <= 1 ? circle(la, lo, 15 + 200 * f, 9500) : [];
        }, false) } });
      }
      // 暴風域・強風域が通った範囲（1時間ごとの円を6時間遅れで、1枚の絵に描いて重ねる。円が重なっても濃くならない）
      const sw = makeSwath(lh, D.et ?? Math.min(HMAX, lh + 24));
      if (sw) add({ rectangle: { coordinates: sw.rect, height: 0,
        show: new C.CallbackProperty(() => hNow() >= sw.first, false),
        material: new C.ImageMaterialProperty({ image: new C.CallbackProperty(() => sw.image(hNow()), false), transparent: true }) } });
      if (D.focus) label(lh + 2, D.focus.lat, D.focus.lon, D.focus.name);
    }
    if (D.et != null) { const e = atH(D.et), je = jst(D.et); label(D.et, e.lat, e.lon, `温帯低気圧に（${je.M}月${je.D}日）`); }
    buildPrefs();
  }

  // ---------- 通過した都道府県 ----------
  // 中心が陸の上を通った都道府県（export_web.py が経路と Natural Earth の境界から求めた）。
  // いま中心がある所は白く明るく、通り過ぎた所は縁どりと名前だけ残す。
  const IVORY = C.Color.fromCssColorString('#fffaf0'), SUMI = C.Color.fromCssColorString('#221e1b');
  function buildPrefs() {
    const byCode = new Map();
    for (const ps of D.passes || []) {
      if (!byCode.has(ps.code)) byCode.set(ps.code, { ps, spans: [] });
      byCode.get(ps.code).spans.push([ps.h_in, ps.h_out]);
    }
    for (const { ps, spans } of byCode.values()) {
      const state = () => { const h = hNow(); return spans.some(([a, b]) => a <= h && h < b) ? 2 : h >= spans[0][0] ? 1 : 0; };   // 0 まだ・1 通った・2 いま
      for (const flat of ps.rings) {
        add({ polygon: { hierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(flat)),
          show: new C.CallbackProperty(() => state() > 0, false),
          material: new C.ColorMaterialProperty(new C.CallbackProperty(() => C.Color.WHITE.withAlpha(state() === 2 ? 0.24 : 0.06), false)) } });
        const ring = [];
        for (let j = 0; j < flat.length; j += 2) ring.push(flat[j], flat[j + 1], 300);
        ring.push(flat[0], flat[1], 300);
        add({ polyline: { positions: C.Cartesian3.fromDegreesArrayHeights(ring),
          show: new C.CallbackProperty(() => state() > 0, false),
          width: new C.CallbackProperty(() => (state() === 2 ? 5 : 3), false),
          material: new C.PolylineOutlineMaterialProperty({ outlineWidth: 1.5,
            color: new C.CallbackProperty(() => (state() === 2 ? SHU : IVORY), false),
            outlineColor: new C.CallbackProperty(() => (state() === 2 ? C.Color.WHITE : SUMI), false) }) } });
      }
      // 名札は名前だけ（入った時刻は題の札の一覧にある。上陸した所は「〜に上陸」の札とも重なるので）。いまの所は大きく朱の縁
      add({ position: C.Cartesian3.fromDegrees(ps.lon, ps.lat, 0), label: {
        text: ps.name + (ps.isle ? '（' + ps.isle + '）' : ''),
        show: new C.CallbackProperty(() => state() > 0, false),
        font: new C.CallbackProperty(() => (state() === 2 ? '700 18px "Zen Kaku Gothic New", sans-serif' : '700 14px "Zen Kaku Gothic New", sans-serif'), false),
        fillColor: C.Color.WHITE, style: C.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 4,
        outlineColor: new C.CallbackProperty(() => (state() === 2 ? SHU : C.Color.BLACK), false),
        horizontalOrigin: C.HorizontalOrigin.CENTER, verticalOrigin: C.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
    // 海の上ですぐ近くを通った所：いちばん近づいた地点に「〜まで約◯km」の小さな札（そこを過ぎたら出す）
    for (const x of D.near_passes || []) {
      add({ position: C.Cartesian3.fromDegrees(x.lon, x.lat, 0),
        point: { pixelSize: 6, color: C.Color.TRANSPARENT, outlineColor: C.Color.WHITE, outlineWidth: 2,
          show: new C.CallbackProperty(() => hNow() >= x.h, false), disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: `${x.isle || x.name}まで約${x.km}km`, font: '600 12px "Zen Kaku Gothic New", sans-serif',
          fillColor: C.Color.WHITE, outlineColor: SUMI, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(8, 10), horizontalOrigin: C.HorizontalOrigin.LEFT,
          show: new C.CallbackProperty(() => hNow() >= x.h, false), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
  }

  // 題の札の「通った都道府県」：入った順に、いまの所を朱で。海の上で 20km 以内をかすめた都道府県も別の行に
  let routeKey = '';
  function updRoute(hf) {
    const P = (D.passes || []).filter(ps => ps.h_in <= hf);
    const N = (D.near_passes || []).filter(x => x.h <= hf);
    const key = P.map(ps => ps.code + (ps.h_out > hf ? '*' : '')).join(',') + '|' + N.map(x => x.name).join(',');
    if (key === routeKey) return;
    routeKey = key;
    const el = $('tRoute');
    el.hidden = !P.length && !N.length;
    if (el.hidden) { el.textContent = ''; return; }
    let lastDay = null;
    const chips = P.map(ps => {
      const j = jst(Math.round(ps.h_in)), t = (j.D !== lastDay ? `${j.D}日` : '') + `${j.h}時`;
      lastDay = j.D;
      return `<span class="pf${ps.h_out > hf ? ' now' : ''}">${ps.name}${ps.isle ? '<small>（' + ps.isle + '）</small>' : ''}<i>${t}</i></span>`;
    });
    const near = N.map(x => `<span class="pf nr">${x.name}${x.isle ? '<small>（' + x.isle + '）</small>' : ''}<i>${jst(Math.round(x.h)).D}日 ${x.km}km</i></span>`);
    el.innerHTML =
      (P.length ? '<span class="lbl">中心が通った都道府県</span>' + chips.join('<span class="sep">›</span>') : '') +
      (N.length ? '<span class="lbl">すぐ近くを通った都道府県（海の上・20km以内）</span>' + near.join('<span class="sep">／</span>') : '') +
      `<span class="pnote">気象庁の${D.prelim ? '速報値（' + D.rec_gap + '時間ごと）' : D.rec_gap + '時間ごとの記録'}をなめらかにつないだ経路から求めた目安です。` +
      '位置は0.1度（約10km）単位なので、すぐ近くを通った所は陸の上を通った可能性もあります</span>';
  }
  let eyeEntity = null;

  // 通った範囲の絵：緯度経度をそのまま縦横にした canvas に円（多角形）を描く。
  // 同じ色の円をひとつの道筋にまとめて塗ると、重なったところも一度しか塗られない。
  function makeSwath(h0, h1) {
    const rings = [];
    for (const p of D.pts) {
      if (p[0] < h0 - 30 || p[0] > h1) continue;
      for (const [ri, ei, ni, kind] of [[6, 7, 8, 0], [9, 10, 11, 1]]) {
        if (p[ri] < 5) continue;
        const [la, lo] = shift(p[1], p[2], p[ei], p[ni]), pts = [];
        for (let k = 0; k < 48; k++) pts.push(dest(la, lo, k * 7.5, p[ri]));
        rings.push({ h: p[0] + 6, kind, pts });
      }
    }
    if (!rings.length) return null;
    const all = rings.flatMap(r => r.pts);
    const S = Math.min(...all.map(q => q[0])) - 0.3, N = Math.max(...all.map(q => q[0])) + 0.3;
    const W = Math.min(...all.map(q => q[1])) - 0.3, E = Math.max(...all.map(q => q[1])) + 0.3;
    const px = 2048 / Math.max(E - W, N - S);
    const cw = Math.ceil((E - W) * px), ch = Math.ceil((N - S) * px);
    const cvs = [0, 1].map(() => Object.assign(document.createElement('canvas'), { width: cw, height: ch }));
    const FILL = ['rgba(245,205,0,0.11)', 'rgba(226,40,30,0.24)'];
    let q = null, flip = 0, img = cvs[0];
    return {
      rect: C.Rectangle.fromDegrees(W, S, E, N),
      first: Math.min(...rings.map(r => r.h)),
      image(hf) {
        const k = Math.floor(hf);
        if (k === q) return img;
        q = k; flip ^= 1; img = cvs[flip];   // 同じ canvas を返すと Cesium が描き直さないので2枚を交互に使う
        const g = img.getContext('2d');
        g.clearRect(0, 0, cw, ch);
        for (const kind of [0, 1]) {
          g.beginPath();
          for (const r of rings) {
            if (r.kind !== kind || r.h > hf) continue;
            r.pts.forEach(([la, lo], i) => g[i ? 'lineTo' : 'moveTo']((lo - W) * px, (N - la) * px));
            g.closePath();
          }
          g.fillStyle = FILL[kind];
          g.fill('nonzero');
        }
        return img;
      },
    };
  }

  // ---------- 札 ----------
  let lastCard = -1;
  function updCards(hf) {
    const q = Math.floor(hf * 4);
    if (q === lastCard) return;
    lastCard = q;
    const s = atH(hf), j = jst(hf);
    const exact = KNOTS.has(Math.round(hf)) && Math.abs(hf - Math.round(hf)) < 0.02;
    $('cDate').textContent = `${j.M}月${j.D}日 ${j.h}時`;
    $('cP').textContent = `中心気圧 ${exact ? '' : '約'}${Math.round(s.p)}hPa　${STAGE[s.g] || ''}`;
    $('cW').textContent = (s.w > 0 ? `最大風速 ${Math.round(s.w * 0.5144)}m/s` : '') + (s.r50 > 1 ? `　暴風域 半径${Math.round(s.r50)}km` : '');
    $('time').value = hf;
  }

  viewer.scene.preRender.addEventListener(() => {
    if (season) { updSeason(); updNasa(); return; }
    if (!D) return;
    if (anim) {
      const f = Math.min(1, (performance.now() - anim.t0) / anim.dur);
      viewer.clock.currentTime = C.JulianDate.addHours(T0, lerp(anim.h0, anim.h1, f), new C.JulianDate());
    }
    const hf = Math.max(0, Math.min(HMAX, hNow()));
    updCloud(hf);
    updCards(hf);
    updRoute(hf);
    updNasa();
  });

  // ---------- ツアー ----------
  let anim = null, touring = false;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function tourPlan() {
    const K = [], P = D.pts, st = h => atH(Math.max(0, Math.min(HMAX, h)));
    const head = h => bearing(st(h - 3), st(h + 3));
    const lats = P.map(p => p[1]), lons = P.map(p => p[2]);
    const c0 = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 };
    const look = (h, lat, lon, rng, tilt, hd, dur, wait = 0) => K.push({ h, lat, lon, rng, tilt, hd, dur, wait });
    const follow = (h, rng, tilt, dur) => { const s = st(h); look(h, s.lat, s.lon, rng, tilt, head(h), dur); };
    // 山場：上陸した台風は上陸の時刻、しなかった台風は都道府県（島）を通った時刻か、日本にいちばん近づいた時刻
    const keyH = D.land ? D.land[0] : D.passes && D.passes.length ? D.passes[0].h_in : D.near ? D.near[1] : HMAX * 0.7;
    const landh = Math.round(keyH);
    look(0, c0.lat, c0.lon, 6500, 0, 0, 0.1, 3);
    const aEnd = Math.max(0, Math.min(D.peak - 12, landh - 12));
    for (let h = 0; h < aEnd; h += 3) follow(h, 1800, 30, 0.55);
    const bEnd = Math.min(D.peak + 13, landh - 9);
    for (let h = aEnd; h < bEnd; h += 3) { follow(h, 1500, 35, 0.8); if (h <= D.peak && D.peak < h + 3) K[K.length - 1].wait = 1.5; }
    for (let h = bEnd; h < landh - 9; h += 3) { const t = (h - bEnd) / Math.max(1, landh - 9 - bEnd); follow(h, lerp(1500, 1300, t), lerp(35, 40, t), 0.6); }
    for (let h = Math.max(0, landh - 9); h <= landh; h++) { const t = (h - (landh - 9)) / 9; follow(h, lerp(1300, 950, t), lerp(40, 38, t), 0.9); }
    let dh = 8;
    if (D.land) {
      const [lh, la, lo] = D.land, hd0 = head(landh);
      look(lh, la, lo, 950, 38, hd0, 1.2, 1.2);
      for (let k = 1; k <= 8; k++) look(lh + k * 0.2, la, lo, lerp(800, 320, k / 8), lerp(42, 62, k / 8), (hd0 + k * 45) % 360, 1.1);
      const fc = D.focus && D.focus.rng < 300 ? D.focus : null;
      const flyEnd = landh + (fc ? fc.dh - 1 : 11);
      for (let h = landh + 1; h <= Math.min(HMAX, flyEnd); h++) { const t = (h - landh - 1) / Math.max(1, flyEnd - landh - 1); follow(h, lerp(260, 420, t), lerp(64, 58, t), 1.6); }
      if (fc) { dh = fc.dh; look(Math.min(HMAX, landh + dh), fc.lat, fc.lon, fc.rng, fc.tilt, fc.head, 3.0, 2.5); }
      else if (D.focus) { dh = 13; look(Math.min(HMAX, landh + dh), 36.3, 139.6, 1500, 20, 0, 3.5, 3.5); }   // 東日本台風：東日本の広い範囲を見渡す
      else { dh = 13; const h = Math.min(HMAX, landh + dh), s = st(h); look(h, s.lat, s.lon, 1500, 25, head(h), 3.5, 3.5); }
    } else {
      // 上陸しなかった台風：いちばん近づいたところで少し止まって、日本との近さを見せる
      const s = st(keyH);
      look(keyH, s.lat, s.lon, 800, 45, head(keyH), 1.2, 1.5);
    }
    for (let h = landh + dh + 1; h < Math.min(HMAX, landh + dh + 11); h += 2) { const t = (h - landh - dh - 1) / 10; follow(h, lerp(700, 1100, t), 45, 0.6); }
    for (let h = landh + dh + 12; h <= HMAX; h += 6) follow(h, 1600, 35, 0.6);
    look(HMAX, c0.lat, c0.lon, 7000, 0, 0, 4.0, 5);
    return K;
  }
  function fly(k, h0) {
    return new Promise(res => {
      anim = { h0, h1: k.h, t0: performance.now(), dur: Math.max(1, k.dur * 1000) };
      const target = new C.BoundingSphere(C.Cartesian3.fromDegrees(k.lon, k.lat, 0), 1);
      const offset = new C.HeadingPitchRange(rad(k.hd), rad(-(90 - k.tilt)), k.rng * 1000);
      viewer.camera.flyToBoundingSphere(target, { offset, duration: k.dur, easingFunction: C.EasingFunction.LINEAR_NONE, complete: res, cancel: res });
    });
  }
  // 再生のたびに番号を振る。止めたあとに古い再生の続き（待ち時間の後）が動いても、新しい再生やボタンの文字を壊さない
  let tourRun = 0;
  const playLabel = () => (season ? '1年をふりかえる' : '足あとをたどる');
  async function playTour() {
    stopFree();
    const run = ++tourRun;
    touring = true;
    $('play').textContent = '止める';
    const K = tourPlan();
    let h0 = 0;
    for (const k of K) {
      if (!touring || run !== tourRun) return;
      await fly(k, h0);
      if (run !== tourRun) return;
      anim = null;
      h0 = k.h;
      if (k.wait && touring) await sleep(k.wait * 1000);
    }
    if (run !== tourRun) return;
    touring = false; anim = null;
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    $('play').textContent = playLabel();
  }
  function stopTour() {
    tourRun++;
    touring = false; anim = null; viewer.camera.cancelFlight(); viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    $('play').textContent = playLabel();
  }
  $('play').addEventListener('click', () => (season ? playSeason() : touring ? stopTour() : playTour()));

  // 自由に再生（2時間を1秒で。台風を追いかける）。まとめて見る画面では2日を1秒で
  function stopFree() { viewer.clock.shouldAnimate = false; viewer.trackedEntity = undefined; $('free').setAttribute('aria-pressed', 'false'); }
  $('free').addEventListener('click', () => {
    if (viewer.clock.shouldAnimate) { stopFree(); return; }
    if (touring) stopTour();
    if (season) {
      if (sH() >= season.HS - 1) viewer.clock.currentTime = season.T.clone();
      viewer.clock.multiplier = 2 * 86400;
    } else {
      if (hNow() >= HMAX - 0.1) viewer.clock.currentTime = T0.clone();
      viewer.clock.multiplier = 7200;
      viewer.trackedEntity = eyeEntity;
    }
    viewer.clock.shouldAnimate = true;
    $('free').setAttribute('aria-pressed', 'true');
  });
  $('time').addEventListener('input', e => {
    if (touring) stopTour();
    viewer.clock.currentTime = C.JulianDate.addHours(season ? season.T : T0, +e.target.value, new C.JulianDate());
  });

  // 雲の切り替え
  const segs = [...document.querySelectorAll('[data-cloud]')];
  function setCloud(c) {
    cloud = c;
    segs.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cloud === c)));
  }
  segs.forEach(b => b.addEventListener('click', () => { setCloud(b.dataset.cloud); if (!season) chosenCloud = b.dataset.cloud; }));

  // スマホでは日時の札を操作の帯のすぐ上に置くので、帯の高さを CSS に渡す
  new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', $('bar').offsetHeight + 'px')).observe($('bar'));

  // ---------- 今年日本に来た台風をまとめて見る ----------
  // data/season<年>.json（export_web.py year）。線の色は日本に近づいた月。時刻のつまみで季節を通して動かせる
  let season = null;
  const MONTH_COL = { 5: '#9fd3f5', 6: '#4fb3e8', 7: '#6cc788', 8: '#ffd166', 9: '#f4a261', 10: '#ef6f8b', 11: '#b89cf2' };
  const sH = () => (season ? C.JulianDate.secondsDifference(viewer.clock.currentTime, season.T) / 3600 : 0);
  const sAt = (s, h) => {          // 台風 s の、その台風の時刻 h での位置と気圧（3時間ごとの点のあいだは直線）
    const P = s.pts;
    if (h < P[0][0] || h > P[P.length - 1][0]) return null;
    let i = 0;
    while (i < P.length - 2 && P[i + 1][0] <= h) i++;
    const a = P[i], b = P[i + 1] || a, t = b[0] > a[0] ? (h - a[0]) / (b[0] - a[0]) : 0;
    return { lat: lerp(a[1], b[1], t), lon: lerp(a[2], b[2], t), p: lerp(a[3], b[3], t), g: a[4] };
  };
  const sJst = hs => { const d = new Date(C.JulianDate.toDate(season.T).getTime() + (hs + 9) * 3600e3); return { M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours() }; };

  async function loadSeason(year) {
    const S = await (await fetch(`data/season${year}.json`)).json();
    D = null; clearParts();
    const t0s = S.storms.map(s => C.JulianDate.fromIso8601(s.t0));
    const T = t0s.reduce((a, b) => (C.JulianDate.lessThan(b, a) ? b : a)).clone();
    const offs = t0s.map(t => C.JulianDate.secondsDifference(t, T) / 3600);
    const HS = Math.max(...S.storms.map((s, i) => offs[i] + s.pts[s.pts.length - 1][0]));
    season = { S, T, offs, HS, year, key: '' };
    const clock = viewer.clock;
    clock.startTime = T.clone();
    clock.stopTime = C.JulianDate.addHours(T, HS, new C.JulianDate());
    clock.clockRange = C.ClockRange.CLAMPED;
    clock.currentTime = clock.stopTime.clone();
    $('time').max = HS;
    S.storms.forEach((s, i) => {
      const col = C.Color.fromCssColorString(MONTH_COL[s.month] || '#ffffff');
      const pos = s.pts.map(p => C.Cartesian3.fromDegrees(p[2], p[1], 1500));
      const hl = () => sH() - offs[i];
      add({ polyline: { positions: pos, width: 2, material: col.withAlpha(0.3) } });
      add({ polyline: { width: s.kind === '上陸' ? 5 : 3.5, material: col, positions: new C.CallbackProperty(() => {
        const h = hl(), out = [];
        for (let k = 0; k < s.pts.length && s.pts[k][0] <= h; k++) out.push(pos[k]);
        const q = sAt(s, h);
        if (q) out.push(C.Cartesian3.fromDegrees(q.lon, q.lat, 1500));
        return out.length > 1 ? out : [];
      }, false) } });
      // いま動いている台風の目と番号
      add({ position: new C.CallbackProperty(() => { const q = sAt(s, hl()); return q ? C.Cartesian3.fromDegrees(q.lon, q.lat, 0) : C.Cartesian3.ZERO; }, false),
        point: { pixelSize: 12, color: col, outlineColor: C.Color.WHITE, outlineWidth: 2, show: new C.CallbackProperty(() => !!sAt(s, hl()), false),
          disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: `${s.num}号`, font: '700 14px "Zen Kaku Gothic New", sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(10, -10), horizontalOrigin: C.HorizontalOrigin.LEFT,
          show: new C.CallbackProperty(() => !!sAt(s, hl()), false), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      // 山場（上陸・通過・いちばん近づいた所）の札。そこを過ぎたら出す
      const k = sAt(s, s.key_h) || { lat: s.pts[0][1], lon: s.pts[0][2] };
      add({ position: C.Cartesian3.fromDegrees(k.lon, k.lat, 0),
        point: { pixelSize: s.kind === '上陸' ? 10 : 7, color: s.kind === '上陸' ? SHU : col, outlineColor: C.Color.WHITE, outlineWidth: 2,
          show: new C.CallbackProperty(() => hl() >= s.key_h, false), disableDepthTestDistance: Number.POSITIVE_INFINITY },
        // 沖縄の近くに札が集まるので、地図の上は番号だけ（名前は題の札の一覧にある）
        label: { text: `${s.num}号${s.kind === '上陸' ? ' 上陸' : ''}`, font: '700 13px "Zen Kaku Gothic New", sans-serif',
          fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(9, 0), horizontalOrigin: C.HorizontalOrigin.LEFT, verticalOrigin: C.VerticalOrigin.CENTER,
          show: new C.CallbackProperty(() => hl() >= s.key_h, false), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    });
    // 札：題と、13個の一覧（押すとその台風へ）
    $('tName').textContent = `${year}年 日本に来た台風`;
    $('tSub').textContent = `接近${S.approach}個（うち上陸${S.landfall}個）　気象庁「台風位置表」の印による`;
    const months = [...new Set(S.storms.map(s => s.month))].sort((a, b) => a - b);
    $('tNote').innerHTML = '線の色は日本に近づいた月：' + months.map(m => `<span class="mk" style="--c:${MONTH_COL[m]}">${m}月</span>`).join('') +
      '　第14号から後は速報値';
    const el = $('tRoute');
    el.hidden = false;
    el.innerHTML = '<span class="lbl">押すとその台風の足あとへ</span><span class="chips">' + S.storms.map(s =>
      `<button type="button" class="sc${s.kind === '上陸' ? ' lf' : ''}" data-sid="${s.id}" style="--c:${MONTH_COL[s.month]}"><b></b>${s.num}号 ${s.kana}${s.kind === '上陸' ? '・上陸' : ''}</button>`).join('') + '</span>';
    el.querySelectorAll('.sc').forEach(b => b.addEventListener('click', () => { $('storm').value = b.dataset.sid; load(b.dataset.sid); }));
    // 雲は NASA の写真か、なし（雲の絵は1つの台風用）
    segs.forEach(b => { if (b.dataset.cloud === 'sat' || b.dataset.cloud === 'ukiyo') { b.disabled = true; b.title = '1つの台風を選んだときに使えます'; } });
    const nasaBtn = segs.find(b => b.dataset.cloud === 'nasa');
    nasaBtn.disabled = false; nasaBtn.title = 'その日に NASA の衛星が撮った写真（止めたときに替わります）';
    setCloud('none');
    $('play').textContent = '1年をふりかえる';
    viewer.camera.setView({ destination: C.Rectangle.fromDegrees(118, 12, 162, 47) });
  }

  // まとめて見る画面の札：日付と、その日に動いている台風
  function updSeason() {
    const hs = Math.max(0, Math.min(season.HS, sH()));
    if (viewer.clock.shouldAnimate && hs >= season.HS - 0.01) stopFree();
    const j = sJst(hs);
    const live = season.S.storms.map((s, i) => [s, sAt(s, hs - season.offs[i])]).filter(([, q]) => q);
    const key = `${j.M}/${j.D}/${j.h}|` + live.map(([s, q]) => s.num + ':' + Math.round(q.p)).join(',');
    if (key === season.key) return;
    season.key = key;
    $('cDate').textContent = `${j.M}月${j.D}日 ${j.h}時`;
    $('cP').textContent = live.length ? live.map(([s, q]) => `${s.num}号 ${s.kana} ${Math.round(q.p)}hPa`).join('　') : '日本に来た台風は動いていません';
    $('cW').textContent = live.length ? '' : '（この年に日本へ接近・上陸した台風だけを描いています）';
    $('time').value = hs;
    document.querySelectorAll('#tRoute .sc').forEach(b => b.classList.toggle('on', live.some(([s]) => s.id === b.dataset.sid)));
  }

  // 季節を再生：はじめから、約60秒で最後まで
  function playSeason() {
    stopTour();
    viewer.clock.currentTime = season.T.clone();
    viewer.clock.multiplier = season.HS * 3600 / 60;
    viewer.clock.shouldAnimate = true;
    $('free').setAttribute('aria-pressed', 'true');
  }

  // ---------- 読み込み ----------
  async function load(sid) {
    stopTour(); stopFree();
    if (sid.startsWith('season')) { await loadSeason(+sid.slice(6)); return; }
    season = null;
    $('play').textContent = '足あとをたどる';
    segs.forEach(b => { b.disabled = false; b.title = ''; });
    $('cW').textContent = '';
    D = await (await fetch(`data/${sid}.json`)).json();
    T0 = C.JulianDate.fromIso8601(D.t0);
    HMAX = D.pts[D.pts.length - 1][0];
    KNOTS = new Set(D.knots);
    const clock = viewer.clock;
    clock.startTime = T0.clone();
    clock.stopTime = C.JulianDate.addHours(T0, HMAX, new C.JulianDate());
    clock.clockRange = C.ClockRange.CLAMPED;
    clock.currentTime = C.JulianDate.addHours(T0, D.peak, new C.JulianDate());
    $('time').max = HMAX;
    $('tName').textContent = D.name_ja;
    $('tSub').textContent = `${D.year}年（${era(D.year)}）台風第${D.num}号　国際名 ${D.name}${D.prelim ? '　速報値' : ''}`;
    $('tNote').textContent = D.note;
    const nasaBtn = segs.find(b => b.dataset.cloud === 'nasa');
    nasaBtn.disabled = D.year < 2000;
    nasaBtn.title = D.year < 2000 ? `${D.year}年には気象衛星の写真がありません` : 'その日に NASA の衛星が撮った写真';
    setCloud(chosenCloud && (chosenCloud !== 'nasa' || D.year >= 2000) ? chosenCloud : 'sat');
    lastCard = -1; routeKey = '-';
    build();
    const pk = atH(D.peak);
    viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(pk.lon - 8, pk.lat + 8, 6.5e6) });
  }
  $('storm').addEventListener('change', e => load(e.target.value));

  // 今年の台風を選べるようにする（data/season2026.json の一覧から）
  async function addYear(year) {
    try {
      const S = await (await fetch(`data/season${year}.json`)).json();
      const g = document.createElement('optgroup');
      g.label = `${year}年 日本に来た台風（接近${S.approach}・上陸${S.landfall}）`;
      g.innerHTML = `<option value="season${year}">${year}年の${S.approach}個をまとめて見る</option>` + S.storms.map(s =>
        `<option value="${s.id}">第${s.num}号 ${s.kana}（${s.month}月・${s.kind}${s.prelim ? '・速報値' : ''}）</option>`).join('');
      $('storm').appendChild(g);
    } catch (e) { /* 一覧がなくても、ほかの台風は見られる */ }
  }
  // ?s=season2026 や ?s=2615 で、はじめに開く台風を選べる
  addYear(2026).then(() => {
    const want = new URLSearchParams(location.search).get('s');
    if (want && [...$('storm').options].some(o => o.value === want)) $('storm').value = want;
    load($('storm').value);
  });
})();
