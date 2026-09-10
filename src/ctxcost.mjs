// 文脈の長さが、速度にいくら効くか。
//
// 数字はぜんぶ実測。2026-09-03 のアームログ（llama-server の生ログ5本、汚染1本を除く）から、
// 文脈の長さ別に「生成 tok/s」と「前処理 tok/s」を集計したもの。
// 詳細は ~/文脈ゲートウェイ/計測の記録/解析/手順4-結果.md。
//
// なぜこれを利用者に見せるのか：
//   会話が伸びると遅くなるが、**画面には何も出ない**。
//   20,000トークンまで伸びて生成が3割落ちていても、利用者には分からない。
//   「今日はなぜか遅い」の正体がこれなので、原因を見えるようにする。
//
// 効く手は1つだけ。**会話を切ること。** 圧縮ではない。
// 圧縮は履歴を書き換えるので、書き換えた場所から後ろのキャッシュが死ぬ。
// gemma4 は SWA のため、KVシフトによる救済（--cache-reuse）も効かない（実測で確認済み）。

/** [文脈トークン数の下限, 生成 tok/s, 前処理 tok/s] */
const MEASURED = [
  [0, 36.7, 660],
  [4000, 33.7, 532],
  [8000, 31.4, 490],
  [12000, 28.8, 366],
  [16000, 27.3, 364],
  [20000, 25.5, 279],
  [24000, 24.7, 258],
  [28000, 24.0, 326],
  [32000, 21.4, 209],
];

const FRESH_DECODE = MEASURED[0][1];

function rowFor(tokens) {
  let row = MEASURED[0];
  for (const r of MEASURED) if (tokens >= r[0]) row = r;
  return row;
}

/** その長さでの生成速度の目安 [tok/s] */
export function decodeSpeedAt(tokens) {
  return rowFor(tokens)[1];
}

/** まっさらな会話に対する速度の比（1.0 = 変わらない） */
export function speedRatio(tokens) {
  return decodeSpeedAt(tokens) / FRESH_DECODE;
}

/**
 * 知らせるべき区切り。
 *
 * 毎ターン出すと雑音になるので、**跨いだときに1回だけ**出す。
 * 16,000 を最初の区切りにしたのは、そこで生成が 74% まで落ちるため
 * （それより手前は9割前後で、知らせるほどの差ではない）。
 */
export const NOTICE_THRESHOLDS = [16000, 24000, 32000];

/**
 * 区切りを跨いだときに出す一行。跨いでいなければ null。
 *
 * ■ 跨いだ区切りを**全部**返す
 *   ここは一番上の区切り1つだけを返していた。呼び出し側（agent.mjs）はその1つしか
 *   「知らせた」と記録できないので、2つ以上まとめて跨ぐと、次のターンで下の区切りがまた鳴る。
 *   実測（2026-09-10）: 33,000 トークンの状態から始めると、会話の大きさは変わらないのに
 *       1回目 → 区切り 32000 / 2回目 → 24000 / 3回目 → 16000
 *   と、同じ見た目の知らせが3回続けて出た（文中の数字は毎回「いまの長さ」なので、同じ文になる）。
 *   `--resume` で長い会話を読み込んだ直後がちょうどこれに当たる。
 *   「跨いだときに1回だけ」を守るには、跨いだものを全部渡して全部記録させる必要がある。
 */
export function contextNotice(tokens, alreadyNoticed = new Set()) {
  const crossed = NOTICE_THRESHOLDS.filter((t) => tokens >= t && !alreadyNoticed.has(t));
  if (!crossed.length) return null;
  const pct = Math.round(speedRatio(tokens) * 100);
  return {
    // 画面に出す文はいちばん上の区切りで決まる（NOTICE_THRESHOLDS は小さい順）
    threshold: crossed[crossed.length - 1],
    // 記録するのはこちら。**呼び出し側はこれを全部 add すること。**
    thresholds: crossed,
    text:
      `会話が ${Math.round(tokens / 1000)}k トークンになりました。` +
      `この長さでは生成がまっさらなときの約 ${pct}% の速さです（実測）。` +
      '別の作業に移るなら /clear で切ると元の速さに戻ります。',
  };
}

/** /stats に出す一行 */
export function contextLine(tokens, numCtx) {
  const pct = Math.round(speedRatio(tokens) * 100);
  const use = numCtx ? ` / 上限の ${Math.round((tokens / numCtx) * 100)}%` : '';
  return `${tokens.toLocaleString()} トークン${use}（この長さでの生成速度はまっさら比 約${pct}%）`;
}
