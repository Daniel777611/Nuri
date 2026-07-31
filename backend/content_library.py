"""Curated learning content used by the personalized home feed.

The model is never allowed to invent a resource URL. Every external link in
this module is reviewed as either an authoritative source or an editorially
curated, expert-reviewed source. Conversation text is used only to rank these
stable content IDs.
"""

from urllib.parse import urlparse

TRUSTED_RESOURCE_HOSTS = frozenset(
    {
        "healthychildren.org",
        "www.healthychildren.org",
        "cdc.gov",
        "www.cdc.gov",
        "unicef.org",
        "www.unicef.org",
        "developingchild.harvard.edu",
        "asha.org",
        "www.asha.org",
        "youtube.com",
        "www.youtube.com",
        "youtu.be",
        "fhs.gov.hk",
        "www.fhs.gov.hk",
        "raisingchildren.net.au",
        "www.raisingchildren.net.au",
    }
)

SUPPORTED_RESOURCE_LOCALES = frozenset({"zh-CN", "zh-TW", "en", "es"})


def is_trusted_resource_url(url: str) -> bool:
    """Return True only for reviewed HTTPS publisher domains."""

    try:
        parsed = urlparse(url)
    except (TypeError, ValueError):
        return False
    return (
        parsed.scheme == "https"
        and (parsed.hostname or "").lower() in TRUSTED_RESOURCE_HOSTS
    )


def order_learning_resources(
    resources: list[dict], preferred_locale: str
) -> list[dict]:
    """Return a stable, language-aware copy of reviewed learning resources."""

    normalized_locale = "zh-CN" if preferred_locale == "zh" else preferred_locale
    locale_order = {
        "zh-CN": ("zh-CN", "zh-TW", "en", "es"),
        "zh-TW": ("zh-TW", "zh-CN", "en", "es"),
        "en": ("en", "zh-CN", "zh-TW", "es"),
    }.get(normalized_locale, ("zh-CN", "zh-TW", "en", "es"))
    locale_rank = {locale: index for index, locale in enumerate(locale_order)}
    group_rank = {
        ("authority", "article"): 0,
        ("curated", "article"): 1,
        ("authority", "video"): 2,
        ("curated", "video"): 3,
    }

    def sort_key(indexed_resource: tuple[int, dict]) -> tuple[int, int, int]:
        index, resource = indexed_resource
        locales = resource.get("locales") or []
        best_locale_rank = min(
            (locale_rank.get(locale, len(locale_order)) for locale in locales),
            default=len(locale_order),
        )
        return (
            best_locale_rank,
            group_rank.get(
                (
                    str(resource.get("source_tier") or "authority"),
                    str(resource.get("kind") or ""),
                ),
                len(group_rank),
            ),
            index,
        )

    return [resource for _, resource in sorted(enumerate(resources), key=sort_key)]


LEARNING_CONTENT_CARDS = [
    {
        "id": "learn_sleep_routine",
        "topic": "sleep",
        "topic_label": "睡眠与作息",
        "type": "tip",
        "type_label": "对话精选",
        "cta": "浏览详情",
        "publisher": "AAP 美国儿科学会",
        "title": "孩子夜醒或入睡困难，可以先从固定睡前节奏开始",
        "summary": "把睡前半小时变得可预期，并观察夜醒后的回应方式是否一致。",
        "body": (
            "孩子的睡眠很少靠某一个技巧立刻改变。更值得先做的，是把每天睡前的顺序变得简单、温和、可重复："
            "例如洗漱、调暗灯光、读一本书、拥抱和晚安。夜里醒来时，照顾者也尽量使用相近的安抚方式。\n\n"
            "你可以连续记录三到七晚：入睡时间、夜醒次数、白天小睡和当天是否有明显变化。记录的目的不是追求完美，"
            "而是找到最可能影响孩子的规律。如果伴随呼吸异常、持续疼痛或明显精神状态变化，应及时联系医疗专业人员。"
        ),
        "tags": ["#睡眠", "#夜醒", "#睡前仪式"],
        "hook_line": "下面的文章和视频可以帮助你把方法做得更具体。",
        "match_terms": [
            "睡眠",
            "睡觉",
            "睡不着",
            "不肯睡",
            "入睡",
            "哄睡",
            "夜醒",
            "醒了",
            "晚睡",
            "早醒",
            "作息",
            "睡前",
            "小睡",
            "nap",
            "bedtime",
            "sleep",
            "wake up",
        ],
        "resources": [
            {
                "id": "sleep-aap-article",
                "kind": "article",
                "title": "Toddler Bedtime Trouble: 7 Tips for Parents",
                "publisher": "AAP · HealthyChildren.org",
                "language": "英文文章",
                "description": "美国儿科学会给幼儿家庭的睡前困难应对建议。",
                "url": "https://www.healthychildren.org/English/healthy-living/sleep/Pages/bedtime-trouble.aspx",
            },
            {
                "id": "sleep-aap-video",
                "kind": "video",
                "title": "Smart Solutions for Safe and Sound Sleep",
                "publisher": "AAP 官方 YouTube 频道",
                "language": "英文视频",
                "description": "儿科专家讲解安全睡眠与常见睡眠问题。",
                "url": "https://www.youtube.com/watch?v=gn1bbzLU2rg",
            },
        ],
    },
    {
        "id": "learn_big_feelings",
        "topic": "emotion",
        "topic_label": "情绪调节",
        "type": "tip",
        "type_label": "对话精选",
        "cta": "浏览详情",
        "publisher": "AAP 与 UNICEF",
        "title": "孩子有“大情绪”时，先共调节，再教他表达",
        "summary": "把哭闹、生气或害怕看作需要帮助的信号，而不是故意为难大人。",
        "body": (
            "幼儿还不能独自完成复杂的情绪调节。情绪很强烈时，可以先降低声音、靠近并保证安全，再用很短的话替孩子命名感受，"
            "例如“你很失望，因为现在要离开”。等身体慢慢平静后，再讨论边界和下一次可以怎么做。\n\n"
            "共情不等于取消规则。你可以同时说“我知道你很生气”和“我不会让你打人”。稳定、可预测的回应，会逐渐成为孩子日后"
            "自己调节情绪时可以调用的经验。"
        ),
        "tags": ["#情绪", "#共调节", "#亲子沟通"],
        "hook_line": "先理解情绪发生了什么，再选择适合你家的回应。",
        "match_terms": [
            "情绪",
            "焦虑",
            "害怕",
            "担心",
            "崩溃",
            "哭",
            "爱哭",
            "生气",
            "发火",
            "冷静",
            "压力",
            "共情",
            "安抚",
            "情绪管理",
            "emotion",
            "anxiety",
            "upset",
            "calm",
        ],
        "resources": [
            {
                "id": "emotion-aap-article",
                "kind": "article",
                "title": "Helping Little People Manage Big Feelings",
                "publisher": "AAP · HealthyChildren.org",
                "language": "英文文章",
                "description": "帮助幼儿识别和管理强烈情绪的儿科建议。",
                "url": "https://www.healthychildren.org/English/family-life/family-dynamics/Pages/helping-little-people-manage-big-feelings.aspx",
            },
            {
                "id": "emotion-unicef-video",
                "kind": "video",
                "title": "How to Build Your Baby's Mental Health",
                "publisher": "UNICEF 官方 YouTube 频道",
                "language": "英文视频",
                "description": "介绍照顾者回应如何支持婴幼儿的心理健康。",
                "url": "https://www.youtube.com/watch?v=dp2NKV0C7_k",
            },
        ],
    },
    {
        "id": "learn_picky_eating",
        "topic": "food",
        "topic_label": "挑食与营养",
        "type": "tip",
        "type_label": "对话精选",
        "cta": "浏览详情",
        "publisher": "AAP 与 UNICEF",
        "title": "面对挑食，先减少餐桌压力，再增加接触机会",
        "summary": "新食物可以重复出现，但不把“必须吃一口”变成每餐的冲突。",
        "body": (
            "很多幼儿会经历食物选择突然变窄的阶段。照顾者负责提供规律、相对均衡的选择，孩子决定吃不吃以及吃多少。"
            "可以把一种熟悉食物和少量新食物放在同一餐里，让孩子先看、闻、碰，不急着要求吞下。\n\n"
            "连续记录一到两周，比单看某一顿更有意义。若孩子持续体重下降、吞咽困难、频繁呛咳，或可接受的食物越来越少，"
            "应向儿科医生或喂养专业人员咨询。"
        ),
        "tags": ["#挑食", "#营养", "#餐桌关系"],
        "hook_line": "从可信儿科资源里挑一个最容易执行的改变。",
        "match_terms": [
            "挑食",
            "吃饭",
            "不吃",
            "拒绝吃",
            "只吃",
            "蔬菜",
            "水果",
            "营养",
            "辅食",
            "食物",
            "吞咽",
            "餐桌",
            "喂饭",
            "picky",
            "eating",
            "food",
            "feeding",
        ],
        "resources": [
            {
                "id": "food-aap-article",
                "kind": "article",
                "title": "How Do I Help My Picky Eater Try More Healthy Foods?",
                "publisher": "AAP · HealthyChildren.org",
                "language": "英文文章",
                "description": "关于重复接触、用餐结构和家长分工的实用建议。",
                "url": "https://www.healthychildren.org/english/tips-tools/ask-the-pediatrician/pages/how-do-i-help-my-picky-eater-try-more-foods.aspx",
            },
            {
                "id": "food-aap-video",
                "kind": "video",
                "title": "Tips for Feeding Picky Eaters",
                "publisher": "AAP 官方 YouTube 频道",
                "language": "英文视频",
                "description": "儿科医生演示如何降低挑食家庭的进餐压力。",
                "url": "https://www.youtube.com/watch?v=s1KvNv4Jxqw",
            },
        ],
    },
    {
        "id": "learn_development_milestones",
        "topic": "development",
        "topic_label": "发展阶段与里程碑",
        "type": "tip",
        "type_label": "对话精选",
        "cta": "浏览详情",
        "publisher": "美国疾病控制与预防中心 CDC",
        "title": "孩子现在进入什么“关键期”？先看发展里程碑，再决定最值得练什么",
        "summary": "按月龄观察社交、语言、认知和动作变化，把精力放在孩子正在形成的能力上。",
        "body": (
            "家长常说的“关键期”，更适合被理解为某些能力在一段时间里发展得特别活跃，而不是错过某一天就无法补回。"
            "可以先按孩子的月龄查看社交情绪、语言沟通、认知和动作里程碑，再结合他已经会什么、正在反复练什么，决定现在最值得提供的环境和互动。\n\n"
            "例如九个月左右，很多宝宝会更频繁地练习坐起、爬行、扶站和手部操作，也可能出现更明显的分离反应、寻找被藏起来的物品、模仿声音等变化。"
            "照顾者可以提供安全的地面探索、简单的轮流游戏、短句回应和可预测的离开—回来。里程碑是观察与沟通工具，不是给孩子打分；"
            "如果孩子失去已经掌握的能力，或你持续担心他的反应和发展，应及时与儿科医生讨论。"
        ),
        "tags": ["#发展里程碑", "#关键期", "#月龄发展"],
        "hook_line": "先查看对应月龄的官方里程碑，再选择一两项最适合你家孩子的日常练习。",
        "match_terms": [
            "关键期",
            "敏感期",
            "发展阶段",
            "发育阶段",
            "发展里程碑",
            "发育里程碑",
            "月龄",
            "9个月",
            "九个月",
            "10个月",
            "十个月",
            "11个月",
            "十一个月",
            "一岁",
            "大运动",
            "爬行",
            "会爬",
            "扶站",
            "客体永久",
            "分离焦虑",
            "精细动作",
            "认知发展",
            "developmental milestone",
            "developmental milestones",
            "milestones",
        ],
        "resources": [
            {
                "id": "development-cdc-article",
                "kind": "article",
                "title": "CDC's Developmental Milestones",
                "publisher": "美国疾病控制与预防中心 CDC",
                "language": "英文 / 西班牙文文章",
                "description": "按孩子月龄查看社交、语言、认知与动作里程碑及家庭活动建议。",
                "url": "https://www.cdc.gov/act-early/milestones/index.html",
            },
            {
                "id": "development-cdc-video",
                "kind": "video",
                "title": "Milestones Matter for Families!",
                "publisher": "CDC 官方 YouTube 频道",
                "language": "英文视频",
                "description": "家长分享如何使用发展里程碑工具观察孩子并与专业人员沟通。",
                "url": "https://www.youtube.com/watch?v=S-OQXmjY53o",
            },
        ],
    },
    {
        "id": "learn_language_milestones",
        "topic": "language",
        "topic_label": "语言与沟通",
        "type": "tip",
        "type_label": "对话精选",
        "cta": "浏览详情",
        "publisher": "CDC 与 ASHA",
        "title": "担心孩子说话晚？先看沟通里程碑和日常互动",
        "summary": "把词汇量放回年龄、理解能力、手势和互动意愿中一起观察。",
        "body": (
            "语言发展不只包括会说多少词，也包括是否会看向交流对象、使用手势、理解简单指令和轮流互动。你可以记录孩子自然表达的方式，"
            "并在日常活动中跟随他的注意点，用短句描述正在发生的事，留出回应时间。\n\n"
            "里程碑是帮助家长及时行动的观察工具，不是给孩子贴标签。如果孩子出现已掌握能力倒退、对声音反应很少，或你持续担心，"
            "请和儿科医生讨论听力与发展筛查。"
        ),
        "tags": ["#语言发展", "#沟通", "#发育里程碑"],
        "hook_line": "对照官方里程碑时，也保留对孩子个体节奏的观察。",
        "match_terms": [
            "说话",
            "不开口",
            "说话晚",
            "词汇",
            "发音",
            "语言",
            "听不懂",
            "表达",
            "沟通",
            "手势",
            "叫名字",
            "里程碑",
            "language",
            "speech",
            "words",
            "milestone",
            "communication",
        ],
        "resources": [
            {
                "id": "language-cdc-article",
                "kind": "article",
                "title": "CDC's Developmental Milestones",
                "publisher": "美国疾病控制与预防中心 CDC",
                "language": "英文 / 西班牙文文章",
                "description": "按年龄查看沟通、认知、动作与社会情绪里程碑。",
                "url": "https://www.cdc.gov/act-early/milestones/index.html",
            },
            {
                "id": "language-cdc-video",
                "kind": "video",
                "title": "Milestones Matter for Families",
                "publisher": "CDC 官方 YouTube 频道",
                "language": "英文视频",
                "description": "帮助家长理解如何观察和沟通发展里程碑。",
                "url": "https://www.youtube.com/watch?v=T7bCsIIpC7M",
            },
        ],
    },
    {
        "id": "learn_tantrum_boundaries",
        "topic": "behavior",
        "topic_label": "行为与边界",
        "type": "tip",
        "type_label": "对话精选",
        "cta": "浏览详情",
        "publisher": "AAP 与 UNICEF",
        "title": "发脾气、打人或不配合时，边界要短而一致",
        "summary": "先保证安全，再减少解释，用可重复的话和行动守住边界。",
        "body": (
            "孩子失控时，大段说理通常很难被听进去。先移开危险物、阻止伤害，再用一句稳定的话说明边界，例如“我不会让你打人”。"
            "等强烈情绪过去后，再简短复盘并练习替代动作。\n\n"
            "规则越少、越明确，照顾者之间越一致，孩子越容易预测结果。纪律的目标不是让孩子害怕，而是帮助他逐渐学会安全、"
            "尊重和自我控制。"
        ),
        "tags": ["#发脾气", "#边界", "#正向管教"],
        "hook_line": "先选一句全家都能坚持的边界话术。",
        "match_terms": [
            "发脾气",
            "打人",
            "咬人",
            "踢人",
            "扔东西",
            "不听话",
            "不配合",
            "规则",
            "边界",
            "管教",
            "攻击",
            "尖叫",
            "撒泼",
            "tantrum",
            "discipline",
            "hit",
            "bite",
            "behavior",
        ],
        "resources": [
            {
                "id": "behavior-aap-article",
                "kind": "article",
                "title": "What's the Best Way to Discipline My Child?",
                "publisher": "AAP · HealthyChildren.org",
                "language": "英文文章",
                "description": "美国儿科学会关于安全、有效纪律方式的建议。",
                "url": "https://www.healthychildren.org/English/family-life/family-dynamics/communication-discipline/Pages/Disciplining-Your-Child.aspx",
            },
            {
                "id": "behavior-unicef-video",
                "kind": "video",
                "title": "Expert Tips for Taming Tantrums",
                "publisher": "UNICEF 官方 YouTube 频道",
                "language": "英文视频",
                "description": "专家讲解孩子发脾气时可以如何回应。",
                "url": "https://www.youtube.com/watch?v=L8B9zA8VUjk",
            },
        ],
    },
    {
        "id": "learn_serve_and_return",
        "topic": "connection",
        "topic_label": "亲子互动",
        "type": "tip",
        "type_label": "对话精选",
        "cta": "浏览详情",
        "publisher": "哈佛大学儿童发展中心",
        "title": "不知道怎么高质量陪伴？试试“发球与回应”",
        "summary": "跟随孩子正在关注的事物回应几轮，短时间也能形成真实连接。",
        "body": (
            "高质量陪伴不一定需要复杂活动。孩子看向、指向、发声或提出问题，就像向你“发球”；你注意到并回应，再等待他的下一次反应，"
            "就形成了来回互动。你可以给他正在关注的事物命名，跟随他的节奏，并在他转移注意时自然结束。\n\n"
            "这种互动可以发生在换衣、吃饭、散步或读绘本时。比起追求一次陪伴很久，更重要的是让孩子感受到：他的信号被看见，"
            "回应是可靠的。"
        ),
        "tags": ["#亲子互动", "#陪伴", "#发球与回应"],
        "hook_line": "看一遍示范视频，今天就能在日常里练习。",
        "match_terms": [
            "陪伴",
            "亲子",
            "亲子关系",
            "不知道怎么玩",
            "互动",
            "建立连接",
            "连接",
            "读绘本",
            "一起玩",
            "共同游戏",
            "注意力",
            "serve and return",
            "play",
            "connection",
            "bond",
        ],
        "resources": [
            {
                "id": "connection-harvard-article",
                "kind": "article",
                "title": "5 Steps for Brain-Building Serve and Return",
                "publisher": "Harvard Center on the Developing Child",
                "language": "英文 / 西班牙文文章",
                "description": "用五个步骤解释如何跟随孩子的信号形成来回互动。",
                "url": "https://developingchild.harvard.edu/resources/briefs/5-steps-for-brain-building-serve-and-return/",
            },
            {
                "id": "connection-harvard-video",
                "kind": "video",
                "title": "How-to: 5 Steps for Brain-Building Serve and Return",
                "publisher": "Harvard Center on the Developing Child",
                "language": "英文 / 西班牙文视频",
                "description": "通过具体画面示范照顾者如何观察、回应并轮流互动。",
                "url": "https://developingchild.harvard.edu/resources/videos/how-to-5-steps-for-brain-building-serve-and-return/",
            },
        ],
    },
    {
        "id": "learn_home_safety",
        "topic": "safety",
        "topic_label": "居家安全",
        "type": "tip",
        "type_label": "对话精选",
        "cta": "浏览详情",
        "publisher": "CDC 与 AAP",
        "title": "孩子活动范围变大后，重新做一次居家安全检查",
        "summary": "从孩子视线高度检查药品、电池、热源、水域和可能造成窒息的小物。",
        "body": (
            "孩子会爬、会走或开始攀爬后，原本够不到的地方会很快变得可达。可以蹲到孩子的高度逐个房间查看：药品和清洁剂是否上锁，"
            "纽扣电池和小物是否收好，家具是否固定，热水、窗户和水域是否有保护。\n\n"
            "安全措施要随着能力变化定期更新。如果怀疑误食、中毒、窒息或出现呼吸困难，应立即联系当地急救或毒物控制服务，"
            "不要等待普通线上建议。"
        ),
        "tags": ["#居家安全", "#儿童防护", "#急救意识"],
        "hook_line": "用官方清单，从今天最常活动的房间开始检查。",
        "match_terms": [
            "误食",
            "窒息",
            "跌倒",
            "烫伤",
            "溺水",
            "药品",
            "电池",
            "居家安全",
            "儿童防护",
            "安全门",
            "插座",
            "家具固定",
            "babyproof",
            "safety",
            "choking",
            "poison",
        ],
        "resources": [
            {
                "id": "safety-cdc-article",
                "kind": "article",
                "title": "Young Children: Safety in the Home & Community",
                "publisher": "美国疾病控制与预防中心 CDC",
                "language": "英文文章",
                "description": "涵盖居家、出行和户外环境中的儿童安全重点。",
                "url": "https://www.cdc.gov/parents/children/safety-in-the-home-and-community.html",
            },
            {
                "id": "safety-aap-video",
                "kind": "video",
                "title": "Household Hazards: Keeping Kids Safe at Home",
                "publisher": "AAP 官方 YouTube 频道",
                "language": "英文视频",
                "description": "儿科安全讲座，介绍家庭中常见但容易忽视的风险。",
                "url": "https://www.youtube.com/watch?v=nBE3ZuqwlkA",
            },
        ],
    },
]


_LOCALIZED_RESOURCES_BY_CARD_ID = {
    "learn_sleep_routine": [
        {
            "id": "sleep-zh-cn-article",
            "kind": "article",
            "title": "摇篮曲之一：建立睡眠常规",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "说明婴幼儿睡眠周期、夜醒回应及建立睡前常规的方法。",
            "url": "https://www.fhs.gov.hk/sc_chi/health_info/child/13043.html",
        },
        {
            "id": "sleep-zh-cn-video",
            "kind": "video",
            "title": "建立睡前常规",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "普通话影片 · 简体剧本",
            "locales": ["zh-CN"],
            "description": "示范如何依宝宝的特性安排固定、平静而可重复的睡前步骤。",
            "url": "https://www.fhs.gov.hk/sc_chi/mulit_med/000015.html",
        },
        {
            "id": "sleep-zh-tw-article",
            "kind": "article",
            "title": "搖籃曲之一：建立睡眠常規",
            "publisher": "香港衞生署家庭健康服務",
            "language": "繁體中文",
            "locales": ["zh-TW"],
            "description": "說明嬰幼兒睡眠週期、夜醒回應及建立睡前常規的方法。",
            "url": "https://www.fhs.gov.hk/tc_chi/health_info/child/13043.html",
        },
        {
            "id": "sleep-zh-tw-video",
            "kind": "video",
            "title": "建立睡前常規",
            "publisher": "香港衞生署家庭健康服務",
            "language": "粵語影片 · 繁體文字稿",
            "locales": ["zh-TW"],
            "description": "示範如何依寶寶的特性安排固定、平靜而可重複的睡前步驟。",
            "url": "https://www.fhs.gov.hk/tc_chi/mulit_med/000015.html",
        },
    ],
    "learn_big_feelings": [
        {
            "id": "emotion-zh-cn-article",
            "kind": "article",
            "title": "培育高“EQ”孩子从零岁开始：为婴幼儿“情绪导航”的小锦囊",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "用观察、转换角度和表达同感，协助婴幼儿逐步调节情绪。",
            "url": "https://www.fhs.gov.hk/sc_chi/health_info/child/30159.html",
        },
        {
            "id": "emotion-zh-cn-video",
            "kind": "video",
            "title": "“情绪导航”小秘诀（婴幼儿篇）",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "普通话影片 · 简体剧本",
            "locales": ["zh-CN"],
            "description": "示范家长如何理解、接纳孩子的情绪并表达同感。",
            "url": "https://www.fhs.gov.hk/sc_chi/mulit_med/000114.html",
        },
        {
            "id": "emotion-zh-tw-article",
            "kind": "article",
            "title": "培育高「EQ」孩子從零歲開始：為嬰幼兒「情緒導航」的小錦囊",
            "publisher": "香港衞生署家庭健康服務",
            "language": "繁體中文",
            "locales": ["zh-TW"],
            "description": "用觀察、轉換角度和表達同感，協助嬰幼兒逐步調節情緒。",
            "url": "https://www.fhs.gov.hk/tc_chi/health_info/child/30159.html",
        },
        {
            "id": "emotion-zh-tw-video",
            "kind": "video",
            "title": "「情緒導航」小秘訣（嬰幼兒篇）",
            "publisher": "香港衞生署家庭健康服務",
            "language": "粵語影片 · 繁體文字稿",
            "locales": ["zh-TW"],
            "description": "示範家長如何理解、接納孩子的情緒並表達同感。",
            "url": "https://www.fhs.gov.hk/tc_chi/mulit_med/000114.html",
        },
    ],
    "learn_picky_eating": [
        {
            "id": "food-zh-cn-article",
            "kind": "article",
            "title": "孩子“偏食”怎么办？",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "建议重复提供新食物、不强迫进食，也不以零食作为奖励。",
            "url": "https://www.fhs.gov.hk/sc_chi/health_info/child/20033.html",
        },
        {
            "id": "food-zh-cn-video",
            "kind": "video",
            "title": "孩子偏食，应该怎样处理？",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "普通话影片 · 简体剧本",
            "locales": ["zh-CN"],
            "description": "说明如何降低进餐压力，并逐步增加孩子接触新食物的机会。",
            "url": "https://www.fhs.gov.hk/sc_chi/health_info/faq/child_health/GN1_2_4_2.html",
        },
        {
            "id": "food-zh-tw-article",
            "kind": "article",
            "title": "孩子「偏食」怎麼辦？",
            "publisher": "香港衞生署家庭健康服務",
            "language": "繁體中文",
            "locales": ["zh-TW"],
            "description": "建議重複提供新食物、不強迫進食，也不以零食作獎勵。",
            "url": "https://www.fhs.gov.hk/tc_chi/health_info/child/20033.html",
        },
        {
            "id": "food-zh-tw-video",
            "kind": "video",
            "title": "孩子偏食，應該怎樣處理？",
            "publisher": "香港衞生署家庭健康服務",
            "language": "粵語影片 · 繁體文字稿",
            "locales": ["zh-TW"],
            "description": "說明如何降低進餐壓力，並逐步增加孩子接觸新食物的機會。",
            "url": "https://www.fhs.gov.hk/tc_chi/health_info/faq/child_health/GN1_2_4_2.html",
        },
    ],
    "learn_development_milestones": [
        {
            "id": "development-zh-cn-article",
            "kind": "article",
            "title": "儿童发展5：八至十二个月大婴儿的发展",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "涵盖坐、爬、扶站、精细动作、语言、认知和分离反应。",
            "url": "https://www.fhs.gov.hk/sc_chi/health_info/child/15697.html",
        },
        {
            "id": "development-zh-cn-video",
            "kind": "video",
            "title": "八至十二个月的发展",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "粤语影片 · 简体剧本",
            "locales": ["zh-CN"],
            "description": "以日常画面说明八至十二个月婴儿常见的发展表现。",
            "url": "https://www.fhs.gov.hk/sc_chi/mulit_med/000034.html",
        },
        {
            "id": "development-zh-tw-article",
            "kind": "article",
            "title": "兒童發展 5：八至十二個月大嬰兒的發展",
            "publisher": "香港衞生署家庭健康服務",
            "language": "繁體中文",
            "locales": ["zh-TW"],
            "description": "涵蓋坐、爬、扶站、精細動作、語言、認知和分離反應。",
            "url": "https://www.fhs.gov.hk/tc_chi/health_info/child/15697.html",
        },
        {
            "id": "development-zh-tw-video",
            "kind": "video",
            "title": "八至十二個月的發展",
            "publisher": "香港衞生署家庭健康服務",
            "language": "粵語影片 · 繁體文字稿",
            "locales": ["zh-TW"],
            "description": "以日常畫面說明八至十二個月嬰兒常見的發展表現。",
            "url": "https://www.fhs.gov.hk/tc_chi/mulit_med/000034.html",
        },
    ],
    "learn_language_milestones": [
        {
            "id": "language-zh-cn-article",
            "kind": "article",
            "title": "幼儿学说话之一（一至两岁）",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "介绍一至两岁幼儿的语言理解、表达、手势和求助信号。",
            "url": "https://www.fhs.gov.hk/sc_chi/health_info/child/13049.html",
        },
        {
            "id": "language-zh-cn-video",
            "kind": "video",
            "title": "言语治疗师话你知",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "粤语影片 · 简体剧本",
            "locales": ["zh-CN"],
            "description": "言语治疗师分享亲子沟通、语言发展和应留意的信号。",
            "url": "https://www.fhs.gov.hk/sc_chi/mulit_med/000029_p2.html",
        },
        {
            "id": "language-zh-tw-article",
            "kind": "article",
            "title": "幼兒學說話之一（一至兩歲）",
            "publisher": "香港衞生署家庭健康服務",
            "language": "繁體中文",
            "locales": ["zh-TW"],
            "description": "介紹一至兩歲幼兒的語言理解、表達、手勢和求助訊號。",
            "url": "https://www.fhs.gov.hk/tc_chi/health_info/child/13049.html",
        },
        {
            "id": "language-zh-tw-video",
            "kind": "video",
            "title": "言語治療師話你知",
            "publisher": "香港衞生署家庭健康服務",
            "language": "粵語影片 · 繁體文字稿",
            "locales": ["zh-TW"],
            "description": "言語治療師分享親子溝通、語言發展和應留意的訊號。",
            "url": "https://www.fhs.gov.hk/tc_chi/mulit_med/000029_p2.html",
        },
    ],
    "learn_tantrum_boundaries": [
        {
            "id": "behavior-zh-cn-article",
            "kind": "article",
            "title": "正面亲职（三）：应对学前儿童的不当行为",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "说明如何订立简短规则、即时制止危险行为并保持一致。",
            "url": "https://www.fhs.gov.hk/sc_chi/health_info/child/14837.html",
        },
        {
            "id": "behavior-zh-cn-video",
            "kind": "video",
            "title": "正面管教要点（适用于幼儿）",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "普通话影片 · 简体剧本",
            "locales": ["zh-CN"],
            "description": "示范鼓励好行为、订立简单规则和稳定执行的方法。",
            "url": "https://www.fhs.gov.hk/sc_chi/mulit_med/000087.html",
        },
        {
            "id": "behavior-zh-tw-article",
            "kind": "article",
            "title": "正面親職（三）：應對學前兒童的不當行為",
            "publisher": "香港衞生署家庭健康服務",
            "language": "繁體中文",
            "locales": ["zh-TW"],
            "description": "說明如何訂立簡短規則、即時制止危險行為並保持一致。",
            "url": "https://www.fhs.gov.hk/tc_chi/health_info/child/14837.html",
        },
        {
            "id": "behavior-zh-tw-video",
            "kind": "video",
            "title": "正面管教要點（適用於幼兒）",
            "publisher": "香港衞生署家庭健康服務",
            "language": "粵語影片 · 繁體文字稿",
            "locales": ["zh-TW"],
            "description": "示範鼓勵好行為、訂立簡單規則和穩定執行的方法。",
            "url": "https://www.fhs.gov.hk/tc_chi/mulit_med/000087.html",
        },
    ],
    "learn_serve_and_return": [
        {
            "id": "connection-zh-cn-article",
            "kind": "article",
            "title": "亲子沟通——给一岁前婴儿的家长",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "说明如何观察宝宝信号、即时回应、停顿等待并轮流互动。",
            "url": "https://www.fhs.gov.hk/sc_chi/health_info/child/13046.html",
        },
        {
            "id": "connection-zh-cn-video",
            "kind": "video",
            "title": "亲子沟通（四至六个月）",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "普通话影片 · 简体剧本",
            "locales": ["zh-CN"],
            "description": "用照顾情境示范观察、回应和来回互动的亲子沟通。",
            "url": "https://www.fhs.gov.hk/sc_chi/mulit_med/000025.html",
        },
        {
            "id": "connection-zh-tw-article",
            "kind": "article",
            "title": "親子溝通——給一歲前嬰兒的家長",
            "publisher": "香港衞生署家庭健康服務",
            "language": "繁體中文",
            "locales": ["zh-TW"],
            "description": "說明如何觀察寶寶訊號、即時回應、停頓等待並輪流互動。",
            "url": "https://www.fhs.gov.hk/tc_chi/health_info/child/13046.html",
        },
        {
            "id": "connection-zh-tw-video",
            "kind": "video",
            "title": "親子溝通（四至六個月）",
            "publisher": "香港衞生署家庭健康服務",
            "language": "粵語影片 · 繁體文字稿",
            "locales": ["zh-TW"],
            "description": "用照顧情境示範觀察、回應和來回互動的親子溝通。",
            "url": "https://www.fhs.gov.hk/tc_chi/mulit_med/000025.html",
        },
    ],
    "learn_home_safety": [
        {
            "id": "safety-zh-cn-article",
            "kind": "article",
            "title": "爱护儿童，慎防意外（一岁至三岁）",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "整理跌伤、窒息、药物、厨房、浴室、家具等家居风险。",
            "url": "https://www.fhs.gov.hk/sc_chi/health_info/child/15663.html",
        },
        {
            "id": "safety-zh-cn-video",
            "kind": "video",
            "title": "家居安全",
            "publisher": "香港特别行政区政府卫生署家庭健康服务",
            "language": "普通话影片 · 简体剧本",
            "locales": ["zh-CN"],
            "description": "逐一示范客厅、厨房、浴室和睡房中需要留意的安全措施。",
            "url": "https://www.fhs.gov.hk/sc_chi/mulit_med/000020.html",
        },
        {
            "id": "safety-zh-tw-article",
            "kind": "article",
            "title": "愛護兒童，慎防意外（一歲至三歲）",
            "publisher": "香港衞生署家庭健康服務",
            "language": "繁體中文",
            "locales": ["zh-TW"],
            "description": "整理跌傷、窒息、藥物、廚房、浴室、家具等家居風險。",
            "url": "https://www.fhs.gov.hk/tc_chi/health_info/child/15663.html",
        },
        {
            "id": "safety-zh-tw-video",
            "kind": "video",
            "title": "家居安全",
            "publisher": "香港衞生署家庭健康服務",
            "language": "粵語影片 · 繁體文字稿",
            "locales": ["zh-TW"],
            "description": "逐一示範客廳、廚房、浴室和睡房中需要留意的安全措施。",
            "url": "https://www.fhs.gov.hk/tc_chi/mulit_med/000020.html",
        },
    ],
}

_RAISING_CHILDREN_METADATA = {
    "publisher": "Raising Children Network（澳大利亚）",
    "source_tier": "curated",
    "selection_basis": "expert_reviewed",
    "trust_note": "澳大利亚政府支持；网站内容由科学顾问委员会指导，并经至少两名独立专家及专业编辑团队审核。",
    "recognition": "专家审核 · 家庭实操导向",
    "locales": ["en"],
}

_CURATED_RESOURCES_BY_CARD_ID = {
    "learn_sleep_routine": [
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "sleep-rcn-article",
            "kind": "article",
            "title": "Toddler sleep: what to expect",
            "language": "英文文章",
            "description": "从睡眠时长、白天小睡到固定睡前流程，给出可直接执行的家庭建议。",
            "selection_basis": "expert_and_audience",
            "selection_reason": "结构清楚、步骤具体，适合把作息建议落实为家庭流程。",
            "audience_note": "7.4k 位读者标记有帮助",
            "url": "https://raisingchildren.net.au/toddlers/sleep/understanding-sleep/toddler-sleep",
        },
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "sleep-rcn-video",
            "kind": "video",
            "title": "Baby sleep and settling tips",
            "language": "英文视频 · 英文文字稿",
            "description": "由多位家长分享夜醒、安抚和建立适合自己家庭睡眠节奏的经验。",
            "selection_reason": "真实家庭经验配合专业内容审核，适合快速理解不同做法的取舍。",
            "url": "https://raisingchildren.net.au/babies/videos/baby-sleep",
        },
    ],
    "learn_big_feelings": [
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "emotion-rcn-article",
            "kind": "article",
            "title": "Toddler emotions: learning and play ideas",
            "language": "英文文章",
            "description": "解释幼儿挫败、愤怒等情绪的发展，并提供游戏与陪伴方法。",
            "selection_reason": "把发展原理转成日常可用的互动建议，适合与权威指南交叉阅读。",
            "url": "https://raisingchildren.net.au/toddlers/play-learning/play-toddler-development/emotions-play-toddlers",
        },
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "emotion-rcn-video",
            "kind": "video",
            "title": "Helping toddlers learn about feelings",
            "language": "英文视频 · 英文文字稿",
            "description": "用真实情境示范靠近、协助、安抚和为情绪命名。",
            "selection_reason": "三分钟左右即可看完，步骤清晰并有完整文字稿。",
            "url": "https://raisingchildren.net.au/toddlers/videos/supporting-toddler-feelings",
        },
    ],
    "learn_picky_eating": [
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "food-rcn-article",
            "kind": "article",
            "title": "Fussy eating in children: what to do",
            "language": "英文文章",
            "description": "从用餐环境、食物自主和重复接触三个方向提供挑食应对建议。",
            "selection_reason": "避免强迫进食，方法具体，并明确何时应咨询医生或营养师。",
            "url": "https://raisingchildren.net.au/toddlers/nutrition-fitness/common-concerns/fussy-eating",
        },
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "food-rcn-video",
            "kind": "video",
            "title": "Is your child eating enough? How to tell",
            "language": "英文视频 · 英文文字稿",
            "description": "家长分享如何观察一段时间内的整体摄入，而不是纠结单独一餐。",
            "selection_reason": "真实家长经验容易理解，并由专业平台审核内容。",
            "url": "https://raisingchildren.net.au/toddlers/videos/eating-enough",
        },
    ],
    "learn_development_milestones": [
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "development-rcn-article",
            "kind": "article",
            "title": "Baby development at 10-11 months",
            "language": "英文文章",
            "description": "按日常动作、沟通、游戏与需要关注的信号梳理十至十一个月发展。",
            "selection_reason": "以家庭场景解释里程碑，同时提醒发展存在个体差异。",
            "url": "https://raisingchildren.net.au/babies/development/development-tracker-3-12-months/10-11-months",
        },
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "development-rcn-video",
            "kind": "video",
            "title": "Child development at 1-2 years",
            "language": "英文视频 · 英文文字稿",
            "description": "通过玩耍、交流和自主探索的画面说明一至两岁儿童发展。",
            "selection_reason": "短视频示范具体，包含完整文字稿与求助提示。",
            "url": "https://raisingchildren.net.au/toddlers/videos/development-1-2-years",
        },
    ],
    "learn_language_milestones": [
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "language-rcn-article",
            "kind": "article",
            "title": "Language development in children 1-2 years",
            "language": "英文文章",
            "description": "按理解、词汇、句子和发音介绍一至两岁语言发展与求助信号。",
            "selection_reason": "年龄分段明确，既给练习方法，也说明何时需要专业评估。",
            "url": "https://raisingchildren.net.au/toddlers/development/language-development/language-1-2-years",
        },
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "language-rcn-video",
            "kind": "video",
            "title": "Talking and bonding with babies: 7-17 months",
            "language": "英文视频 · 英文文字稿",
            "description": "示范模仿声音、回应指向、使用动作词和跟随孩子兴趣。",
            "selection_reason": "真实亲子互动可直接模仿，并有完整专业文字稿。",
            "url": "https://raisingchildren.net.au/babies/videos/connecting-communicating-7-17-months",
        },
    ],
    "learn_tantrum_boundaries": [
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "behavior-rcn-article",
            "kind": "article",
            "title": "Toddler tantrums: why they happen and how to respond",
            "language": "英文文章",
            "description": "解释一至三岁发脾气的原因，并提供安全、共情和一致回应步骤。",
            "selection_reason": "兼顾情绪接纳和行为边界，适合在冲突前后快速查阅。",
            "url": "https://raisingchildren.net.au/school-age/behaviour/crying-tantrums/tantrums",
        },
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "behavior-rcn-video",
            "kind": "video",
            "title": "Positive behaviour in children: tips in action",
            "language": "英文视频 · 英文文字稿",
            "description": "用家庭片段示范榜样、表扬、倾听和提前说明规则。",
            "selection_reason": "真实家庭演示容易照做，内容由专业团队审核。",
            "url": "https://raisingchildren.net.au/toddlers/videos/good-behaviour-tips-in-action",
        },
    ],
    "learn_serve_and_return": [
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "connection-rcn-article",
            "kind": "article",
            "title": "Baby cues: how to know what babies want",
            "language": "英文文章",
            "description": "通过目光、转头、哭声和疲倦信号帮助照顾者理解宝宝的回应。",
            "selection_reason": "图解式表达直观，能把来回互动落实到观察宝宝信号。",
            "url": "https://raisingchildren.net.au/newborns/connecting-communicating/communicating/baby-toddler-cues",
        },
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "connection-rcn-video",
            "kind": "video",
            "title": "Bonding and talking with babies: 0-6 months",
            "language": "英文视频 · 英文文字稿",
            "description": "示范眼神、拥抱、唱歌、阅读和回应声音如何形成来回互动。",
            "selection_reason": "真实互动场景丰富，家长无需额外工具即可练习。",
            "url": "https://raisingchildren.net.au/babies/videos/connecting-communicating-0-6-months",
        },
    ],
    "learn_home_safety": [
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "safety-rcn-article",
            "kind": "article",
            "title": "Child safety at home: checklist",
            "language": "英文文章",
            "description": "用清单覆盖跌落、烫伤、中毒、溺水、窒息和家具风险。",
            "selection_basis": "expert_and_audience",
            "selection_reason": "内容系统且适合逐项检查，可用于家庭安全巡检。",
            "audience_note": "1.2k 位读者标记有帮助",
            "url": "https://raisingchildren.net.au/babies/safety/home-pets/home-safety",
        },
        {
            **_RAISING_CHILDREN_METADATA,
            "id": "safety-rcn-video",
            "kind": "video",
            "title": "Protecting your baby's airways",
            "language": "英文动画 · 英文文字稿",
            "description": "动画说明睡眠、出行、玩耍和喂养时如何保持宝宝呼吸道通畅。",
            "selection_reason": "关键动作可视化，短而清楚，并由专业团队审核。",
            "url": "https://raisingchildren.net.au/newborns/videos/protecting-baby-airways-animation",
        },
    ],
}

_AUTHORITY_RESOURCE_DEFAULTS = {
    "source_tier": "authority",
    "selection_basis": "official",
    "trust_note": "政府、大学、医院、专业医学组织或其官方频道发布。",
    "recognition": "权威机构原始发布",
    "selection_reason": "作为事实、发展里程碑和安全建议的基础来源。",
}


def _with_resource_curation_metadata(resource: dict) -> dict:
    defaults = (
        _AUTHORITY_RESOURCE_DEFAULTS
        if resource.get("source_tier", "authority") == "authority"
        else {}
    )
    return {**defaults, **resource}


_MULTILINGUAL_ENGLISH_RESOURCE_IDS = frozenset(
    {
        "development-cdc-article",
        "language-cdc-article",
        "connection-harvard-article",
        "connection-harvard-video",
    }
)

for _card in LEARNING_CONTENT_CARDS:
    _reviewed_english_resources = [
        {
            **resource,
            "locales": (
                ["en", "es"]
                if resource["id"] in _MULTILINGUAL_ENGLISH_RESOURCE_IDS
                else ["en"]
            ),
        }
        for resource in _card.get("resources", [])
    ]
    _card["resources"] = [
        _with_resource_curation_metadata(resource)
        for resource in [
            *_LOCALIZED_RESOURCES_BY_CARD_ID.get(_card["id"], []),
            *_reviewed_english_resources,
            *_CURATED_RESOURCES_BY_CARD_ID.get(_card["id"], []),
        ]
    ]


LEARNING_CONTENT_BY_ID = {card["id"]: card for card in LEARNING_CONTENT_CARDS}
