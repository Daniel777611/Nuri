"""Curated learning content used by the personalized home feed.

The model is never allowed to invent a resource URL.  Every external link in
this module was reviewed against an official child-development, public-health,
or pediatric source.  Conversation text is used only to rank these stable
content IDs.
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
        "unicef.cn",
        "www.unicef.cn",
        "nhc.gov.cn",
        "www.nhc.gov.cn",
        "fhs.gov.hk",
        "www.fhs.gov.hk",
    }
)

SUPPORTED_RESOURCE_LOCALES = frozenset({"zh-CN", "zh-TW", "en", "es"})


def is_trusted_resource_url(url: str) -> bool:
    """Return True only for reviewed HTTPS publisher domains."""

    try:
        parsed = urlparse(url)
    except (TypeError, ValueError):
        return False
    return parsed.scheme == "https" and (parsed.hostname or "").lower() in TRUSTED_RESOURCE_HOSTS


def order_learning_resources(resources: list[dict], preferred_locale: str) -> list[dict]:
    """Return a stable, language-aware copy of reviewed learning resources."""

    normalized_locale = "zh-CN" if preferred_locale == "zh" else preferred_locale
    locale_order = {
        "zh-CN": ("zh-CN", "zh-TW", "en", "es"),
        "zh-TW": ("zh-TW", "zh-CN", "en", "es"),
        "en": ("en", "zh-CN", "zh-TW", "es"),
    }.get(normalized_locale, ("zh-CN", "zh-TW", "en", "es"))
    locale_rank = {locale: index for index, locale in enumerate(locale_order)}
    kind_rank = {"article": 0, "video": 1}

    def sort_key(indexed_resource: tuple[int, dict]) -> tuple[int, int, int]:
        index, resource = indexed_resource
        locales = resource.get("locales") or []
        best_locale_rank = min(
            (locale_rank.get(locale, len(locale_order)) for locale in locales),
            default=len(locale_order),
        )
        return (
            best_locale_rank,
            kind_rank.get(str(resource.get("kind") or ""), len(kind_rank)),
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
            "睡眠", "睡觉", "睡不着", "不肯睡", "入睡", "哄睡", "夜醒", "醒了", "晚睡", "早醒",
            "作息", "睡前", "小睡", "nap", "bedtime", "sleep", "wake up",
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
            "情绪", "焦虑", "害怕", "担心", "崩溃", "哭", "爱哭", "生气", "发火", "冷静", "压力",
            "共情", "安抚", "情绪管理", "emotion", "anxiety", "upset", "calm",
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
            "挑食", "吃饭", "不吃", "拒绝吃", "只吃", "蔬菜", "水果", "营养", "辅食", "食物", "吞咽",
            "餐桌", "喂饭", "picky", "eating", "food", "feeding",
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
            "关键期", "敏感期", "发展阶段", "发育阶段", "发展里程碑", "发育里程碑", "月龄",
            "9个月", "九个月", "10个月", "十个月", "11个月", "十一个月", "一岁",
            "大运动", "爬行", "会爬", "扶站", "客体永久", "分离焦虑", "精细动作", "认知发展",
            "developmental milestone", "developmental milestones", "milestones",
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
            "说话", "不开口", "说话晚", "词汇", "发音", "语言", "听不懂", "表达", "沟通", "手势", "叫名字",
            "里程碑", "language", "speech", "words", "milestone", "communication",
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
            "发脾气", "打人", "咬人", "踢人", "扔东西", "不听话", "不配合", "规则", "边界", "管教", "攻击",
            "尖叫", "撒泼", "tantrum", "discipline", "hit", "bite", "behavior",
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
            "陪伴", "亲子", "亲子关系", "不知道怎么玩", "互动", "建立连接", "连接", "读绘本", "一起玩", "共同游戏",
            "注意力", "serve and return", "play", "connection", "bond",
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
            "误食", "窒息", "跌倒", "烫伤", "溺水", "药品", "电池", "居家安全", "儿童防护", "安全门", "插座",
            "家具固定", "babyproof", "safety", "choking", "poison",
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
            "title": "0岁～5岁儿童睡眠卫生指南",
            "publisher": "国家卫生健康委员会",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "介绍固定睡前活动、规律作息和儿童睡眠环境等可执行建议。",
            "url": "https://www.nhc.gov.cn/wjw/c100311/201710/3f9da54855444a6b8f49051993a78933.shtml",
        },
        {
            "id": "sleep-zh-cn-video",
            "kind": "video",
            "title": "儿童青少年睡眠健康（上）",
            "publisher": "国家卫生健康委员会",
            "language": "中文视频 · 简体中文页面",
            "locales": ["zh-CN"],
            "description": "从睡眠健康角度讲解规律作息与良好睡眠习惯，可作为家庭实践的补充。",
            "url": "https://www.nhc.gov.cn/yzygj/jswsfwn/202605/8c96e1814dd4428cbc4fe4ce9304407d.shtml",
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
            "title": "0-5岁：为孩子一生的心理健康打下基础",
            "publisher": "联合国儿童基金会中国",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "说明照顾者如何在孩子有强烈情绪时给予安抚、回应和共同调节。",
            "url": "https://www.unicef.cn/mental-health/build-foundation-0-5-years",
        },
        {
            "id": "emotion-zh-cn-video",
            "kind": "video",
            "title": "观察孩子的需求，并给予积极的回应",
            "publisher": "联合国儿童基金会中国",
            "language": "中文视频 · 简体中文页面",
            "locales": ["zh-CN"],
            "description": "通过照顾场景介绍如何识别孩子的信号，并及时给予温和、积极的回应。",
            "url": "https://www.unicef.cn/videos/how-to-responsive-care",
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
            "title": "托育机构婴幼儿喂养与营养指南（试行）",
            "publisher": "国家卫生健康委员会",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "强调顺应喂养、识别饥饱信号、鼓励但不强迫孩子进食。",
            "url": "https://www.nhc.gov.cn/rkjcyjtfzs/c100147/202201/a7d3fc17153f410ea97270814a3e662f.shtml",
        },
        {
            "id": "food-zh-cn-video",
            "kind": "video",
            "title": "育儿有道：宝宝拒绝辅食怎么办",
            "publisher": "联合国儿童基金会中国",
            "language": "中文节目 · 简体中文页面",
            "locales": ["zh-CN"],
            "description": "讨论添加辅食阶段常见的拒绝进食问题和家庭应对方式。",
            "url": "https://www.unicef.cn/videos/ecd-master-class-breastfeeding-ep-3-first-part",
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
            "title": "婴幼儿早期发展服务指南（试行）",
            "publisher": "国家卫生健康委员会",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "按月龄覆盖大运动、精细动作、语言、认知和社会交往发展。",
            "url": "https://www.nhc.gov.cn/wjw/c100378/202502/658e7e4eb5024746b13186ac0f97a27b.shtml",
        },
        {
            "id": "development-zh-cn-video",
            "kind": "video",
            "title": "密切关注孩子的健康至关重要",
            "publisher": "联合国儿童基金会中国",
            "language": "中文视频 · 简体中文页面",
            "locales": ["zh-CN"],
            "description": "介绍如何观察孩子的发展轨迹，以及何时向专业人员咨询。",
            "url": "https://www.unicef.cn/videos/how-to-make-sure-your-child-development-is-on-track",
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
            "title": "如何与宝宝交流",
            "publisher": "联合国儿童基金会中国",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "介绍儿向语、重复、慢速表达、日常交流和轮流回应。",
            "url": "https://www.unicef.cn/parenting-site/how-talk-your-baby",
        },
        {
            "id": "language-zh-cn-video",
            "kind": "video",
            "title": "育儿有道：用早期阅读支持语言学习",
            "publisher": "联合国儿童基金会中国",
            "language": "中文节目 · 简体中文页面",
            "locales": ["zh-CN"],
            "description": "讲解亲子阅读和共同注意如何支持幼儿的理解与表达。",
            "url": "https://www.unicef.cn/videos/ecd-master-class-early-learning-ep04",
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
            "title": "如何用既聪明又健康的方式管教孩子",
            "publisher": "联合国儿童基金会中国",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "介绍明确期望、平静后果、一致执行和避免喊叫体罚。",
            "url": "https://www.unicef.cn/parenting-site/how-discipline-your-child-smart-and-healthy-way",
        },
        {
            "id": "behavior-zh-cn-video",
            "kind": "video",
            "title": "育儿有道：哭闹时如何沟通和建立规则",
            "publisher": "联合国儿童基金会中国",
            "language": "中文节目 · 简体中文页面",
            "locales": ["zh-CN"],
            "description": "讨论孩子大哭大闹时的沟通方式，以及如何建立规则意识。",
            "url": "https://www.unicef.cn/videos/ecd-master-class-positive-parenting-ep02",
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
            "title": "通过游戏促进宝宝大脑发育",
            "publisher": "联合国儿童基金会中国",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "解释亲子之间“你来我往”的回应如何支持宝宝学习和大脑发育。",
            "url": "https://www.unicef.cn/parenting-site/3-ways-parents-can-make-their-babies-smarter",
        },
        {
            "id": "connection-zh-cn-video",
            "kind": "video",
            "title": "陪伴孩子、鼓励孩子玩耍",
            "publisher": "联合国儿童基金会中国",
            "language": "中文视频 · 简体中文页面",
            "locales": ["zh-CN"],
            "description": "示范如何利用日常素材，在互动和游戏中跟随并回应孩子。",
            "url": "https://www.unicef.cn/videos/how-to-guide-your-children-to-learn-through-play",
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
            "title": "预防伤害",
            "publisher": "联合国儿童基金会中国",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "覆盖溺水、烫伤、触电、跌落、中毒和近距离看护等家庭安全重点。",
            "url": "https://www.unicef.cn/%E9%A2%84%E9%98%B2%E4%BC%A4%E5%AE%B3",
        },
        {
            "id": "safety-zh-cn-video",
            "kind": "video",
            "title": "预防儿童意外伤害",
            "publisher": "联合国儿童基金会中国",
            "language": "中文视频 · 简体中文页面",
            "locales": ["zh-CN"],
            "description": "用常见家庭场景讲解如何提前识别并减少儿童意外伤害风险。",
            "url": "https://www.unicef.cn/videos/prevent-injury-children",
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
            "locales": ["en", "es"]
            if resource["id"] in _MULTILINGUAL_ENGLISH_RESOURCE_IDS
            else ["en"],
        }
        for resource in _card.get("resources", [])
    ]
    _card["resources"] = [
        *_LOCALIZED_RESOURCES_BY_CARD_ID.get(_card["id"], []),
        *_reviewed_english_resources,
    ]


LEARNING_CONTENT_BY_ID = {card["id"]: card for card in LEARNING_CONTENT_CARDS}
