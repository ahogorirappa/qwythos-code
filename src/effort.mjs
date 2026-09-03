/**
 * effort — 「どれだけ考えさせるか」を1か所に集める。
 *
 * ## なぜ要るか
 *
 * 2026-09-03 に gemma4:26b で測ったら、考える／考えないの差はこうだった。
 *
 *     道具を選ぶだけの問題（4問）   think off: 4tok / 0.46秒
 *                                  think on : 74〜85tok / 2.3〜2.5秒   → 答えは4問とも同一
 *     筋道の要る問題（3問）         think off: 42〜327tok / 1.3〜9.1秒
 *                                  think on : 1147〜1927tok / 31〜53秒 → off は論理問題で間違えた
 *
 * つまり **考える価値は問題によって桁で変わる**のに、いまは全部 on か全部 off しかない。
 * 「read_file を6回呼ぶだけ」の依頼で毎回250字考えるのは、1回あたり2秒の丸損になる。
 *
 * ## 二段構えにしてある理由
 *
 * ollama には `think: "low"|"medium"|"high"|"max"` という段階がある。**が、gemma4 はこれを見ていない。**
 * 同じ問題を temp=0 で 2回ずつ投げた結果（2026-09-03）:
 *
 *     low    3183字 / 3961字      ← 同じ段階で違う出力が出て、
 *     high   3183字 / 3961字      ← 違う段階で同じ出力が出る。
 *     true   3961字 / 3183字      ← つまり段階は結果に一切効いていない。
 *
 * 段階を持つモデル（qwen3 や gpt-oss）では効くので送りはするが、**それだけでは飾りになる。**
 *
 * そこで言葉での指示（`directive`）を併用する。こちらは gemma4 によく効いた。
 *
 *     指示なし   3183字 / 1147tok / 37.0秒
 *     「2文以内」1022字 /  370tok / 13.2秒   ← 3分の1・2.8倍速。**答えは正解のまま**
 *     「5文以内」1178字 /  403tok / 10.8秒
 *     「徹底的」 3196字 / 1235tok / 33.3秒   ← 深くならず、答えの形だけ壊れた
 *
 * **効くのは「短くしろ」だけで、「深く考えろ」は効かない。** だから段は
 * 「考える長さの上限」として並べてあり、high はその上限を外した状態を指す。
 *
 * 両方効かないモデルでは off と on の2値に落ちるが、そのときは `/effort` がそう表示する。
 * **効いていないものを「効いています」と出さないこと。** それが `/think` で一度やらかしている。
 */

/** 段階の定義。ここだけ直せば、コマンドも表示も既定値も追随する。 */
export const EFFORT_LEVELS = {
  off: {
    think: false,
    directive: null,
    label: '考えない',
    hint: '道具を選ぶだけの作業。実測で約5倍速い'
  },
  low: {
    think: 'low',
    directive: '考えるときは2文以内で簡潔に。すぐ結論に進むこと。',
    label: '浅く',
    hint: '手順が決まっている作業'
  },
  medium: {
    think: 'medium',
    directive: '考えるときは5文以内にまとめること。',
    label: 'ふつう',
    hint: '既定'
  },
  high: {
    think: 'high',
    // **ここは null で正しい。** 「徹底的に考えよ」と足しても深さは変わらなかった
    // （3183字 → 3196字。2026-09-03 実測）。深くはならないのに、答えが箇条書きに化けて
    // 「一文で」という利用者の指示を踏み潰した。**足して悪くなるものは足さない。**
    // この段は「長さの上限を外す」＝モデルの素の深さ、という意味にしてある。
    directive: null,
    label: '深く',
    hint: '上限なし。素の深さで考える（実測で medium の3.4倍の時間）'
  }
};

export const EFFORT_ORDER = ['off', 'low', 'medium', 'high'];
export const DEFAULT_EFFORT = 'medium';

/** 打ち間違いや古い書き方を受け取る。分からなければ null（呼び出し側が使い方を出す）。 */
export function normalizeEffort(value) {
  if (value === false || value === 'false' || value === 'none') return 'off';
  if (value === true || value === 'true' || value === 'on') return DEFAULT_EFFORT;
  const key = String(value ?? '').trim().toLowerCase();
  if (key in EFFORT_LEVELS) return key;
  // 段階を数字で書く人がいる（/effort 3）
  const n = Number(key);
  if (Number.isInteger(n) && n >= 0 && n < EFFORT_ORDER.length) return EFFORT_ORDER[n];
  return null;
}

/** ollama に送る think の値。段階を持たないモデルでは呼び出し側が false に落とす。 */
export function thinkValueFor(effort) {
  return (EFFORT_LEVELS[effort] ?? EFFORT_LEVELS[DEFAULT_EFFORT]).think;
}

/**
 * system プロンプトに足す一文。無い段階では null。
 * 考えさせない段階では、考える長さの指示は意味がないので出さない。
 */
export function effortDirective(effort) {
  return (EFFORT_LEVELS[effort] ?? EFFORT_LEVELS[DEFAULT_EFFORT]).directive;
}
