/**
 * Local-only, bounded adaptation of simple-ime 1.2.4's syllable/dictionary
 * candidate approach (MIT, copyright 2025 nieyuyao0826@hotmail.com).
 * See vendor/simple-ime/PROVENANCE.md and LICENSE; Google/AOSP data retains
 * Apache-2.0. Modified here: bounded DP/beam search, local JSON loading, no DOM,
 * exhaustive correction, learning, persistence, network or keystroke logging.
 */
export type PinyinScript = "zh-CN" | "zh-TW";
type Word = { w: string; f: number };
type Dictionary = Record<string, readonly Word[]>;
type Path = { text: string; score: number };

export const MAX_PINYIN_INPUT_LENGTH = 32;
export const MAX_PINYIN_CANDIDATES = 32;
const MAX_PREFIX_KEYS = 8192;
const WORD_LIMIT = MAX_PINYIN_CANDIDATES;
const BEAM_SIZE = 8;
const EMPTY: readonly string[] = Object.freeze([]);
const SYLLABLES = new Set("a|ai|an|ang|ao|ba|bai|ban|bang|bao|bei|ben|beng|bi|bian|biao|bie|bin|bing|bo|bu|ca|cai|can|cang|cao|ce|cen|ceng|cha|chai|chan|chang|chao|che|chen|cheng|chi|chong|chou|chu|chua|chuai|chuan|chuang|chui|chun|chuo|ci|cong|cou|cu|cuan|cui|cun|cuo|da|dai|dan|dang|dao|de|dei|den|deng|di|dia|dian|diao|die|ding|diu|dong|dou|du|duan|dui|dun|duo|e|ei|en|er|fa|fan|fang|fei|fen|feng|fiao|fo|fou|fu|ga|gai|gan|gang|gao|ge|gei|gen|geng|gong|gou|gu|gua|guai|guan|guang|gui|gun|guo|ha|hai|han|hang|hao|he|hei|hen|heng|hong|hou|hu|hua|huai|huan|huang|hui|hun|huo|ji|jia|jian|jiang|jiao|jie|jin|jing|jiong|jiu|ju|juan|jue|jun|jve|ka|kai|kan|kang|kao|ke|kei|ken|keng|kong|kou|ku|kua|kuai|kuan|kuang|kui|kun|kuo|la|lai|lan|lang|lao|le|lei|leng|li|lia|lian|liang|liao|lie|lin|ling|liu|lo|long|lou|lu|luan|lue|lun|luo|lv|lve|ma|mai|man|mang|mao|me|mei|men|meng|mi|mian|miao|mie|min|ming|miu|mo|mou|mu|na|nai|nan|nang|nao|ne|nei|nen|neng|ni|nian|niang|niao|nie|nin|ning|niu|nong|nou|nu|nuan|nue|nun|nuo|nv|nve|o|ou|pa|pai|pan|pang|pao|pei|pen|peng|pi|pian|piao|pie|pin|ping|po|pou|pu|qi|qia|qian|qiang|qiao|qie|qin|qing|qiong|qiu|qu|quan|que|qun|qve|ran|rang|rao|re|ren|reng|ri|rong|rou|ru|ruan|rui|run|ruo|sa|sai|san|sang|sao|se|sen|seng|sha|shai|shan|shang|shao|she|shei|shen|sheng|shi|shou|shu|shua|shuai|shuan|shuang|shui|shun|shuo|si|song|sou|su|suan|sui|sun|suo|ta|tai|tan|tang|tao|te|teng|ti|tian|tiao|tie|ting|tong|tou|tu|tuan|tui|tun|tuo|wa|wai|wan|wang|wei|wen|weng|wo|wu|xi|xia|xian|xiang|xiao|xie|xin|xing|xiong|xiu|xu|xuan|xue|xun|xve|ya|yan|yang|yao|ye|yi|yin|ying|yo|yong|you|yu|yuan|yue|yun|yve|za|zai|zan|zang|zao|ze|zei|zen|zeng|zha|zhai|zhan|zhang|zhao|zhe|zhei|zhen|zheng|zhi|zhong|zhou|zhu|zhua|zhuai|zhuan|zhuang|zhui|zhun|zhuo|zi|zong|zou|zu|zuan|zui|zun|zuo".split("|"));
let dictionary: Dictionary | undefined;
let dictionaryKeys: readonly string[] | undefined;
let toTraditional: ((text: string) => string) | undefined;

function data(): Dictionary {
  // Metro's static require bundles this exact JSON locally. No asset fetch.
  dictionary ??= require("./vendor/simple-ime/google-pinyin-dict.json") as Dictionary;
  return dictionary;
}

function lowerBound(keys: readonly string[], prefix: string): number {
  let left = 0, right = keys.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (keys[middle] < prefix) left = middle + 1;
    else right = middle;
  }
  return left;
}

/** Minimum-syllable path without upstream exponential exhaustive enumeration.
 * Apostrophe boundaries stay explicit; an incomplete/initial letter remains
 * a token and can still match the real dictionary's abbreviation entries. */
function segment(input: string): string[] {
  const result: string[] = [];
  for (const chunk of input.split("'").filter(Boolean)) {
    const best: (string[] | undefined)[] = new Array(chunk.length + 1);
    best[chunk.length] = [];
    for (let start = chunk.length - 1; start >= 0; start--) {
      let chosen: string[] | undefined;
      for (let end = start + 1; end <= Math.min(start + 6, chunk.length); end++) {
        const token = chunk.slice(start, end), tail = best[end];
        if (SYLLABLES.has(token) && tail) {
          const next = [token, ...tail];
          if (!chosen || next.length < chosen.length) chosen = next;
        }
      }
      best[start] = chosen ?? [chunk[start], ...best[start + 1]!];
    }
    result.push(...best[0]!);
  }
  return result;
}

/** Only whole-composition paths escape this function. Prefix words are never
 * presented as though they consumed all raw input: the controller receives
 * complete replacement strings, not upstream partial matchLength candidates. */
function combine(segments: readonly string[], words: (key: string) => readonly Word[]): string[] {
  // Do not turn an unknown/incomplete suffix into invented abbreviation prose.
  // Whole-key abbreviations and genuine prefix completions are handled above.
  if (!segments.every(token => SYLLABLES.has(token))) return [];
  const paths: Path[][] = Array.from({ length: segments.length + 1 }, () => []);
  paths[0] = [{ text: "", score: 0 }];
  for (let start = 0; start < segments.length; start++) {
    if (!paths[start].length) continue;
    let key = "";
    for (let end = start; end < segments.length; end++) {
      key += segments[end];
      const matches = words(key).filter(word => Array.from(word.w).length === end - start + 1).slice(0, 8);
      if (!matches.length) continue;
      const next = paths[end + 1];
      for (const path of paths[start]) for (const word of matches) {
        // Real static word frequency, not a claimed contextual language model.
        next.push({ text: path.text + word.w, score: path.score + Math.log1p(word.f) - 14 });
      }
      next.sort((a, b) => b.score - a.score || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
      const seen = new Set<string>();
      paths[end + 1] = next.filter(path => !seen.has(path.text) && !!seen.add(path.text)).slice(0, BEAM_SIZE);
    }
  }
  return paths[segments.length].map(path => path.text);
}

function traditional(text: string): string {
  if (!toTraditional) {
    const opencc = require("./vendor/opencc-js/cn2t.js") as {
      Converter(options: { from: "cn"; to: "tw" }): (value: string) => string;
    };
    toTraditional = opencc.Converter({ from: "cn", to: "tw" });
  }
  return toTraditional(text);
}

/**
 * Real offline word/phrase candidates. Every returned string replaces ALL raw
 * composition (including apostrophes); the caller must not consume by Hanzi
 * length. Backspace/selection/navigation remain the controller's responsibility.
 * Invalid/over-limit input returns [] without truncating or committing raw.
 * zh-TW is genuine local OpenCC conversion, not a separate Traditional LM.
 */
export function getPinyinCandidates(raw: string, script: PinyinScript = "zh-CN"): readonly string[] {
  if (typeof raw !== "string" || !raw.length || raw.length > MAX_PINYIN_INPUT_LENGTH ||
      script !== "zh-CN" && script !== "zh-TW") return EMPTY;
  const normalized = raw.toLowerCase().replace(/ü/g, "v").replace(/’/g, "'");
  if (!/^[a-z']+$/.test(normalized)) return EMPTY;
  const key = normalized.replace(/'/g, "");
  if (!key) return EMPTY;
  try {
    const dict = data(), lookups = new Map<string, readonly Word[]>(), segments = segment(normalized);
    const explicitSyllables = normalized.includes("'") && segments.every(token => SYLLABLES.has(token)) ? segments.length : null;
    const words = (pinyin: string): readonly Word[] => {
      const cached = lookups.get(pinyin);
      if (cached) return cached;
      const rows = Object.prototype.hasOwnProperty.call(dict, pinyin) ? dict[pinyin] : [];
      const ranked = rows.filter(row => typeof row.w === "string" && Number.isFinite(row.f) && row.f >= 0)
        .slice().sort((a, b) => b.f - a.f || (a.w < b.w ? -1 : a.w > b.w ? 1 : 0)).slice(0, WORD_LIMIT);
      lookups.set(pinyin, ranked);
      return ranked;
    };
    dictionaryKeys ??= Object.keys(dict).sort();
    const known = new Map<string, number>();
    const add = (word: Word) => known.set(word.w, Math.max(word.f, known.get(word.w) ?? 0));
    const exact = words(key).filter(word => explicitSyllables === null || Array.from(word.w).length === explicitSyllables);
    for (const word of exact) add(word);
    const first = lowerBound(dictionaryKeys, key);
    for (let index = first; !exact.length && explicitSyllables === null && index < Math.min(first + MAX_PREFIX_KEYS, dictionaryKeys.length); index++) {
      const completion = dictionaryKeys[index];
      if (!completion.startsWith(key)) break;
      for (const word of words(completion).slice(0, 8)) add(word);
    }
    const ranked = [...known].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, MAX_PINYIN_CANDIDATES).map(([text]) => text);
    const joined = combine(segments, words);
    const output: string[] = [], seen = new Set<string>();
    for (const text of [...ranked, ...joined]) {
      const rendered = script === "zh-TW" ? traditional(text) : text;
      if (!rendered || seen.has(rendered)) continue;
      seen.add(rendered); output.push(rendered);
      if (output.length === MAX_PINYIN_CANDIDATES) break;
    }
    return Object.freeze(output);
  } catch {
    // Leave the exact raw draft untouched when local data cannot be read.
    return EMPTY;
  }
}
