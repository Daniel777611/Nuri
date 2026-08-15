"""3 对话与主动模型 — 回复范例（few-shot）.

运营团队手写的「NURI 可直接使用的回覆範例」，作为对话示例注入，而不是作为
规则文字写进 persona。

分开的理由是它治的问题不一样。persona 和 NURI_JSON_SUFFIX 里已经写了「一次
问一件事」「还在了解情况时只做两件事」，模型照样一次列五个问题——「该多长」
「要不要分点」「结论阶段一段话讲完」这类语域约束，用句子描述的效果远不如给
一条真实的回复看。所以这里存的是成对的（家长问 / NURI 答），按 role 交替插
进消息序列，模型看到的是「上一次遇到这种问题是这样答的」。

选取是纯词表匹配，没有 embedding，也没有模型调用：

  1. 先过领域闸——范例目前全是语言发展，家长这句话里没有语言/沟通信号就一条
     都不发。否则一个睡眠问题会因为「哭」「不要」这种通用词把语言范例拖进来。
  2. 领域内按各自的特征词排序，取前 N 条。
  3. 领域命中但没有任何特征词匹配时，回退到两条最通用的范例。

词表匹配够用是因为语料只有十几条、且集中在一个话题；等范例扩到睡眠、副食品
之后，把 `select` 换成向量检索即可，模块的其余部分不用动。

范例是繁体，家长可能用简体。语言跟随由 GUARD 单独说明——若不说，模型会连同
字体一起模仿，把简体家长的对话切成繁体。
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Sequence

#: Turn the whole mechanism off without a deploy.
ENABLED = os.getenv("FEWSHOT_EXEMPLARS", "1").lower() not in ("0", "false", "no")

#: How many pairs to inject. Two is a deliberate ceiling: each pair costs ~250
#: prompt tokens every turn, and beyond two the model starts treating them as
#: material to answer from rather than a register to write in.
COUNT = int(os.getenv("FEWSHOT_EXEMPLAR_COUNT", "2"))

#: Hard ceiling on the reply, in characters. The corpus itself runs 112–129, so
#: this is the register's own upper edge rather than a number picked for it.
#: NURI answers as a friend, not as a lecturer: a reply long enough to need
#: scrolling is one the parent does not read.
MAX_CHARS = int(os.getenv("FEWSHOT_MAX_CHARS", "150"))

#: Appended to the system message, and only when a pair actually fires. Says the
#: three things the examples themselves cannot: copy the shape not the content,
#: do not copy the script they happen to be written in, and stop at a length the
#: examples only imply. Measured: the pairs alone halve the median reply but
#: leave a third of turns past 300 characters, because an example is a prior and
#: not a bound.
GUARD = (
    "下面对话里的前几轮是运营团队提供的回复范例，不是这位家长的真实对话。"
    "参考它们的长度、语气和结构——一段话讲清楚一个做法并给出具体例子，"
    f"不分点、不加粗、不列多个问题，整段 text 控制在 {MAX_CHARS} 字以内。"
    "宁可只讲一个最重要的做法，也不要为了讲全而写长；家长看不完的回复等于没有回复。"
    "不要照搬范例里的内容，也不要跟着范例用繁体，文字仍然跟随这位家长自己在用的语言。"
)

#: Characters that exist in only one script, frequent enough that a sentence or
#: two of either contains several. Counting them is enough for the one question
#: being asked — which side is this written in — and needs no conversion table.
_ZHT_ONLY = set("個們這說對時來麼樣覺應點沒開過還給讓歲學習慣媽問題語話講聽動嗎歡邊進體驗經驗發現兒實際輕鬆專對於當")
_ZHS_ONLY = set("个们这说对时来么样觉应点没开过还给让岁学习惯妈问题语话讲听动吗欢边进体验经验发现儿实际轻松专对于当")

#: Below this the message is too short to call, and guessing would be worse than
#: saying nothing — the persona already covers the ordinary case.
_SCRIPT_MIN_SIGNAL = 4


def script_of(text: str) -> str:
    """"zhs", "zht", or "" when the text does not say."""
    zht = sum(1 for c in text or "" if c in _ZHT_ONLY)
    zhs = sum(1 for c in text or "" if c in _ZHS_ONLY)
    if zht + zhs < _SCRIPT_MIN_SIGNAL or zht == zhs:
        return ""
    return "zht" if zht > zhs else "zhs"


_SCRIPT_CLAUSE = {
    "zhs": "这位家长写的是简体中文，所以整段回复必须用简体中文，一个繁体字都不要出现。",
    "zht": "這位家長寫的是繁體中文，所以整段回覆必須用繁體中文。",
}


#: The same ceiling, stated to turns the corpus does not cover. Off by default
#: and kept separate from GUARD because it is a weaker instrument and should be
#: judged as one: GUARD arrives alongside two replies that demonstrate the
#: length, this arrives alone. Sleep and feeding are most of what parents ask
#: about and have no exemplars at all, so measured against `backend/evals/
#: coherence.py --only sleep-flipflop` this is the question of whether a
#: sentence can do what examples do.
GLOBAL_CEILING = os.getenv("FEWSHOT_GLOBAL_CEILING", "0").lower() not in ("0", "false", "no")

CEILING_RULE = (
    f"这一轮没有可参考的回复范例，但长度要求不变：整段 text 控制在 {MAX_CHARS} 字以内，"
    "写成一段话，不分点、不加粗。宁可只讲一个最重要的做法，也不要为了讲全而写长；"
    "家长看不完的回复等于没有回复。"
)


def guard_for(parent_texts: Sequence[str]) -> str:
    """The guard, with the parent's script named outright when it can be read.

    `parent_texts` is newest first, and the newest readable one wins rather than
    all of them pooled. Pooling looked reasonable and was wrong: a parent who
    writes three Traditional messages and then switches to Simplified is still
    majority Traditional in the pool, so the clause instructed Traditional at
    exactly the turn the persona promises to switch. Older messages are only
    consulted when the latest is too short to read — which is the case the
    lookback existed for.

    Measured before any of this: the generic clause above — follow the parent's
    language — held for five turns and then lost, and the sixth reply came back
    wholly Traditional to a parent who had written Simplified throughout. The
    examples are Traditional, and an instruction that never says which side it
    is asking for is weaker than four Traditional messages in the same prompt.
    """
    if isinstance(parent_texts, str):  # tolerate a single message
        parent_texts = [parent_texts]
    script = next((s for s in (script_of(t) for t in parent_texts) if s), "")
    clause = _SCRIPT_CLAUSE.get(script, "")
    return f"{GUARD}{clause}" if clause else GUARD


@dataclass(frozen=True)
class Exemplar:
    """One operator-authored (question, reply) pair.

    `tags` are the patterns that make this exemplar the right one for a turn;
    `quick_replies` and `suggest_tasks` are carried because a few-shot teaches
    the whole object it shows, not just the prose — see `as_messages`.
    """
    id: str
    question: str
    reply: str
    tags: tuple[str, ...] = ()
    quick_replies: tuple[str, ...] = ()
    suggest_tasks: bool = False
    _compiled: list = field(default_factory=list, compare=False, repr=False)

    def score(self, text: str) -> int:
        if not self._compiled:
            self._compiled.extend(re.compile(t) for t in self.tags)
        return sum(1 for pattern in self._compiled if pattern.search(text))


#: Language/communication signal. Written to catch both scripts, the same way
#: the task-intent tables in dialogue_reply.py do.
#:
#: Bare 說/講 is deliberately not on the list — 「醫生說」 appears in every kind of
#: conversation. What is on the list is 說/講 in the shapes a language question
#: actually takes: 只會講、不肯說、講錯、說不出.
_DOMAIN = tuple(
    re.compile(pattern)
    for pattern in (
        r"[語语][言彙汇]|[詞词][彙汇]?|字[彙汇]",
        r"(?:[說说]|[講讲])[話话]|[開开]口|[表表][達达]|[溝沟][通通]",
        r"只(?:[會会])?(?:[說说]|[講讲])|不(?:[會会]|肯|[願愿]意)(?:[說说]|[講讲])",
        r"(?:[說说]|[講讲])(?:[錯错]|不(?:出|清楚)|[得的]?(?:很|太)?短|完)",
        r"[繪绘]本|共[讀读]|念故事|[講讲]故事",
        r"[發发]音|[疊叠][詞词]|[句句][子話话]|把[話话]",
        r"回答|[語语][遲迟]|[遲迟][語语]",
        # Which language, rather than whether. A bilingual household asking
        # 「我們家平常講國語，阿公阿嬤講台語」 is squarely on topic and used to
        # read as off-topic, which shut the gate four turns into a conversation
        # that was about nothing else.
        r"[國国][語语]|台[語语]|客[語语]|英[語语文]|母[語语]|[雙双][語语]|方言",
        # Comprehension and gesture are the other half of communication, and the
        # corpus already answers about both (F on pointing, K on questions).
        r"[聽听][得不]懂|[指指]令|[指指][東东]西|[指指][給给]|比[手手][勢势]",
    )
)

#: Used when the turn is clearly about language but matches no exemplar in
#: particular, and to top a thin match up to `COUNT`. Both are general-purpose
#: answers, so they anchor register without dragging in a specific technique.
_DEFAULT_IDS = ("A", "E")

CORPUS: tuple[Exemplar, ...] = (
    Exemplar(
        id="A",
        question="2 歲半孩子只會講很短，怎麼辦？",
        reply=(
            "2 歲半到 3 歲是孩子開始把單字變成短句的重要階段。你可以先不用急著要求他重複"
            "完整句，而是在他說的話上自然加一點。例如他說「車車」，你可以說「車車開上橋」；"
            "他說「打開門」，你可以說「打開藍色的門」。這種「延伸」會讓孩子聽到更長的句子，"
            "也比較沒有壓力。"
        ),
        tags=(
            r"(?:[講讲]|[說说])[^，。！？]{0,4}(?:很短|太短|短)",
            r"[單单]字|[兩两][個个]字|[疊叠][詞词]",
            r"不[會会](?:[說说]|[講讲])[^，。！？]{0,4}[長长]",
        ),
        quick_replies=("要練多久？", "他還不太肯開口"),
    ),
    Exemplar(
        id="B",
        question="要買什麼玩具幫助語言？",
        reply=(
            "可以選擇開放式玩具，例如積木、動物模型、食物模型、火車軌道或角色扮演玩具。"
            "重點不是玩具有多貴，而是能不能讓孩子創造故事、描述動作、說出需求。像火車軌道"
            "就可以練習「上橋、下橋、進去、出來」，動物模型可以練習「小豬吃草莓」"
            "「小馬去睡覺」。"
        ),
        tags=(
            r"玩具|[積积]木|[買买]什[麼么]|推薦|推荐",
            r"[閃闪][燈灯]|[電电]子玩具|平板|[點点][讀读]",
        ),
        quick_replies=("家裡已經有積木",),
    ),
    Exemplar(
        id="E",
        question="孩子很少主動跟我說話，怎麼辦？",
        reply=(
            "2～3 歲孩子主動開口的頻率差異很大，可以先增加「需要他表達」的機會，而不是一直"
            "問問題。例如孩子想喝水時，可以先拿著水杯等一下，讓他用聲音、手勢或詞語表達需求。"
            "孩子只說「水」，你可以自然接成「我要喝水」。不用要求他跟著重複，讓他多聽幾次"
            "完整又簡單的句子就好。"
        ),
        tags=(
            r"很少[^，。！？]{0,6}(?:[說说]|[講讲])",
            r"不[主主][動动]|[主主][動动][^，。！？]{0,4}(?:[說说]|[講讲])",
            r"不太(?:[說说]|[講讲])|不[愛爱](?:[說说]|[講讲])",
        ),
        quick_replies=("他大部分時間只用手指",),
    ),
    Exemplar(
        id="F",
        question="孩子只會用手指，不願意說出來，要阻止嗎？",
        reply=(
            "不用阻止孩子用手指，手勢本身也是溝通的一部分。比較好的方式是先回應他的意思，"
            "再幫他補上簡單的詞語。例如孩子指著餅乾，可以說「你要餅乾」，再稍微等一下，看他"
            "會不會嘗試發出聲音或說「餅乾」。重點是讓孩子感覺說話能幫助溝通，而不是因為"
            "不說話就拿不到東西。"
        ),
        tags=(
            r"用手指|[手手][勢势]|比[手手]|指[^，。！？]{0,4}(?:要|拿)",
            r"不[願愿]意(?:[說说]|[講讲])|不肯(?:[說说]|[講讲])",
            r"阻止|要不要[糾纠]",
        ),
    ),
    Exemplar(
        id="G",
        question="孩子講錯字，我要一直糾正他嗎？",
        reply=(
            "不用每次都直接糾正，太頻繁可能會讓孩子覺得說話有壓力。可以用自然重述的方式示範"
            "正確說法。例如孩子說「狗狗吃飯飯」，你可以回「對，狗狗在吃飯」。如果孩子把某個音"
            "說錯，也不一定要要求他立刻重說，先讓他願意表達，再慢慢累積正確的語言示範。"
        ),
        tags=(
            r"[糾纠]正|[錯错]字|(?:[說说]|[講讲])[錯错]",
            r"[發发]音[^，。！？]{0,4}(?:不[準准]|[錯错]|奇怪)",
            r"重[說说]|跟[著着][念唸]",
        ),
    ),
    Exemplar(
        id="H",
        question="孩子每次都只回答「不要」，怎麼跟他溝通？",
        reply=(
            "2～3 歲孩子常用「不要」表達自己的自主性，不一定是真的什麼都拒絕。可以把開放式"
            "問題改成簡單的二選一，例如不要問「你要穿什麼？」，而是問「你要穿藍色還是黃色？」。"
            "如果兩個都不要，也可以先接受他的情緒，再告訴他接下來要做什麼，避免一直用問題和"
            "孩子來回拉扯。"
        ),
        tags=(
            r"只(?:[會会])?回答|都[說说]不要|一直[說说]不要",
            r"「?不要」?",
            r"[拒拒][絕绝]",
        ),
        quick_replies=("二選一他也說不要",),
    ),
    Exemplar(
        id="I",
        question="孩子很喜歡重複同一句話，正常嗎？",
        reply=(
            "孩子重複聽過的詞句，有時是在練習聲音、記憶和句型，不一定代表有問題。你可以順著"
            "他的話多加一點內容，例如孩子一直說「車車來了」，你可以接「對，紅色的車車來了」、"
            "「車車開走了」。這樣既不打斷他的表達，也能讓原本固定的句子慢慢延伸出更多變化。"
        ),
        tags=(
            r"重[複复复]|一直(?:[說说]|[講讲])[^，。！？]{0,6}同",
            r"[鸚鹦][鵡鹉]|仿[說说]|[覆复][誦诵]",
        ),
    ),
    Exemplar(
        id="J",
        question="孩子看繪本一下就跑掉，還要繼續讀嗎？",
        reply=(
            "不用要求孩子一定從第一頁坐到最後一頁。這個年紀的共讀可以很短，哪怕一次只有 "
            "3～5 分鐘也可以。孩子喜歡哪一頁就先看哪一頁，也可以讓他翻頁、找動物、指圖片。"
            "比起把故事完整讀完，更重要的是讓孩子覺得繪本和互動、聲音、遊戲連在一起。"
        ),
        tags=(
            r"[繪绘]本|共[讀读]|念[書书]|[講讲]故事",
            r"跑掉|坐不住|不肯[聽听]|翻[頁页]",
        ),
        quick_replies=("他只看同一本",),
    ),
    Exemplar(
        id="K",
        question="孩子不會回答「今天做了什麼」，是不是表達能力不好？",
        reply=(
            "「今天做了什麼」對小小孩來說其實是很大的問題，他需要回想很多事情再組織成句子。"
            "可以把問題縮小，例如問「今天有沒有玩溜滑梯？」、「午餐吃飯還是麵？」。也可以先由"
            "大人提供線索：「我看到你今天畫了一隻小魚。」孩子比較容易接著說下去。"
        ),
        tags=(
            r"今天做了什[麼么]|在[學学]校做|[幼幼][兒儿][園园][^，。！？]{0,6}(?:[說说]|[講讲])",
            r"不[會会]回答|答非所[問问]",
            r"[表表][達达][能力][^，。！？]{0,4}(?:不好|落[後后]|差)",
        ),
    ),
    Exemplar(
        id="L",
        question="孩子一著急就只會哭，不肯說要什麼，怎麼辦？",
        reply=(
            "孩子情緒很強的時候，本來就比較難組織語言。可以先幫他把需求說出來，例如「你想要"
            "那台車，可是現在拿不到，所以很著急」。等情緒稍微穩定後，再教他一句很短、下次能"
            "直接使用的話，例如「幫幫我」、「我要車車」。不要在哭得最厲害的時候要求他完整"
            "說一次才幫忙。"
        ),
        tags=(
            r"[著着]急[^，。！？]{0,6}哭|一[急急]就哭",
            r"哭[^，。！？]{0,6}不(?:[說说]|[講讲])",
            r"不肯[說说]要什[麼么]",
        ),
    ),
    Exemplar(
        id="M",
        question="孩子一直問「這是什麼」，我要每次都回答嗎？",
        reply=(
            "可以回答，但不用每次都只給標準答案。孩子重複問同一個問題，有時是在確認記憶，也"
            "可能只是喜歡和大人互動。你可以偶爾把問題變成對話，例如孩子問「這是什麼？」，你說"
            "「這是消防車，你看它是什麼顏色？」。如果孩子已經知道答案，也可以笑著問「你記得它"
            "叫什麼嗎？」"
        ),
        tags=(
            r"[這这]是什[麼么]|一直[問问]|[問问]不停",
            r"每次都要回答|同[樣样]的[問问][題题]",
        ),
    ),
    Exemplar(
        id="N",
        question="孩子玩玩具的時候不理我，我還要一直跟他說話嗎？",
        reply=(
            "不用一直說。孩子專心玩的時候，大人可以先觀察，再偶爾用一句簡短的話描述他的動作。"
            "例如孩子在疊積木，可以說「你疊得好高」、「紅色放上去了」。留一些安靜的時間讓孩子"
            "自己探索，等他看你、指東西或發出聲音時再回應，通常比不停提問更容易形成自然的"
            "來回互動。"
        ),
        tags=(
            r"不理我|不[理睬回][應应我]|自己玩",
            r"[專专]心玩|玩[^，。！？]{0,6}不理",
            r"要不要一直(?:[說说]|[講讲])",
        ),
    ),
    Exemplar(
        id="O",
        question="孩子只喜歡玩車子，會不會學不到其他詞？",
        reply=(
            "不用急著把車子收起來，孩子喜歡的玩具反而是很好用的語言練習素材。同樣是玩車，"
            "可以加入很多不同詞語，例如「快、慢、停、出發、上去、下來、撞到了」。也可以慢慢"
            "加入人物或動物，讓小熊坐車、小狗修車，把孩子熟悉的玩法延伸成新的情節。"
        ),
        tags=(
            r"只[喜喜][歡欢]玩|只玩|[車车]子|[車车][車车]",
            r"[學学]不到|[會会]不[會会][學学]",
        ),
    ),
    Exemplar(
        id="P",
        question="我問孩子問題，他常常隔很久才回答，要催他嗎？",
        reply=(
            "可以多給孩子幾秒鐘，不用馬上重問或替他回答。孩子可能需要先理解問題，再想詞語和"
            "組織答案。如果剛問完「你想吃香蕉還是蘋果？」，可以安靜等一下。若還是沒有回答，"
            "再把問題縮短成「香蕉？蘋果？」。留出等待時間，也是在告訴孩子「現在輪到你說」。"
        ),
        tags=(
            r"隔[^，。！？]{0,4}久|反[應应]慢|才回答",
            r"催他|要不要催|等多久",
        ),
    ),
    Exemplar(
        id="Q",
        question="孩子說話聲音很小，我要叫他大聲一點嗎？",
        reply=(
            "偶爾提醒可以，但不用每句都要求「大聲一點」。可以先確認孩子是不是只在陌生人或陌生"
            "環境中特別小聲。如果在家也比較小聲，可以透過遊戲練習不同音量，例如玩「小老鼠小聲說、"
            "獅子大聲說」。這樣孩子是在遊戲中感受音量差異，比一直糾正說話聲音更自然。"
        ),
        tags=(
            r"[聲声]音[^，。！？]{0,4}小|小[聲声]|大[聲声][一點一点]?",
            r"[音音][量量]|[陌陌]生人[^，。！？]{0,6}不(?:[說说]|[講讲])",
        ),
    ),
    Exemplar(
        id="R",
        question="孩子喜歡我一直幫他把話說完，這樣好嗎？",
        reply=(
            "偶爾幫忙沒關係，但可以先留一點時間讓孩子自己完成。例如孩子說「我要那個……」，"
            "先等幾秒，看他能不能找到下一個詞。如果他真的卡住，再提供選項：「你要車車還是球？」。"
            "目標不是故意讓孩子說得很辛苦，而是在他需要幫助之前，多留一點自己組織語言的機會。"
        ),
        tags=(
            r"[幫帮][^，。！？]{0,4}(?:[說说]|[講讲])完|替他(?:[說说]|[講讲])",
            r"[猜猜]他要什[麼么]|接[話话]",
        ),
    ),
)

_BY_ID = {e.id: e for e in CORPUS}


def in_domain(text: str) -> bool:
    """Whether the parent's message is about language or communication at all.

    The gate exists because tags like 「不要」 and 「哭」 are ordinary words in a
    sleep or feeding conversation. Without it a bedtime question pulls in a
    語言發展 exemplar and the model answers the wrong question in the right voice.
    """
    return any(pattern.search(text or "") for pattern in _DOMAIN)


#: How many earlier parent messages can hold the gate open. A language
#: conversation is mostly follow-ups — 「所以我到底該不該帶他去做評估？」,
#: 「我們家平常講國語」 — and those carry no keyword at all. Judged one message
#: at a time the gate shuts in the middle of the conversation it should be
#: governing, and the register reverts within the same exchange: measured at
#: 108–119 characters on the turns that fired against 307–578 on the turns
#: between them. Three is short enough that a conversation which has genuinely
#: moved on to sleep stops pulling language examples after a turn or two.
STICKY_TURNS = int(os.getenv("FEWSHOT_STICKY_TURNS", "3"))


def select(user_text: str, limit: int = COUNT, recent: Sequence[str] = ()) -> list[Exemplar]:
    """Pick the exemplars worth showing for this turn. Pure and cheap.

    `recent` is the parent's earlier messages, newest first. It only decides
    whether the gate opens; ranking still leads with what was just said.
    """
    if not ENABLED or limit <= 0:
        return []
    text = " ".join((user_text or "").strip().split())
    if not text:
        return []
    if not in_domain(text):
        prior = next((t for t in list(recent)[:STICKY_TURNS] if in_domain(t or "")), "")
        if not prior:
            return []
        # Scored against both, so a keyword-free follow-up still ranks on the
        # scenario the parent actually raised.
        text = f"{prior} {text}"
    scored = [(e.score(text), i, e) for i, e in enumerate(CORPUS)]
    hits = sorted(
        (s for s in scored if s[0] > 0),
        # Best match first; ties keep corpus order, which is the order the
        # operator authored them in.
        key=lambda s: (-s[0], s[1]),
    )
    chosen = [e for _, _, e in hits[:limit]]
    # One exemplar shifts the register less reliably than two, so a thin match
    # is topped up rather than sent short. The fillers are in-domain by
    # construction, which is why this is safe here and would not be off-domain.
    for fid in _DEFAULT_IDS:
        if len(chosen) >= limit:
            break
        if _BY_ID[fid] not in chosen:
            chosen.append(_BY_ID[fid])
    return chosen


def as_messages(chosen: Sequence[Exemplar]) -> list[dict]:
    """Render pairs into the message list, oldest-looking first.

    The assistant side is serialised JSON rather than bare prose because the
    reply is produced under NURI_RESPONSE_FORMAT: an example whose shape differs
    from the required output shape teaches the model two conflicting things at
    once. It also means every field is being taught, not just `text` — which is
    why `suggest_tasks` is false throughout. These are all conclusion-stage
    answers, and a conclusion that arrives with task cards attached is exactly
    what the examples are meant to stop.
    """
    msgs: list[dict] = []
    for e in chosen:
        msgs.append({"role": "user", "content": e.question})
        msgs.append({
            "role": "assistant",
            "content": json.dumps(
                {
                    "text": e.reply,
                    "quick_replies": list(e.quick_replies),
                    "suggest_tasks": e.suggest_tasks,
                    "task_proposals": [],
                    "cited": [],
                },
                ensure_ascii=False,
            ),
        })
    return msgs
