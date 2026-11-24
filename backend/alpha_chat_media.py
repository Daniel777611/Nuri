"""Bounded, provider-backed resources for an explicit Alpha chat request."""

from __future__ import annotations

import asyncio
import re
import unicodedata
from dataclasses import dataclass, replace
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urljoin, urlsplit, urlunsplit

import httpx

from . import alpha_milestones
from .content_research import redact_conversation_text
from .feed.daily_video import thumbnail_url, video_id_of, watch_url
from .nuri_core.family_store import redact_child_profile_text
from .websearch import SearchImage, SearchRequest, SearchResult, get_provider

_REQUEST = re.compile(
    r"\b(?:find|share|send|show|recommend|suggest|give|link|need|want|where|any|looking for)\b"
    r"|有没有|有沒有|可以|能不能|给我|給我|推荐|推薦|发我|發我|分享|链接|連結|鏈接|看看|"
    r"(?:^|[，。])找|帮我找|幫我找|想看|想找|要看|[?？]",
    re.I,
)
_MEDIA = {
    "video": re.compile(r"\b(?:youtube|videos?|clips?)\b|视频|影片|視訊|錄影|录像", re.I | re.ASCII),
    "article": re.compile(r"\b(?:articles?|papers?|studies|reading materials?|sources?|references?|external resources?|webpages?)\b|文章|资料|資料|网页|網頁|来源|來源|文献|文獻|参考链接|參考連結", re.I),
    "image": re.compile(r"\b(?:images?|pictures?|photos?|thumbnails?|diagrams?|illustrations?)\b|图片|圖片|照片|示意图|示意圖|图解|圖解|插图|插圖|缩略图|縮圖", re.I),
}
_LINK_REQUEST = re.compile(
    r"\b(?:(?:where|what)(?:['’]s|\s+(?:is|are))\b.{0,45}\b(?:links?|urls?)|"
    r"(?:send|show|give|share|find|need|want|looking for|please|have|can|could)\b.{0,75}\b(?:links?|urls?)|"
    r"(?:links?|urls?)\s*(?:please|\?|$))"
    r"|(?:[要给給发發传傳找贴貼求]|[分享]).{0,28}(?:链接|連結|鏈接|网址|網址)"
    r"|(?:链接|連結|鏈接|网址|網址).{0,12}(?:在哪|呢|[吗嗎]|[?？])",
    re.I,
)
_NON_RESOURCE_LINK = re.compile(
    r"\b(?:password reset|reset password|sign[ -]?in|log[ -]?in|account activation|"
    r"connect (?:my|an?) account|link (?:my|an?) account|invite link)\b"
    r"|密码|密碼|绑定|綁定|邀请[链鏈連]|邀請[链鏈連]|验证码|驗證碼|登[录錄入]", re.I,
)
_LINK_ONLY = re.compile(
    r"\b(?:where['’]s|what['’]s|please|can|could|you|send|show|give|find|want|need|share|have|me|where|is|are|the|a|an|some|"
    r"here|any|that|these|those|it|this|real|actual|direct|clickable|what|for|to|of|previous|above|"
    r"earlier|just|my|your|again|instead|thanks|looking|link|links|url|urls|not|search|searching|"
    r"google|keywords?)\b"
    r"|(?:那你|那|我[要想]|我要的是|要的是|之前|剛才|刚才|上面|这些|這些|"
    r"直接|可以|麻烦|麻煩|请|請|一下|给我|給我|发给|發給|发我|發我|发|發|给|給|"
    r"在(?:哪里|哪裡|哪儿)|哪里|哪裡|在哪|在這|在这|哪儿|你|我|的|呢|吗|嗎|呀|啊|把|就|能|了|是|"
    r"能点|能點|可点|可點|可以点开|可以點開|点开|點開|真实|真實|实际|實際|"
    r"链接|連結|鏈接|网址|網址|一[个個]|几[个個]|幾[个個]|[和与與])",
    re.I,
)
_FOLLOW_UP_CHALLENGE = re.compile(
    r"^(?:我(?:就)?(?:要|想要)的[是就]|不是.+(?:而是|是)|都说了|都說了).{0,24}"
    r"(?:链接|連結|鏈接|网址|網址)"
    r"|^\s*i (?:asked|was asking) for (?:a |the )?(?:link|url)", re.I,
)
_CREDENTIAL = re.compile(r"(?:token|secret|password|authorization|credential|api[_-]?key|session|signature|^sig$|^jwt$)", re.I)
_SAFE_PATH = re.compile(r"\.(?:jpe?g|png|webp|avif|gif)$", re.I)
_DECORATION = re.compile(r"(?:avatar|favicon|\blogo\b|\bicon\b|profile picture)", re.I)
_PRIVATE_TEXT = re.compile(
    r"\[(?:邮箱|电话|编号|链接|名字|地址|address|name|school)\]|https?://|"
    r"\b(?:my (?:address|phone|email|name)|(?:diagnosed|diagnosis) (?:with|is)|medical record|password)\b|"
    r"家庭地址|我的(?:姓名|地址|電話|电话)|确诊|確診", re.I,
)
_SHORT_REFERENCE = re.compile(
    r"^(?:(?:find|share|send|show|recommend|suggest|give|me|a|some|any|please|can|could|you|on|"
    r"tutorials?|the|this|that|these|those|about|it|to|of|look|for|with|help|do|have|is|there|links?|examples?|more)\b|"
    r"有沒有|有没有|有|給我|给我|能不能|可以|有什麼|有什么|推薦|推荐|找|看看|分享|教學|教学|教程|"
    r"這個|这个|這方面|这方面|那些|剛才|刚才|上面|一個|一个|幾個|几个|一些|一下|發我|发我|發|发|链接|連結|鏈接|的|啊|呀|嗎|吗|[\W_])+?$",
    re.I,
)
_ARTICLE_DOMAINS = (
    "healthychildren.org", "kidshealth.org", "nhs.uk", "cdc.gov", "nih.gov", "who.int",
    "unicef.org", "zerotothree.org", "childmind.org", "raisingchildren.net.au", "parenting.com.tw",
    "aap.org", "fhs.gov.hk", "hpa.gov.tw", "mohw.gov.tw", "ntuh.gov.tw", "hch.gov.tw",
    "developingchild.harvard.edu", "chop.edu", "seattlechildrens.org", "asha.org",
)
_MEDICAL_TEXT = re.compile(
    r"\b(?:emergency|medical|diagnos\w*|medication|dosage|overdose|seizure|fever|choking|bleeding)\b"
    r"|急救|急诊|急診|窒息|中毒|抽搐|剂量|劑量|服药|服藥|发烧|發燒|出血", re.I,
)
_MAX_ITEMS = 6


@dataclass(frozen=True)
class _VideoTopic:
    english: str
    simplified: str
    traditional: str
    terms: re.Pattern[str]

    def query(self, locale: str) -> str:
        if locale == "zh-TW":
            return self.traditional
        return self.simplified if locale.startswith("zh") else self.english


# Keep outbound video requests to known public educational subjects. The topic
# detector can read the current message locally without sending it to YouTube
# search. English and both Chinese locales use the same relevance criteria.
_SPEECH_VIDEO_TOPIC = _VideoTopic(
    "child speech and language development toddler first words parent tips",
    "幼儿语言发育 宝宝学说话 亲子互动",
    "幼兒語言發展 寶寶學說話 親子互動",
    re.compile(
        r"\blanguage (?:development|milestones?|learning|stimulation|skills)\b"
        r"|\bspeech (?:and language|language|development|milestones?|stimulation|skills|therapy)\b"
        r"|\bfirst words?\b|\b(?:help|teach|encourage)(?:ing)?\b.{0,45}\b(?:talk|speak|talking|speaking)\b"
        r"|\b(?:learn|learning|start|starting)(?: to)? (?:talk|speak|talking|speaking)\b"
        r"|(?:[语語][言音]|[说說][话話]|[开開]口|口[语語])(?:[发發][育展]|[启啟][蒙发發]|培[养養]|引[导導]|[训訓]練|里程碑|能力|[练練]習)"
        r"|[语語]言(?:表[达達]|能力|刺激|理解)|[学學][说說講讲][话話]|教.{0,12}[说說講讲][话話]"
        r"|[说說][话話](?:技巧|[训练訓練])|[开開]口[说說][话話]|[说說]出第一[个個][词詞]|幼[儿兒][语語]言|[语語]言[学习學習]", re.I,
    ),
)
_PICKY_EATING_TOPIC = _VideoTopic(
    "picky eating feeding toddlers children family mealtime parent tips",
    "宝宝挑食 幼儿不爱吃饭 家长应对",
    "寶寶挑食 幼兒不愛吃飯 家長應對",
    re.compile(
        r"\b(?:picky eat(?:ers?|ing)|fussy eat(?:ers?|ing)|food refusal)\b|"
        r"挑食|偏食|[厌厭]食|不[爱愛]吃[饭飯]|吐食|[饭飯]菜吐出", re.I,
    ),
)
_MEALTIME_TOPIC = _VideoTopic(
    "toddler mealtime feeding one year old toddler meal ideas routines",
    "一岁幼儿饮食 三餐 吃饭 家长",
    "一歲幼兒飲食 三餐 吃飯 家長",
    re.compile(
        r"\b(?:toddler (?:meals?|feeding|nutrition|food)|mealtimes?|meals for toddlers)\b"
        r"|(?:一[岁歲]|1[岁歲]|幼[儿兒]|[婴嬰]幼[儿兒]|[0-9]+[个個]月)(?:的)?(?:[饮飲]食|[餵喂][养養]|三餐|吃[饭飯])"
        r"|一日三餐|健康[饮飲]食|孩子[学學]吃[饭飯]|用餐常[规規]", re.I,
    ),
)
_MILESTONE_TOPIC = _VideoTopic(
    "child developmental milestones age appropriate examples CDC",
    "儿童发育里程碑 月龄 实拍示例",
    "兒童發展里程碑 月齡 實拍示例",
    re.compile(
        r"\b(?:developmental (?:milestones?|stages?)|milestones in action|child(?:hood)? development stages?|"
        r"learn the signs[.,]? act early|age.specific milestones?|milestones? (?:by|at) age|"
        r"(?:critical|sensitive) periods? (?:of|in) (?:early )?child(?:hood)? development)\b"
        r"|(?:[发發][育展]|成[长長]|[发發]達)(?:里程碑|[关關][键鍵]期|重要[阶階]段|[阶階]段)"
        r"|[发發]育指[标標]|[长長]到什[么麼]阶段", re.I,
    ),
)
_MILESTONE_SEARCH = re.compile(
    r"\b(?:find|search|look up|share|send|show|recommend)\b|(?:^|[，。])(?:查找?|搜索?|找)|"
    r"[帮幫]我[查搜找]|(?:查|搜|找)(?:一下|一[查搜找]|找)|[推荐推薦]{2}|哪[里裡]能[看查]",
    re.I,
)
_MILESTONE_CLINICAL = re.compile(
    r"\b(?:delay(?:ed|s)?|regress(?:ion|ing)?|autism|diagnos\w*|screen(?:ing)?|treat(?:ment)?|"
    r"red flags?|lost skills|is (?:it|this|that) normal)\b"
    r"|[迟遲][缓緩滞滯]|落[后後]|异常|異常|自[闭閉]|孤[独獨]症|倒退|退步|"
    r"[筛篩]查|是不是正常|是否正常|不正常|[诊診][断斷]|治疗|治療",
    re.I,
)
_VIDEO_TOPICS = (
    _SPEECH_VIDEO_TOPIC,
    _VideoTopic(
        "baby chicken puree introducing solids preparation for parents",
        "婴儿鸡肉泥 辅食 制作方法",
        "嬰兒雞肉泥 副食品 製作方法",
        re.compile(r"\bchicken\b.{0,18}\bpur[ée]e\b|[鸡雞]肉泥|[鸡雞]蓉", re.I),
    ),
    _VideoTopic(
        "starting solids for babies infant complementary feeding parent guide",
        "宝宝辅食添加 婴儿第一口辅食 家长教程",
        "寶寶副食品入門 嬰兒開始吃副食品 家長教學",
        re.compile(
            r"\b(?:start(?:ing)?|introduc(?:e|ing)|first) (?:solid foods?|solids)\b"
            r"|\b(?:baby[- ]led weaning|complementary feeding|infant feeding)\b"
            r"|(?:[辅輔]食|副食品)(?:添加|入[门門]|起步|製作|制作)|(?:[辅輔]食|副食品)"
            r"|第一口(?:[辅輔]食|副食品)", re.I,
        ),
    ),
    _VideoTopic(
        "baby toddler sleep bedtime routine parent guide",
        "婴幼儿睡眠 宝宝入睡 睡前流程",
        "嬰幼兒睡眠 寶寶入睡 睡前流程",
        re.compile(
            r"\b(?:sleep (?:regressions?|training|routines?|tips|schedules?)|bedtime routines?|"
            r"(?:baby|infant|toddler|children'?s) sleep|sleeping through the night)\b"
            r"|睡眠倒退|睡前(?:[仪儀]式|流程|[习習][惯慣])|哄睡|夜醒|[婴嬰]幼[儿兒]睡眠|(?:宝宝|寶寶)(?:睡眠|入睡)", re.I,
        ),
    ),
    _VideoTopic(
        "toddler tantrums emotion regulation calm parent strategies",
        "幼儿发脾气 情绪调节 家长应对",
        "幼兒發脾氣 情緒調節 家長應對",
        re.compile(
            r"\b(?:tantrums?|child emotional regulation|emotion regulation|managing big feelings|emotional outbursts?)\b"
            r"|[发發]脾[气氣]|情[绪緒](?:崩[溃潰]|[调調][节節]|管理)|哭[闹鬧]|孩子生[气氣]", re.I,
        ),
    ),
    _VideoTopic(
        "toddler potty training toilet learning parent guide",
        "幼儿如厕训练 宝宝戒尿布 家长指南",
        "幼兒如廁訓練 寶寶戒尿布 家長指南",
        re.compile(
            r"\b(?:potty training|toilet training|toilet learning)\b|如[厕廁]|戒尿布|便盆[训訓]練|上[厕廁]所[训訓]練", re.I,
        ),
    ),
    _PICKY_EATING_TOPIC,
    _MEALTIME_TOPIC,
    _VideoTopic(
        "child separation anxiety preschool transitions parent guide",
        "幼儿分离焦虑 入园适应 家长指南",
        "幼兒分離焦慮 入園適應 家長指南",
        re.compile(r"\b(?:separation anxiety|preschool drop[- ]off)\b|分[离離]焦[虑慮]|入[园園][适適][应應]", re.I),
    ),
    _VideoTopic(
        "baby tummy time crawling gross motor development parent guide",
        "宝宝趴卧 爬行 大运动发展 家长指南",
        "寶寶趴臥 爬行 大肌肉動作發展 家長指南",
        re.compile(r"\b(?:tummy time|baby crawl(?:ing|s)?|gross motor development)\b|趴[卧臥]|[婴嬰][儿兒]爬行|宝宝爬行|寶寶爬行|大[运運]动[发發]展|大肌肉[动動]作", re.I),
    ),
    _VideoTopic(
        "change a diaper baby diaper changing parent demonstration",
        "婴儿更换尿布 宝宝换纸尿裤 示范",
        "嬰兒更換尿布 寶寶換尿片 示範",
        re.compile(r"\b(?:diaper chang(?:e|es|ing)|chang(?:e|ing) (?:a |the )?(?:diapers?|napp(?:y|ies)))\b|(?:[换換]|更[换換])(?:[纸紙])?尿(?:布|片|[裤褲])|尿布(?:替[换換]|更[换換])", re.I),
    ),
    _VideoTopic(
        "baby carrier fitting babywearing safe positioning parent demonstration",
        "婴儿背带 穿戴 背娃 示范",
        "嬰兒背帶 穿戴 背巾 示範",
        re.compile(r"\b(?:baby carriers?|babywearing|baby wraps?|infant carriers?)\b|(?:[婴嬰][儿兒]|寶寶|宝宝)背[带帶]|背[带帶][穿用]戴|[婴嬰][儿兒]背巾|背娃", re.I),
    ),
    _VideoTopic(
        "how to bathe a newborn baby bath parent demonstration",
        "新生儿洗澡 婴儿沐浴 教程",
        "新生兒洗澡 嬰兒沐浴 教學",
        re.compile(r"\b(?:baby bath(?:ing)?|newborn bath(?:ing)?|bathe (?:a |an |your )?(?:newborn|baby|infant))\b|(?:[婴嬰][儿兒]|新生[儿兒]|寶寶|宝宝)(?:洗澡|沐浴)|[给給](?:宝宝|寶寶|[婴嬰][儿兒])洗澡", re.I),
    ),
    _VideoTopic(
        "child car seat installation harness fitting parent demonstration",
        "儿童汽车安全座椅 安装 安全带",
        "兒童汽車安全座椅 安裝 安全帶",
        re.compile(r"\b(?:car seats?|booster seats?|rear[- ]facing|child passenger safety)\b|(?:(?:儿童|兒童|汽[车車])(?:汽[车車])?)?安全座椅|后向座椅|後向座椅", re.I),
    ),
    _VideoTopic(
        "breastfeeding latch positions baby feeding parent guide",
        "母乳喂养 哺乳姿势 含乳示范",
        "母乳哺餵 哺乳姿勢 含乳示範",
        re.compile(r"\b(?:breastfeeding|breast feeding|breastfeed|nursing positions?|latching on)\b|母乳(?:喂[养養]|哺[餵喂])|哺乳|含乳", re.I),
    ),
    _VideoTopic(
        "baby bottle feeding paced feeding infant formula preparation parent guide",
        "婴儿奶瓶喂养 节奏喂奶 冲调配方奶",
        "嬰兒奶瓶餵養 節奏餵奶 沖泡配方奶",
        re.compile(r"\b(?:bottle[- ]feeding|paced feeding|formula preparation|prepar(?:e|ing) infant formula)\b|奶瓶(?:喂[养養]|[餵喂]奶)|[冲沖](?:泡|[调調])(?:配方)?奶|[节節]奏[喂餵]奶", re.I),
    ),
    _MILESTONE_TOPIC,
)
_CHILD_VIDEO = re.compile(
    r"\b(?:bab(?:y|ies)|toddler(?:s)?|child(?:ren|hood)?|infant(?:s)?|newborn(?:s)?|kids?|preschool(?:ers?)?|parent(?:ing|s)?"
    r"|(?:one|two|three|1|2|3)[ -]year[ -]olds?)\b|寶寶|宝宝|[嬰婴][兒儿]|幼[兒儿]|孩[子童]|小孩|小朋友|親子|亲子|育[兒儿]|月[龄齡]|早教",
    re.I,
)
_OFF_TOPIC_VIDEO = re.compile(
    r"\b(?:large language models?|llms?|language models?|chatgpt|openai|deepseek|generative ai|ai models?|"
    r"machine learning|prompt engineering|stock trading|short straddle|straddles?|options trading|crypto(?:currency)?|"
    r"forex|financial markets?)\b"
    r"|大(?:[语語]言)?模型|人工智能|人工智慧|生成式.{0,3}AI|模型(?:[训訓]練|训练)|股[市票]|期[权權]|加密[货貨][币幣]|交易策略",
    re.I,
)


_EXPLICIT_ZH_VIDEO = re.compile(
    r"\b(?:only|just) (?:in )?(?:chinese|mandarin)\b|\b(?:chinese|mandarin)[ -]only\b"
    r"|\b(?:in chinese|mandarin chinese|chinese[- ]language|(?:chinese|mandarin) videos?)\b|中文(?:的|語音|语音|配音|解說|解说|[视視]頻|视频|影片)"
    r"|(?<!不)(?:只[要給给]|要|找|看)[\s]*(?:中文|普通[话話]|[国國][语語]|[华華][语語])|不要英文",
    re.I,
)
_EXPLICIT_EN_VIDEO = re.compile(
    r"\b(?:in english|english[ -]only|english-language)\b|(?<!不)(?:要|找|只看)英文|不要中文|英文(?:的视频|的影片|視頻|视频|影片)",
    re.I,
)
_HAN_TEXT = re.compile(r"[㐀-鿿]")
# Each ID was checked against YouTube's public metadata and the named
# institution's public educational video page. No treatment videos are here.
_SPEECH_VIDEO_RESOURCES = {
    "zh": (
        ("如何協助孩子語言發展", "K2tgEp7iTdU",
         "https://www.hch.gov.tw/?aid=627&iid=241&page_name=detail&pid=0"),
    ),
    "en": (
        ("5 Steps for Brain-Building Serve and Return · Harvard", "KNrnZag17Ek",
         "https://developingchild.harvard.edu/resources/videos/how-to-5-steps-for-brain-building-serve-and-return/"),
        ("Through the Eyes of a Child (ages 1–2) · Communication Trust", "-zA3zK0g5ic",
         "https://www.cpft.nhs.uk/speech-and-language-therapy-late-talkers/"),
    ),
}


# Source pages and YouTube oEmbed metadata were both checked. These are
# public parenting overviews, never individual medical recommendations.
_PICKY_VIDEO_RESOURCES = {
    "zh": (
        ("正向教養影片第五篇：孩子學吃飯", "W9LxMa7jRoM",
         "https://mohw.gov.tw/ss/cp-7423-51023-204.html"),
        ("解決孩子偏挑食、不愛吃飯等問題", "fLH9JRiRha0",
         "https://class.tn.edu.tw/modules/tad_web/video.php?VideoID=20527&WebID=13851"),
    ),
    "en": (
        ("Tips for Feeding Picky Eaters · AAP", "s1KvNv4Jxqw",
         "https://www.cdc.gov/nutrition/features/help-picky-eater.html"),
    ),
}
_MEALTIME_VIDEO_RESOURCES = {
    "zh": (
        ("正向教養影片第五篇：孩子學吃飯", "W9LxMa7jRoM",
         "https://mohw.gov.tw/ss/cp-7423-51023-204.html"),
        ("6至24個月嬰幼兒健康飲食：引導孩子好好吃飯（粵語）", "ji8nZNsbYmA",
         "https://www.fhs.gov.hk/tc_chi/mulit_med/000043_p2.html"),
    ),
    "en": _PICKY_VIDEO_RESOURCES["en"],
}
_REVIEWED_VIDEOS = {
    _SPEECH_VIDEO_TOPIC: _SPEECH_VIDEO_RESOURCES,
    _PICKY_EATING_TOPIC: _PICKY_VIDEO_RESOURCES,
    _MEALTIME_TOPIC: _MEALTIME_VIDEO_RESOURCES,
}
_PICKY_ARTICLE = SearchResult(
    "Tips to Help Your Picky Eater · CDC",
    "https://www.cdc.gov/nutrition/features/help-picky-eater.html",
    images=(SearchImage("https://www.cdc.gov/nutrition/media/images/Pickyeater.jpg"),),
)
_REVIEWED_ARTICLES = {
    _PICKY_EATING_TOPIC: (
        SearchResult("孩子「偏食」怎么办？ · 香港卫生署", "https://www.fhs.gov.hk/sc_chi/health_info/child/20033.html", lang="zh"),
        SearchResult("孩子「偏食」怎麼辦？ · 香港衞生署", "https://www.fhs.gov.hk/tc_chi/health_info/child/20033.html", lang="zh"),
        _PICKY_ARTICLE,
    ),
    _MEALTIME_TOPIC: (
        SearchResult("一至两岁幼儿健康饮食 · 香港卫生署", "https://www.fhs.gov.hk/sc_chi/health_info/child/16301.html", lang="zh"),
        SearchResult("一至兩歲幼兒健康飲食 · 香港衞生署", "https://www.fhs.gov.hk/tc_chi/health_info/child/16301.html", lang="zh"),
        SearchResult("Tips for Mealtime Routines · CDC", "https://www.cdc.gov/infant-toddler-nutrition/mealtime/index.html"),
    ),
}


def _reviewed_videos(topic: _VideoTopic | None, locale: str) -> list[dict[str, str]]:
    rows = _REVIEWED_VIDEOS.get(topic, {}).get("zh" if locale.startswith("zh") else "en", ())
    return [
        {"type": "video", "title": title, "source_url": source, **public_video_fields(watch_url(video_id))}
        for title, video_id, source in rows
    ]


def _reviewed_articles(topic: _VideoTopic | None, locale: str) -> list[SearchResult]:
    rows = _REVIEWED_ARTICLES.get(topic)
    if not rows:
        return []
    simplified, traditional, english = rows
    return [traditional if locale == "zh-TW" else simplified, english] if locale.startswith("zh") else [english]


def _recent_resource_text(history, role: str | None = None) -> list[str]:
    return [
        str(row.get("text") or "")[:1800] for row in reversed(history[-8:])
        if isinstance(row, dict) and row.get("role") in ({role} if role else {"user", "ai"})
    ]


def _is_link_request(text: str) -> bool:
    return bool(_LINK_REQUEST.search(text) and not _NON_RESOURCE_LINK.search(text))


def _is_reference(text: str) -> bool:
    if _FOLLOW_UP_CHALLENGE.search(text) or _SHORT_REFERENCE.fullmatch(text):
        return True
    remaining = _LINK_ONLY.sub(" ", text)
    return not re.search(r"[a-z0-9㐀-鿿]", remaining, re.I)


def _topic_in(text: str) -> _VideoTopic | None:
    safe = _video_subject(text)
    if _OFF_TOPIC_VIDEO.search(safe):
        return None
    return next((topic for topic in _VIDEO_TOPICS if topic.terms.search(safe)), None)


def _video_subject(value: str) -> str:
    return unicodedata.normalize("NFKC", value)


def _resource_topic(text: str, query: str, route, children: list, allow_history: bool, history) -> _VideoTopic | None:
    direct = _video_subject(redact_conversation_text(redact_child_profile_text(text, children), 320))
    if _OFF_TOPIC_VIDEO.search(direct):
        return None
    if direct_topic := _topic_in(direct):
        return direct_topic
    if query and not _is_reference(query):
        # An explicit new subject takes priority over any previous topic.
        return _topic_in(query)
    # A short request for a resource may refer to this conversation's previous
    # topic. Recognize only a public category locally. Without the separate
    # content-research permission this only selects reviewed built-in cards.
    user_requests = [message for message in _recent_resource_text(history, "user")
                     if _REQUEST.search(message) and any(token.search(message) for token in _MEDIA.values())]
    earlier_messages = list(dict.fromkeys(user_requests + _recent_resource_text(history)))
    for earlier in earlier_messages:
        if earlier.strip() == text.strip() or _MEDICAL_TEXT.search(earlier):
            continue
        if topic := _topic_in(earlier):
            return topic
    if allow_history and route and route.ok:
        for signal in (route.topic, route.search_query, route.search_query_zh):
            safe = redact_conversation_text(redact_child_profile_text(signal, children), 120)
            if not _PRIVATE_TEXT.search(safe) and (topic := _topic_in(safe)):
                return topic
    return None


_GENERIC_VIDEO_WORDS = frozenset(
    "about and article best can child children clip could example find guide help here how latest me need parent parents parenting "
    "please recommend resource send share show tips tutorial use video videos want way where which would youtube".split()
)


def _english_terms(text: str) -> set[str]:
    return {word.removesuffix("s") if len(word) >= 5 else word
            for word in re.findall(r"[a-z][a-z0-9'-]{2,}", text)}


def _subject_matches(title: str, subject: str) -> bool:
    """Use concrete title evidence when no reviewed topic pattern exists."""
    title = _video_subject(title).casefold()
    subject = _video_subject(subject).casefold()
    title_words = _english_terms(title)
    subject_words = _english_terms(subject) - _GENERIC_VIDEO_WORDS
    if subject_words and len(subject_words & title_words) >= min(2, len(subject_words)):
        return True
    han = re.findall(r"[㐀-鿿]+", subject)
    significant = {
        phrase[index:index + 2] for phrase in han for index in range(len(phrase) - 1)
        if phrase[index:index + 2] not in {"宝宝", "寶寶", "孩子", "幼儿", "幼兒", "家长", "家長", "相关", "相關", "教程"}
    }
    return bool(significant and sum(token in title for token in significant) >= min(len(significant), 2))


def _video_items(topic: _VideoTopic | None, rows: list[SearchResult], language: str = "", subject: str = "") -> list[dict[str, str]]:
    scored: list[tuple[int, dict[str, str]]] = []
    for row in rows:
        title = _plain_title(row.title).removesuffix(" - YouTube")
        title_evidence = _video_subject(title)
        snippet = _video_subject(row.snippet[:600])
        if (not title or _OFF_TOPIC_VIDEO.search(title_evidence) or _OFF_TOPIC_VIDEO.search(snippet)
                or _MEDICAL_TEXT.search(title_evidence)):
            continue
        if ((language == "zh" and not _HAN_TEXT.search(title_evidence))
                or (language == "en" and _HAN_TEXT.search(title_evidence))):
            continue
        child_in_title = bool(_CHILD_VIDEO.search(title_evidence))
        if topic:
            if not topic.terms.search(title_evidence) or not (child_in_title or _CHILD_VIDEO.search(snippet)):
                continue
        elif not _subject_matches(title_evidence, subject):
            continue
        if fields := public_video_fields(row.url):
            scored.append((2 if child_in_title else 1, {"type": "video", "title": title, **fields}))
    # Use the snippet to corroborate the audience, never to turn an unrelated
    # title into a match. Prefer titles that themselves name the child audience.
    unique: dict[str, dict[str, str]] = {}
    for _, item in sorted(scored, key=lambda row: -row[0]):
        unique.setdefault(item["video_id"], item)
    return list(unique.values())


def requested_media(text: str | None, history=()) -> tuple[str, ...]:
    value = (text or "").strip()
    if not 3 <= len(value) <= 320 or _NON_RESOURCE_LINK.search(value):
        return ()
    milestone_search = bool(_MILESTONE_TOPIC.terms.search(value) and _MILESTONE_SEARCH.search(value))
    if not (_REQUEST.search(value) or _is_link_request(value) or milestone_search):
        return ()
    explicit = tuple(kind for kind, token in _MEDIA.items() if token.search(value))
    if milestone_search and not explicit:
        for earlier in _recent_resource_text(history, "user"):
            if _MILESTONE_TOPIC.terms.search(earlier) and not _MILESTONE_CLINICAL.search(earlier):
                if previous := tuple(kind for kind, token in _MEDIA.items() if token.search(earlier)):
                    return previous
        return ("video",) if not _MILESTONE_CLINICAL.search(value) else ()
    if explicit or not _is_link_request(value):
        return explicit
    if _is_reference(value):
        for earlier in _recent_resource_text(history):
            if earlier.strip() == value or _NON_RESOURCE_LINK.search(earlier):
                continue
            if previous := tuple(kind for kind, token in _MEDIA.items() if token.search(earlier)):
                return previous
    return ("article",)


_MIXED_REQUEST = re.compile(
    r"\b(?:also|additionally|separately|but first)\b|[附顺順]带|[顺順]便|同[时時]|"
    r"[并並]且.{0,8}(?:解[释釋]|告[诉訴])|先.{1,32}再.{0,10}(?:找|[给給]|[发發])",
    re.I,
)


def resource_only_request(text: str) -> bool:
    return _is_reference(text) or not _MIXED_REQUEST.search(text)


def resource_reply(transition: dict | None, locale: str) -> str:
    """Match visible text to the resources this turn actually returned."""
    if transition and transition.get("catalog") == "cdc_milestones":
        return {
            "zh-CN": "下面是 CDC 按月龄整理的发育里程碑示例，点卡片就能打开。",
            "zh-TW": "下方是 CDC 按月齡整理的發展里程碑示例，點卡片就能開啟。",
        }.get(locale, "Here are the CDC's milestone examples by age. Tap a card to open it.")
    messages = {
        "zh-CN": ("相关资料在下面，点卡片就能打开。", "这次没找到可以核实的相关资料。"),
        "zh-TW": ("相關資料在下方，點卡片即可開啟。", "這次沒找到可以核實的相關資料。"),
        "en": ("Here are the resources I found. Tap a card to open it.", "I couldn’t verify a relevant resource this time."),
    }
    ready, missing = messages.get(locale, messages["en"])
    return ready if transition and transition.get("items") else missing


def _safe_url(value: object, *, image: bool = False) -> str | None:
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f\\]", value):
        return None
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        if (url.scheme != "https" or url.username or url.password or url.port is not None
                or not re.fullmatch(r"(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,63}", host, re.I)
                or host.endswith((".local", ".localhost", ".internal", ".lan", ".home", ".test", ".example"))
                or any(_CREDENTIAL.search(key) for key, _ in parse_qsl(url.query))):
            return None
        if image and (not _SAFE_PATH.search(url.path) or _DECORATION.search(url.path)):
            return None
        return urlunsplit(("https", host, url.path or "/", url.query, ""))
    except ValueError:
        return None


def public_video_fields(value: object) -> dict[str, str]:
    url = _safe_url(value)
    video_id = video_id_of(url) if url else None
    if not video_id:
        return {}
    return {"url": watch_url(video_id), "video_id": video_id, "thumbnail_url": thumbnail_url(video_id)}


def public_article_url(value: object) -> str | None:
    return _safe_url(value)


def _plain_title(value: str) -> str:
    return re.sub(r"[\s\x00-\x1f\x7f]+", " ", value).strip()[:160]


def _subject(value: str, children: list) -> str:
    safe = redact_conversation_text(redact_child_profile_text(value, children), 180)
    if _PRIVATE_TEXT.search(safe):
        return ""
    for regex in _MEDIA.values():
        safe = regex.sub(" ", safe)
    if len(safe.strip()) < 3 or _is_reference(safe):
        return ""
    return re.sub(r"\s+", " ", _LINK_ONLY.sub(" ", safe)).strip(" ，。,.!?！？:：")


def _query(text: str, route, children: list, locale: str, allow_history: bool) -> str:
    if _PRIVATE_TEXT.search(redact_conversation_text(text)):
        return ""
    if _FOLLOW_UP_CHALLENGE.search(text) and not _topic_in(redact_conversation_text(text)):
        direct = ""
    else:
        direct = _subject(text, children)
    if direct:
        return direct
    if allow_history and route and route.ok:
        routed = route.search_query_zh if locale.startswith("zh") else route.search_query
        return _subject(routed or route.topic, children)
    return ""


def _previous_explicit_subject(text: str, history, children: list) -> str:
    for row in reversed(history[-8:]):
        if not isinstance(row, dict) or row.get("role") != "user":
            continue
        earlier = str(row.get("text") or "")
        if earlier.strip() == text.strip() or not requested_media(earlier):
            continue
        if _OFF_TOPIC_VIDEO.search(earlier):
            return ""
        if subject := _subject(earlier, children):
            return subject
    return ""


def _images(result: SearchResult) -> list[str]:
    return [
        url for image in result.images[:4]
        if not _DECORATION.search(image.description or "") and (url := _safe_url(image.url, image=True))
    ]


def _trusted_article(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    return any(host == domain or host.endswith("." + domain) for domain in _ARTICLE_DOMAINS)


class _ArticleImage(HTMLParser):
    def __init__(self, url: str):
        super().__init__()
        self.url = url
        self.image: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "meta" or self.image:
            return
        fields = dict(attrs)
        name = (fields.get("property") or fields.get("name") or "").lower()
        if name not in {"og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"}:
            return
        source = fields.get("content")
        if source:
            self.image = _safe_url(urljoin(self.url, source), image=True)


async def _read_article_cover(client: httpx.AsyncClient, url: str) -> str | None:
    # Fetch only an HTTPS page at a curated publisher. Do not follow
    # redirects; a provider URL cannot expand this network boundary.
    if not _trusted_article(url):
        return None
    parser = _ArticleImage(url)
    try:
        async with asyncio.timeout(2.5):
            async with client.stream("GET", url, headers={"Accept": "text/html"}) as response:
                if response.status_code != 200 or "text/html" not in response.headers.get("content-type", ""):
                    return None
                page = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=8192):
                    page.extend(chunk[:196608 - len(page)])
                    if b"</head>" in page.lower() or len(page) >= 196608:
                        break
            parser.feed(page.decode("utf-8", errors="replace"))
    except (httpx.HTTPError, TimeoutError, ValueError):
        return None
    return parser.image


async def _with_article_covers(rows: list[SearchResult]) -> list[SearchResult]:
    # Some providers only return query-level images. Those have no exact
    # article provenance, so use the publisher's own preview when available.
    if not any(not _images(row) and _trusted_article(row.url) for row in rows):
        return rows
    async with httpx.AsyncClient(timeout=2.5, follow_redirects=False, trust_env=False) as client:
        async def enrich(row: SearchResult) -> SearchResult:
            if _images(row) or not (source := _safe_url(row.url)):
                return row
            image = await _read_article_cover(client, source)
            return replace(row, images=(SearchImage(image),)) if image else row

        return list(await asyncio.gather(*(enrich(row) for row in rows)))


def _source_rows(
    rows: list[SearchResult], authority_only: bool, topic: _VideoTopic | None = None, subject: str = "",
) -> list[SearchResult]:
    selected = []
    for row in rows:
        if not _plain_title(row.title) or (source := _safe_url(row.url)) is None or public_video_fields(source):
            continue
        if not (_trusted_article(source) or row.tier == "authority" or not authority_only and row.tier == "good"):
            continue
        if _OFF_TOPIC_VIDEO.search(row.title):
            continue
        if topic and not topic.terms.search(_video_subject(f"{row.title} {row.snippet[:400]}")):
            continue
        if subject and not topic and not _subject_matches(f"{row.title} {row.snippet[:400]}", subject):
            continue
        selected.append(row)
    return selected


def _result_items(kind: str, rows: list[SearchResult]) -> list[dict[str, str]]:
    items = []
    for row in rows:
        source = _safe_url(row.url)
        if not source:
            continue
        title = _plain_title(row.title)
        images = _images(row)
        if kind == "article":
            item = {"type": "article", "title": title, "url": source}
            if images:
                item["thumbnail_url"] = images[0]
            items.append(item)
        else:
            for image in images[:2]:
                items.append({"type": "image", "title": title, "url": image, "thumbnail_url": image, "source_url": source})
    return items


async def find_chat_media(
    text: str,
    kinds: tuple[str, ...],
    *, locale: str,
    route,
    children: list,
    allow_history: bool,
    existing: list[SearchResult],
    authority_only: bool = False,
    history=(),
) -> dict | None:
    """Only verified public resources reach cards. No transcript is sent."""
    compact_text = redact_conversation_text(text, 320)
    if _PRIVATE_TEXT.search(compact_text) or _OFF_TOPIC_VIDEO.search(compact_text):
        return None
    direct_query = _query(text, None, children, locale, False)
    query = direct_query
    if not query and allow_history:
        query = _previous_explicit_subject(text, history, children) or _query(text, route, children, locale, True)
    medical = bool(authority_only or getattr(route, "is_medical", False)
                   or _MEDICAL_TEXT.search(text) or _MEDICAL_TEXT.search(query))
    topic = _resource_topic(text, query, route, children, allow_history, history)
    if topic is _MILESTONE_TOPIC:
        # Routine, reviewed age examples are useful even when the routing model
        # calls the general subject medical. Keep diagnostic requests subject to
        # the ordinary medical/referral path.
        recent = _recent_resource_text(history, "user")
        prior = next((message for message in recent if _MILESTONE_TOPIC.terms.search(message)), "")
        diagnostic_text = text if _MILESTONE_TOPIC.terms.search(text) else f"{text} {prior}"
        if _MEDICAL_TEXT.search(diagnostic_text) or _MILESTONE_CLINICAL.search(diagnostic_text):
            medical = True
        elif not _EXPLICIT_ZH_VIDEO.search(text):
            relevant = [message for message in recent if _MILESTONE_TOPIC.terms.search(message)]
            months = alpha_milestones.child_age(text, children, relevant)
            cards = alpha_milestones.reviewed_cards(months, locale, kinds)
            if cards:
                return {"kind": "chat_media", "catalog": "cdc_milestones", "items": cards[:_MAX_ITEMS]}
    if not topic and not query:
        return None
    if not direct_query and not allow_history:
        # A local topic match can select from the reviewed library only.
        query = ""
    lang = "zh" if locale.startswith("zh") else "en"
    provider = get_provider()
    live_provider = provider.name not in ("null", "stub")

    async def search(request: SearchRequest) -> list[SearchResult]:
        if not live_provider:
            return []
        try:
            return await asyncio.wait_for(provider.search(request), 5.0)
        except Exception:
            # The carousel must never fail or cancel a chat reply.
            return []

    async def videos():
        if medical or "video" not in kinds:
            return []
        language = "zh" if _EXPLICIT_ZH_VIDEO.search(text) else "en" if _EXPLICIT_EN_VIDEO.search(text) else ""
        search_locale = "en" if language == "en" else "zh-CN" if language == "zh" and lang != "zh" else locale
        rows = []
        if query or topic and allow_history:
            rows = await search(SearchRequest(
                query=topic.query(search_locale) if topic else query,
                lang="zh" if search_locale.startswith("zh") else "en",
                include_domains=("youtube.com",), max_results=8,
            ))
        items = _video_items(topic, rows, language, query) or _reviewed_videos(topic, search_locale)
        return items[:_MAX_ITEMS if len(kinds) == 1 else 3]

    async def articles_and_images():
        requested = [kind for kind in ("article", "image") if kind in kinds]
        if not requested:
            return []
        reviewed = _reviewed_articles(topic, locale)
        rows = _source_rows(existing, medical, topic, query) if query or allow_history else []
        if query and live_provider and (not rows or "image" in requested or not any(_images(row) for row in rows)):
            source_query = topic.query(locale) if topic else query
            live = await search(SearchRequest(
                query=source_query, lang=lang, include_domains=_ARTICLE_DOMAINS,
                max_results=6, include_images=True,
            ))
            rows.extend(_source_rows(live, medical, topic, query))
        # Include the reviewed pictures when the search returned only text.
        combined = {row.url: row for row in reviewed}
        combined.update((row.url, row) for row in rows)
        prioritized = list(dict.fromkeys(row.url for row in rows + reviewed))[:_MAX_ITEMS]
        sources = [combined[url] for url in prioritized]
        if query and live_provider:
            sources = await _with_article_covers(sources)
        per_kind = _MAX_ITEMS if len(kinds) == 1 else 3 if len(kinds) == 2 else 2
        return [item for kind in requested for item in _result_items(kind, sources)[:per_kind]]

    items = []
    seen = set()
    for group in await asyncio.gather(videos(), articles_and_images()):
        for item in group:
            if item["url"] not in seen:
                seen.add(item["url"])
                items.append(item)
    return {"kind": "chat_media", "items": items[:_MAX_ITEMS]} if items else None
