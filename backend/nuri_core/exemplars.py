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

语域取自 0625小雪對話 那份真人测试记录：十二个 NURI 回合，中位五个短段落，
75% 以问句收尾，每一条都先回应家长刚说的话，靠一两个 emoji 带温度。第一版
语料是一段话、零问句、零 emoji、直接从事实开讲——四条共情规则当时还开着，
照样被十六条没有共情的范例盖过去，回复就变得又短又冷。范例强于规则，这既是
这套机制的前提，也是它第一次反噬的地方。
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

#: Hard ceiling on the reply, in characters. NURI answers as a friend, not as a
#: lecturer: a reply long enough to need scrolling is one the parent does not
#: read.
#:
#: The corpus fits inside it while still opening with an acknowledgement and
#: closing on a question, which is the thing worth knowing here — brevity and
#: warmth were never the trade-off they looked like. The real transcript runs
#: longer at the median because its advisory turns do; its opening turns, which
#: are the shape being copied, land around 110.
MAX_CHARS = int(os.getenv("FEWSHOT_MAX_CHARS", "150"))

#: Appended to the system message, and only when a pair actually fires. Says the
#: three things the examples themselves cannot: copy the shape not the content,
#: do not copy the script they happen to be written in, and stop at a length the
#: examples only imply. Measured: the pairs alone halve the median reply but
#: leave a third of turns past 300 characters, because an example is a prior and
#: not a bound.
GUARD = (
    "下面对话里的前几轮是运营团队提供的回复范例，不是这位家长的真实对话。"
    "参考它们的长度、语气和结构，照着这三步写：\n"
    "1. 先接住家长刚说的这句话——具体到只有他适用，不要「你做得很好」这种套话；\n"
    "2. 给一个可以马上试的做法，带一个具体例子；\n"
    "3. 用一个开放式问句收尾，让他愿意接着说。\n"
    "分成两到四个短句，句子之间换行；不要编号、不要加粗、不要一次问好几个问题——"
    "问一个就好，但一定要问。可以用一两个 emoji 表达温度，不要当装饰堆在每一句。"
    f"整段 text 控制在 {MAX_CHARS} 字以内；宁可只讲一个最重要的做法，也不要为了讲全而写长。"
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


#: The same ceiling, stated to turns the corpus does not cover — sleep, feeding,
#: emotions, which are most of what parents ask about and have no exemplars at
#: all. Kept separate from GUARD because it is the weaker instrument and had to
#: be judged as one: GUARD arrives alongside two replies that demonstrate the
#: length, this arrives alone.
#:
#: On by default since it was measured with the five list-and-multi-question
#: style rules deactivated, which is the state production is now in. Those rows
#: took the median reply from 496 to 190 characters on their own but left the
#: tail — 9 of 18 replies still over the ceiling, 8 still bulleted. This closes
#: it: 0 of 18 over, none bulleted, median 88, and the replies read whole rather
#: than clipped. Set FEWSHOT_GLOBAL_CEILING=0 to take it back out.
GLOBAL_CEILING = os.getenv("FEWSHOT_GLOBAL_CEILING", "1").lower() not in ("0", "false", "no")

CEILING_RULE = (
    "这一轮没有可参考的回复范例，但写法不变：先接住家长刚说的这句话，"
    "再给一个可以马上试的做法，最后用一个开放式问句收尾。"
    "分成两到四个短句，句子之间换行；不要编号、不要加粗、不要一次问好几个问题——"
    "问一个就好，但一定要问。"
    f"整段 text 控制在 {MAX_CHARS} 字以内；宁可只讲一个最重要的做法，也不要为了讲全而写长。"
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
            "聽起來你有在仔細留意他說了什麼，這其實很不容易。😊\n"
            "2 歲半到 3 歲正是把單字變成短句的階段，你可以不用急著要他重複完整句，而是在他說的話上自然加一點——他說「車車」，你就接「車車開上橋」。\n"
            "他最近最常說的是哪幾個詞呢？"
        ),
        tags=(
            r"(?:[講讲]|[說说])[^，。！？]{0,4}(?:很短|太短|短)",
            r"[單单]字|[兩两][個个]字|[疊叠][詞词]",
            r"不[會会](?:[說说]|[講讲])[^，。！？]{0,4}[長长]",
        ),
        quick_replies=("大概十幾個詞", "他不太肯開口"),

    ),
    Exemplar(
        id="B",
        question="要買什麼玩具幫助語言？",
        reply=(
            "會想到用玩具幫忙，代表你很願意陪他一起玩。💛\n"
            "重點不是玩具多貴，而是能不能讓他創造故事、說出需求。像火車軌道可以練「上橋、下橋、進去、出來」，動物模型可以練「小豬吃草莓」。\n"
            "他現在最喜歡玩什麼呢？"
        ),
        tags=(
            r"玩具|[積积]木|[買买]什[麼么]|推薦|推荐",
            r"[閃闪][燈灯]|[電电]子玩具|平板|[點点][讀读]",
        ),
        quick_replies=("最愛車子", "家裡已經有積木"),

    ),
    Exemplar(
        id="E",
        question="孩子很少主動跟我說話，怎麼辦？",
        reply=(
            "他不太主動開口，你心裡一定有點著急吧。😊\n"
            "可以先增加「需要他表達」的機會，而不是一直問問題。像他想喝水時，先拿著水杯等一下，讓他用聲音或手勢表達；他說「水」，你就接成「我要喝水」。\n"
            "他平常想要東西的時候，通常會怎麼讓你知道呢？"
        ),
        tags=(
            r"很少[^，。！？]{0,6}(?:[說说]|[講讲])",
            r"不[主主][動动]|[主主][動动][^，。！？]{0,4}(?:[說说]|[講讲])",
            r"不太(?:[說说]|[講讲])|不[愛爱](?:[說说]|[講讲])",
        ),
        quick_replies=("都用手指",),

    ),
    Exemplar(
        id="F",
        question="孩子只會用手指，不願意說出來，要阻止嗎？",
        reply=(
            "你會注意到他用手指，代表你很在意他想說什麼。💛\n"
            "手勢本身就是溝通的一部分，不用阻止。比較好的做法是先回應他的意思，再幫他補上詞語——他指著餅乾，你就說「你要餅乾」，再稍微等一下。\n"
            "他指東西的時候，會看著你的眼睛嗎？"
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
            "會猶豫要不要糾正，表示你很怕給他壓力。😊\n"
            "不用每次都直接糾正，可以用自然重述示範正確說法——他說「狗狗吃飯飯」，你就回「對，狗狗在吃飯」。先讓他願意表達，再慢慢累積正確的示範。\n"
            "他被糾正的時候，會不會就不想說了呢？"
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
            "一直被回「不要」，你大概也覺得有點無力吧。😄\n"
            "2～3 歲常用「不要」表達自主性，不一定是真的拒絕。可以把開放式問題換成二選一——不問「你要穿什麼」，而是問「你要穿藍色還是黃色」。\n"
            "他是所有事情都說不要，還是某些時候特別明顯呢？"
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
            "你注意到他重複同一句話，觀察得很細。💛\n"
            "孩子重複聽過的詞句，常常是在練習聲音、記憶和句型。你可以順著他的話多加一點——他一直說「車車來了」，你就接「紅色的車車來了」「車車開走了」。\n"
            "他最常重複的是哪一句呢？"
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
            "他一下就跑掉，你還願意繼續讀，這件事本身就很好。😊\n"
            "這個年紀的共讀可以很短，一次 3～5 分鐘也可以。他喜歡哪一頁就先看哪一頁，也可以讓他翻頁、找動物、指圖片，重點是讓他覺得繪本和互動連在一起。\n"
            "他平常會對書裡的哪些東西有反應呢？"
        ),
        tags=(
            r"[繪绘]本|共[讀读]|念[書书]|[講讲]故事",
            r"跑掉|坐不住|不肯[聽听]|翻[頁页]",
        ),
        quick_replies=("只看同一本",),

    ),
    Exemplar(
        id="K",
        question="孩子不會回答「今天做了什麼」，是不是表達能力不好？",
        reply=(
            "會擔心他的表達能力，是因為你很認真在聽他說。💛\n"
            "「今天做了什麼」對小小孩其實是很大的問題，他要回想很多事再組織成句子。可以把問題縮小，例如問「今天有沒有玩溜滑梯」「午餐吃飯還是麵」。\n"
            "換成小問題以後，他會願意多說一點嗎？"
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
            "看他哭得那麼急，你一定也跟著著急。💛\n"
            "情緒很強的時候本來就比較難組織語言。可以先幫他把需求說出來——「你想要那台車，可是拿不到，所以很著急」。等他穩定一點，再教他一句「幫幫我」。\n"
            "他著急的時候，抱一下會比較快平靜嗎？"
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
            "他一直問，代表他很信任你會回答他。😊\n"
            "重複問同一個問題，有時是在確認記憶，也可能只是喜歡跟你互動。你可以偶爾把問題變成對話——他問「這是什麼」，你就說「這是消防車，你看它是什麼顏色」。\n"
            "他問的時候，是真的不知道，還是已經知道答案了呢？"
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
            "你會想陪他說話，這份心意他一定感覺得到。💛\n"
            "孩子專心玩的時候，大人可以先觀察，再偶爾用一句話描述他的動作——他在疊積木，你就說「你疊得好高」。留一些安靜時間，等他看你或發出聲音再回應。\n"
            "他玩的時候，會不會偶爾抬頭找你呢？"
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
            "你會擔心他只玩車子，但這其實是件好事。😊\n"
            "喜歡的玩具反而是很好用的語言素材。同樣玩車，可以加入「快、慢、停、出發、撞到了」，也可以慢慢加入人物，讓小熊坐車、小狗修車，把玩法延伸出新情節。\n"
            "他玩車的時候，會自己配音或說話嗎？"
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
            "你願意等他回答，這對他來說很重要。💛\n"
            "孩子需要時間理解問題、再想詞語組織答案，可以多給他幾秒鐘，不用馬上重問或替他回答。如果還是沒回答，再把問題縮短成「香蕉？蘋果？」。\n"
            "你通常會等他多久呢？"
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
            "你注意到他聲音的變化，觀察得很仔細。😊\n"
            "可以先看看他是不是只在陌生環境特別小聲。如果在家也一樣，可以用遊戲練習音量，像玩「小老鼠小聲說、獅子大聲說」，比一直提醒「大聲一點」自然得多。\n"
            "他在家跟在外面，差別大嗎？"
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
            "你會停下來想這樣好不好，已經很不容易了。💛\n"
            "偶爾幫忙沒關係，但可以先留一點時間讓他自己完成——他說「我要那個……」，先等幾秒看他能不能找到下一個詞，真的卡住再給選項：「你要車車還是球？」。\n"
            "他卡住的時候，會有什麼表情或動作嗎？"
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
