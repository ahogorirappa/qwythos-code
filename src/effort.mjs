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
 * 同じ問題を temp=0 で投げると low と high が1バイト違わぬ同じ出力を返した。
 * 段階を持つモデル（qwen3 や gpt-oss）では効くので送りはするが、**それだけでは飾りになる。**
 *
 * そこで言葉での指示（`directive`）を併用する。どちらか効いたほうが効く、という作りにしてある。
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
    directive: '結論を出す前に、可能性を列挙し、それぞれ検討してから答えること。',
    label: '深く',
    hint: '筋道の要る問題。実測で6〜24倍の時間がかかる'
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
