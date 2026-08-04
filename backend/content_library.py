"""Reviewed fallback content used by the personalized home feed.

These links are the safe, instant fallback for the conversation-aware web
research path.  Dynamic resources are validated separately and never mutate
this reviewed library.
"""

import re
from urllib.parse import urlparse


# Runtime source policy shared by dynamic research and delivery packaging.
# Entries are intentionally institution-scoped. Consumer portals and social
# platforms never appear here: those require an individually reviewed URL or
# the stronger creator/case checks in ``content_research``.
SOURCE_PARENT_ORG_DOMAINS = (
    ("harvard_center_developing_child", ("developingchild.harvard.edu",)),
    ("stanford_center_early_childhood", ("earlychildhood.stanford.edu", "med.stanford.edu")),
    ("american_academy_of_pediatrics", ("healthychildren.org", "aap.org", "aappublications.org", "pediatrics.org")),
    ("cdc", ("cdc.gov",)),
    ("nih_hhs", ("nih.gov",)),
    ("medlineplus", ("medlineplus.gov",)),
    ("world_health_organization", ("who.int",)),
    ("unicef", ("unicef.org", "unicef.cn")),
    ("us_head_start", ("headstart.gov",)),
    ("mayo_clinic", ("mayoclinic.org",)),
    ("sickkids_toronto", ("aboutkidshealth.ca", "sickkids.ca")),
    ("royal_childrens_hospital_melbourne", ("rch.org.au",)),
    ("british_columbia_healthlinkbc", ("healthlinkbc.ca",)),
    ("raising_children_network", ("raisingchildren.net.au",)),
    ("cochrane", ("cochrane.org",)),
    ("nhs_england", ("nhs.uk",)),
    ("nemours_childrens_health", ("kidshealth.org",)),
    ("zero_to_three", ("zerotothree.org",)),
    ("child_mind_institute", ("childmind.org",)),
    ("seattle_childrens", ("seattlechildrens.org",)),
    ("pathways_foundation", ("pathways.org",)),
    ("understood_org", ("understood.org",)),
    ("sesame_workshop", ("sesameworkshop.org",)),
    ("vroom_bezos_family_foundation", ("vroom.org",)),
    ("wee_talkers", ("weetalkers.com",)),
    ("pedsdoctalk", ("pedsdoctalk.com",)),
    ("emma_hubbard_brightest_beginning", ("brightestbeginning.com",)),
    ("asha", ("asha.org",)),
    ("childrens_hospital_of_philadelphia", ("chop.edu",)),
    ("jama_network", ("jamanetwork.com",)),
    ("bmj", ("bmj.com",)),
    ("lancet", ("thelancet.com",)),
    ("nature_portfolio", ("nature.com",)),
    ("elsevier_sciencedirect", ("sciencedirect.com",)),
    ("springer_nature", ("springer.com",)),
    ("university_of_washington", ("washington.edu", "uw.edu")),
    ("university_of_michigan", ("umich.edu",)),
    ("yale_university", ("yale.edu",)),
    ("university_of_california_berkeley", ("berkeley.edu",)),
    ("university_of_oxford", ("ox.ac.uk",)),
    ("university_of_cambridge", ("cam.ac.uk",)),
    ("university_college_london", ("ucl.ac.uk",)),
    ("university_of_toronto", ("utoronto.ca",)),
    ("university_of_british_columbia", ("ubc.ca",)),
    ("university_of_sydney", ("sydney.edu.au",)),
    ("university_of_melbourne", ("unimelb.edu.au",)),
    ("university_of_hong_kong", ("hku.hk",)),
    ("chinese_university_hong_kong", ("cuhk.edu.hk",)),
    ("tw_sfaa_parenting", ("sfaa.gov.tw",)),
    ("tw_hpa", ("hpa.gov.tw",)),
    ("tw_mohw", ("mohw.gov.tw",)),
    ("tw_moe_familyedu", ("familyedu.moe.gov.tw",)),
    ("ntuh", ("ntuh.gov.tw",)),
    ("taipei_veterans", ("vghtpe.gov.tw",)),
    ("taiwan_pediatric_association", ("pediatr.org.tw",)),
    ("hk_fhs", ("fhs.gov.hk",)),
    ("hk_education_bureau", ("parent.edu.hk",)),
    ("hk_hospital_authority", ("ha.org.hk",)),
    ("capital_childrens_medical_center", ("shouer.com.cn",)),
    ("beijing_childrens", ("bch.com.cn", "bch-yl.54doctor.net")),
    ("fudan_childrens", ("ch.shmu.edu.cn",)),
    ("shanghai_childrens", ("shchildren.com.cn",)),
    ("shanghai_childrens_medical_center", ("scmc.com.cn",)),
    ("guangzhou_women_children", ("gzfezx.com", "gzfezx.net", "wjw.gz.gov.cn")),
    ("shenzhen_childrens", ("szkid.com.cn",)),
    ("shenzhen_mch", ("szmch.net.cn",)),
    ("zhejiang_childrens", ("zjuch.cn", "ncrcch.org.cn")),
    ("scmc_guizhou", ("scmcgz.cn",)),
    ("new_york_state_health", ("health.ny.gov",)),
)

AUTHORITY_SOURCE_PARENT_ORG_IDS = frozenset(
    {
        org_id
        for org_id, _domains in SOURCE_PARENT_ORG_DOMAINS
        if org_id
        not in {
            "raising_children_network",
            "nemours_childrens_health",
            "zero_to_three",
            "child_mind_institute",
            "pathways_foundation",
            "understood_org",
            "sesame_workshop",
            "vroom_bezos_family_foundation",
            "wee_talkers",
            "pedsdoctalk",
            "emma_hubbard_brightest_beginning",
        }
    }
)

US_AUTHORITY_SOURCE_PARENT_ORG_IDS = frozenset(
    {
        "american_academy_of_pediatrics",
        "cdc",
        "nih_hhs",
        "medlineplus",
        "harvard_center_developing_child",
        "stanford_center_early_childhood",
        "us_head_start",
        "mayo_clinic",
        "asha",
        "childrens_hospital_of_philadelphia",
        "seattle_childrens",
        "jama_network",
        "university_of_washington",
        "university_of_michigan",
        "yale_university",
        "university_of_california_berkeley",
        "new_york_state_health",
    }
)

# For Simplified-Chinese delivery NURI intentionally starts with the strongest
# English-language primary evidence, then adds a Chinese in-product guide.  The
# external destination remains the institution's original page; it is never
# presented as an official Chinese translation.  Keeping this as an explicit
# machine-readable set makes the whitelist drive candidate discovery and final
# publication instead of acting only as a post-search URL validator.
ENGLISH_AUTHORITY_SOURCE_PARENT_ORG_IDS = frozenset(
    {
        *US_AUTHORITY_SOURCE_PARENT_ORG_IDS,
        "world_health_organization",
        "unicef",
        "cochrane",
        "sickkids_toronto",
        "royal_childrens_hospital_melbourne",
        "british_columbia_healthlinkbc",
        "university_of_oxford",
        "university_of_cambridge",
        "university_college_london",
        "university_of_toronto",
        "university_of_british_columbia",
        "university_of_sydney",
        "university_of_melbourne",
    }
)

FEATURED_SOURCE_PARENT_ORG_IDS = frozenset(
    {
        "raising_children_network",
        "nemours_childrens_health",
        "zero_to_three",
        "child_mind_institute",
        "pathways_foundation",
        "understood_org",
        "sesame_workshop",
        "vroom_bezos_family_foundation",
        "wee_talkers",
        "pedsdoctalk",
        "emma_hubbard_brightest_beginning",
    }
)


def source_domains_for_parent_orgs(parent_org_ids: set[str] | frozenset[str]) -> tuple[str, ...]:
    """Return deterministic discovery domains for an approved organization set."""

    return tuple(
        dict.fromkeys(
            domain
            for org_id, domains in SOURCE_PARENT_ORG_DOMAINS
            if org_id in parent_org_ids
            for domain in domains
        )
    )

_PARENT_ORG_PUBLISHER_ALIASES = (
    ("american_academy_of_pediatrics", ("american academy of pediatrics", "美国儿科学会", "美國兒科學會", "aap")),
    ("cdc", ("centers for disease control", "美国疾病控制与预防中心", "美國疾病管制與預防中心", "cdc")),
    ("unicef", ("unicef", "联合国儿童基金会", "聯合國兒童基金會")),
    ("world_health_organization", ("world health organization", "世界卫生组织", "世界衛生組織", "who")),
    ("harvard_center_developing_child", ("harvard center on the developing child", "哈佛大学儿童发展中心", "哈佛大學兒童發展中心")),
    ("raising_children_network", ("raising children network",)),
    ("zero_to_three", ("zero to three",)),
    ("pathways_foundation", ("pathways.org", "pathways")),
    ("vroom_bezos_family_foundation", ("vroom", "bezos family foundation")),
    ("mayo_clinic", ("mayo clinic", "妙佑医疗", "妙佑醫療")),
    ("sickkids_toronto", ("sickkids", "aboutkidshealth")),
    ("royal_childrens_hospital_melbourne", ("royal children's hospital", "royal childrens hospital")),
    ("tw_sfaa_parenting", ("育儿亲职网", "育兒親職網", "社会及家庭署", "社會及家庭署")),
    ("tw_hpa", ("国民健康署", "國民健康署")),
    ("tw_mohw", ("台湾卫生福利部", "臺灣衛生福利部", "台灣衛生福利部")),
    ("hk_fhs", ("家庭健康服务", "家庭健康服務", "family health service")),
)


def _source_hostname(url: object) -> str:
    try:
        parsed = urlparse(str(url or ""))
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    if (
        parsed.scheme.casefold() != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or port not in (None, 443)
    ):
        return ""
    hostname = parsed.hostname.casefold().rstrip(".")
    return hostname[4:] if hostname.startswith("www.") else hostname


def source_parent_org_id(url: object) -> str:
    """Map a reviewed institution domain or subdomain to one stable org id."""

    hostname = _source_hostname(url)
    if not hostname:
        return ""
    for org_id, domains in SOURCE_PARENT_ORG_DOMAINS:
        if any(hostname == domain or hostname.endswith(f".{domain}") for domain in domains):
            return org_id
    return ""


def resource_parent_org_id(resource: dict) -> str:
    """Resolve one source identity across languages, subdomains and video hosts."""

    for field in (
        "url",
        "evidence_url",
        "authority_evidence_url",
        "publisher_evidence_url",
        "source_evidence_url",
    ):
        if org_id := source_parent_org_id(resource.get(field)):
            return org_id
    publisher = re.sub(
        r"\s+", " ", str(resource.get("publisher") or "").casefold()
    ).strip()
    for org_id, aliases in _PARENT_ORG_PUBLISHER_ALIASES:
        if any(alias.casefold() in publisher for alias in aliases):
            return org_id
    publisher_key = re.sub(r"[^0-9a-z\u3400-\u9fff]+", "", publisher)[:120]
    hostname = _source_hostname(resource.get("url"))
    social_hosts = {
        "youtube.com",
        "youtu.be",
        "bilibili.com",
        "douyin.com",
        "iesdouyin.com",
        "kuaishou.com",
        "xiaohongshu.com",
        "weibo.com",
    }
    if hostname in social_hosts or any(
        hostname.endswith(f".{host}") for host in social_hosts
    ):
        # A shared platform is not an organization. The visible, validated
        # creator/publisher identity is the only safe deterministic fallback.
        return f"publisher:{publisher_key}" if publisher_key else ""
    if hostname:
        return f"host:{hostname}"
    return f"publisher:{publisher_key}" if publisher_key else ""

TAIWAN_AUTHORITY_RESOURCE_HOSTS = frozenset(
    {
        "babyedu.sfaa.gov.tw",
        "epaper.ntuh.gov.tw",
        "wd.vghtpe.gov.tw",
        "wellbeing.mohw.gov.tw",
        "www.cmuh.org.tw",
        "www.hch.gov.tw",
        "www.hpa.gov.tw",
        "www.mohw.gov.tw",
    }
)

TAIWAN_CURATED_RESOURCE_HOSTS = frozenset(
    {
        "kidaid.org.tw",
        "mummy.com.tw",
        "www.cylaw.org.tw",
        "www.mommycarry.com",
        "mamilove.com.tw",
        "www.pwr.org.tw",
        "www.mombaby.com.tw",
        "www.parenting.com.tw",
        "www.ptt.cc",
        "mamibuy.com.tw",
    }
)

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
        "fhs.gov.hk",
        "www.fhs.gov.hk",
        "raisingchildren.net.au",
        "www.raisingchildren.net.au",
        *TAIWAN_AUTHORITY_RESOURCE_HOSTS,
    }
)

# Broad user-generated and health-aggregator domains are deliberately not host
# allowlisted. These exact pages were individually opened and reviewed for this
# topic, so only the reviewed URL (not every page on the same host) is trusted.
REVIEWED_EXACT_RESOURCE_URLS = frozenset(
    {
        "https://www.mayoclinic.org/zh-hans/healthy-lifestyle/infant-and-toddler-health/in-depth/infant-development/art-20047380",
        "https://www.unicef.cn/videos/ecd-master-class-brain-development-ep02-first",
        "https://www.mama.cn/baby/yinger/article/793653.html",
        "https://www.bilibili.com/video/BV17r4y1x7Hu",
        "https://blog.sina.com.cn/s/blog_5de106b10101m3y8.html",
        "https://www.bilibili.com/video/BV1U84y1271F",
        "https://www.unicef.cn/parenting-site/3-ways-parents-can-make-their-babies-smarter",
        "https://www.unicef.cn/parenting-site/how-talk-your-baby",
        "https://www.unicef.cn/videos/how-to-responsive-care",
        "https://www.unicef.cn/videos/how-to-guide-your-children-to-learn-through-play",
        "https://www.unicef.cn/stories/grandmothers-journey-raising-left-behind-children",
        "https://www.unicef.cn/videos/grandmother-zhang-qin-learns-responsive-care",
    }
)

SUPPORTED_RESOURCE_LOCALES = frozenset({"zh-CN", "zh-TW", "en", "es"})
CONTENT_CATEGORIES = ("authority", "featured", "case")


def is_reviewed_exact_resource_url(url: str) -> bool:
    """Return whether this exact destination, not merely its host, was reviewed."""

    try:
        parsed = urlparse(url)
    except (TypeError, ValueError):
        return False
    normalized_url = parsed._replace(fragment="").geturl().rstrip("/")
    return parsed.scheme == "https" and normalized_url in REVIEWED_EXACT_RESOURCE_URLS


def is_trusted_resource_url(url: str) -> bool:
    """Return True only for reviewed HTTPS publisher domains."""

    try:
        parsed = urlparse(url)
    except (TypeError, ValueError):
        return False
    normalized_url = parsed._replace(fragment="").geturl().rstrip("/")
    return parsed.scheme == "https" and (
        (parsed.hostname or "").lower() in TRUSTED_RESOURCE_HOSTS
        or is_reviewed_exact_resource_url(normalized_url)
        or normalized_url in globals().get("REVIEWED_LIBRARY_RESOURCE_URLS", ())
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
        ("authority", "video"): 1,
        ("featured", "article"): 2,
        ("featured", "video"): 3,
        ("case", "article"): 4,
        ("case", "video"): 5,
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
                    str(
                        resource.get("content_category")
                        or (
                            "featured"
                            if resource.get("source_tier") == "curated"
                            else "authority"
                        )
                    ),
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
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "发布页与影片标题明确标注普通话版本。",
            "script_language": "zh-Hans",
            "description": "示范如何依宝宝的特性安排固定、平静而可重复的睡前步骤。",
            "url": "https://www.fhs.gov.hk/sc_chi/mulit_med/000015.html",
        },
        {
            "id": "sleep-zh-tw-article",
            "kind": "article",
            "title": "若要小孩好好睡，睡前儀式很重要",
            "publisher": "臺灣衛生福利部 · 心快活心理健康學習平台",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "依年齡說明睡眠需求，並提供固定時間、固定步驟與安靜活動等睡前儀式建議。",
            "url": "https://wellbeing.mohw.gov.tw/nor/pstunt/1/779",
        },
        {
            "id": "sleep-zh-tw-video",
            "kind": "video",
            "title": "讓寶貝們好好睡覺",
            "publisher": "臺灣衛生福利部社會及家庭署 · 育兒親職網",
            "language": "華語影音課 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "面向零至二歲照顧者，介紹寶寶作息、哭鬧與建立睡前儀式的方法。",
            "url": "https://babyedu.sfaa.gov.tw/info/10000254?lang=Big5",
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
            "title": "玩游戏解情绪：帮助宝宝认识与表达自己的情绪",
            "publisher": "台湾卫生福利部社会及家庭署 · 育儿亲职网",
            "language": "普通话影音课 · 台湾繁体页面",
            "locales": ["zh-CN"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "台湾卫福部育儿亲职网华语课程。",
            "script_language": "zh-Hant",
            "description": "用亲子游戏示范情绪觉察、理解、表达与调节。",
            "url": "https://babyedu.sfaa.gov.tw/info/10000213",
        },
        {
            "id": "emotion-zh-tw-article",
            "kind": "article",
            "title": "一起來想想，我們如何回應孩子的心情？",
            "publisher": "國立臺灣大學醫學院附設醫院臨床心理中心",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "由臨床心理師說明如何注意、命名並回應孩子的感受，逐步支持情緒理解與調節。",
            "url": "https://epaper.ntuh.gov.tw/health/202507/child_1.html",
        },
        {
            "id": "emotion-zh-tw-video",
            "kind": "video",
            "title": "玩遊戲解情緒：幫助寶寶認識與表達自己的情緒",
            "publisher": "臺灣衛生福利部社會及家庭署 · 育兒親職網",
            "language": "華語影音課 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "以親子遊戲示範情緒覺察、理解、表達與調節，適合零至二歲照顧者。",
            "url": "https://babyedu.sfaa.gov.tw/info/10000213",
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
            "title": "一岁宝宝本事多：建立良好饮食习惯",
            "publisher": "台湾卫生福利部社会及家庭署 · 育儿亲职网",
            "language": "普通话影音课 · 台湾繁体页面",
            "locales": ["zh-CN"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "台湾卫福部育儿亲职网华语课程。",
            "script_language": "zh-Hant",
            "description": "介绍规律用餐、降低压力并培养幼儿自主进食的方法。",
            "url": "https://babyedu.sfaa.gov.tw/info/10000131?lang=Big5",
        },
        {
            "id": "food-zh-tw-article",
            "kind": "article",
            "title": "幼兒偏食行為",
            "publisher": "中國醫藥大學附設醫院臨床營養科",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "說明偏食的判定與原因，並提供規律進餐、愉快氣氛、食物多樣化與避免強迫等家庭方法。",
            "url": "https://www.cmuh.org.tw/HealthEdus/Detail?no=5466",
        },
        {
            "id": "food-zh-tw-video",
            "kind": "video",
            "title": "一歲寶貝本事多",
            "publisher": "臺灣衛生福利部社會及家庭署 · 育兒親職網",
            "language": "華語影音課 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "面向一至二歲家庭，介紹規律用餐、健康飲食與培養孩子自主進食的方法。",
            "url": "https://babyedu.sfaa.gov.tw/info/10000131?lang=Big5",
        },
    ],
    "learn_development_milestones": [
        {
            "id": "development-zh-cn-article",
            "kind": "article",
            "title": "婴儿发育：10 到 12 月龄的发育里程碑",
            "publisher": "妙佑医疗国际（Mayo Clinic）",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "source_region": "US",
            "script_language": "zh-Hans",
            "age_range_months": [10, 12],
            "focus_tags": ["关键期", "里程碑", "发育"],
            "description": "直接对应 10 至 12 月龄，涵盖爬行、扶站、手眼协调、语言、认知、安全环境和需要咨询医生的信号。",
            "url": "https://www.mayoclinic.org/zh-hans/healthy-lifestyle/infant-and-toddler-health/in-depth/infant-development/art-20047380",
        },
        {
            "id": "development-zh-cn-video",
            "kind": "video",
            "title": "大脑发育主题第二期：理解 0—3 岁能力发展的关键阶段",
            "publisher": "联合国儿童基金会",
            "language": "普通话视频 · 简体中文页面",
            "locales": ["zh-CN"],
            "source_region": "INTL",
            "script_language": "zh-Hans",
            "age_range_months": [0, 36],
            "focus_tags": ["关键期", "大脑发育", "回应式互动"],
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "联合国儿童基金会中文节目页面及普通话节目音轨已人工核验。",
            "description": "专家结合家长代表说明 0 至 3 岁大脑发育、阶段性行为、回应宝宝信号与日常陪伴。",
            "url": "https://www.unicef.cn/videos/ecd-master-class-brain-development-ep02-first",
        },
        {
            "id": "development-zh-tw-article",
            "kind": "article",
            "title": "兒童發展篩檢量表",
            "publisher": "臺灣衛生福利部國民健康署",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "提供六至九個月、九至十二個月等台灣本土化篩檢量表，觀察動作、語言認知與社會發展。",
            "url": "https://www.hpa.gov.tw/Pages/List.aspx?nodeid=4821",
        },
        {
            "id": "development-zh-tw-video",
            "kind": "video",
            "title": "寶貝成長路，檢前先紀錄：四個月至十個月篇",
            "publisher": "臺灣衛生福利部國民健康署官方頻道",
            "language": "華語影片 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "引導家長在健檢前觀察並記錄四至十個月嬰兒的成長表現，再與醫護人員討論。",
            "url": "https://www.youtube.com/watch?v=wG2wh9b3X8I",
        },
    ],
    "learn_language_milestones": [
        {
            "id": "language-zh-tw-article",
            "kind": "article",
            "title": "一至二歲兒童語言發展",
            "publisher": "臺北榮民總醫院兒童發展評估中心",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "整理一至二歲的理解、表達、兩字句與手勢溝通表現，並列出警訊和家庭促進策略。",
            "url": "https://wd.vghtpe.gov.tw/PMREIP/files/%E8%A1%9B%E6%95%99%E5%96%AE/ST/3%201-2.pdf",
        },
        {
            "id": "language-zh-tw-video",
            "kind": "video",
            "title": "兒童語言發展里程 0–2 歲",
            "publisher": "埔里基督教醫院 · 小星星協奏曲",
            "language": "華語衛教影片 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "由醫院專業團隊介紹零至二歲從咿呀學語到用語言回答問題的溝通發展歷程。",
            "url": "https://www.youtube.com/watch?v=EtfYKMI6At8",
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
            "title": "安全依附关系的正向教养策略",
            "publisher": "台湾卫生福利部社会及家庭署 · 育儿亲职网",
            "language": "普通话影音课 · 台湾繁体页面",
            "locales": ["zh-CN"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "台湾卫福部育儿亲职网华语课程。",
            "script_language": "zh-Hant",
            "description": "说明如何以安全依附、清楚边界和一致回应支持幼儿行为发展。",
            "url": "https://babyedu.sfaa.gov.tw/info/10000165?lang=Big5",
        },
        {
            "id": "behavior-zh-tw-article",
            "kind": "article",
            "title": "用愛陪伴孩子成長：談「正向教養」",
            "publisher": "國立臺灣大學醫學院附設醫院新竹臺大分院",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "由早療中心臨床心理師說明如何同理情緒，同時用溫和且堅定的方式建立原則與規範。",
            "url": "https://www.hch.gov.tw/?aid=626&iid=430&page_name=detail&pid=57",
        },
        {
            "id": "behavior-zh-tw-video",
            "kind": "video",
            "title": "安全依附關係的正向教養策略",
            "publisher": "臺灣衛生福利部社會及家庭署 · 育兒親職網",
            "language": "華語影音課 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "面向零至二歲照顧者，示範在哭鬧、黏人和分離焦慮中保持安全感與正向教養。",
            "url": "https://babyedu.sfaa.gov.tw/info/10000165?lang=Big5",
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
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "发布页与影片标题明确标注普通话版本。",
            "script_language": "zh-Hans",
            "description": "用照顾情境示范观察、回应和来回互动的亲子沟通。",
            "url": "https://www.fhs.gov.hk/sc_chi/mulit_med/000025.html",
        },
        {
            "id": "connection-zh-tw-article",
            "kind": "article",
            "title": "用愛說故事，親子共讀從零歲開始",
            "publisher": "臺灣衛生福利部國民健康署",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "說明如何用聲音、表情與對話式共讀形成親子來回互動，促進親密感和語言發展。",
            "url": "https://www.mohw.gov.tw/cp-16-48967-1.html",
        },
        {
            "id": "connection-zh-tw-video",
            "kind": "video",
            "title": "親子互動秘笈 1：怎麼樣「互動」最好？",
            "publisher": "臺灣衛生福利部社會及家庭署 · 育兒親職網",
            "language": "華語影音課 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "面向零至二歲照顧者，示範互動環境、溝通、感官遊戲與來回回應的原則。",
            "url": "https://babyedu.sfaa.gov.tw/info/10000138?lang=Big5",
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
            "title": "婴幼儿居家安全",
            "publisher": "台湾云林县卫生局保健科",
            "language": "普通话宣导视频 · 台湾繁体字幕",
            "locales": ["zh-CN"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "台湾云林县卫生局官方华语宣导影片。",
            "script_language": "zh-Hant",
            "description": "提醒照顾者收好药品、绳索和电线，并固定可能倾倒的家具。",
            "url": "https://www.youtube.com/watch?v=LKFMv_pCFlQ",
        },
        {
            "id": "safety-zh-tw-article",
            "kind": "article",
            "title": "守護寶貝安全，家長停看聽",
            "publisher": "臺灣衛生福利部",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "依零至四歲年齡整理藥品、插座、防滑、防墜、窒息、家具與乘車等常見風險。",
            "url": "https://www.mohw.gov.tw/cp-3159-24414-1.html",
        },
        {
            "id": "safety-zh-tw-video",
            "kind": "video",
            "title": "嬰幼兒居家安全",
            "publisher": "臺灣雲林縣衛生局保健科",
            "language": "華語宣導影片 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "用短片提醒照顧者將藥品上鎖、收好繩索與電線，並固定可能傾倒的家具。",
            "url": "https://www.youtube.com/watch?v=LKFMv_pCFlQ",
        },
    ],
    "learn_serve_and_return_reviewed": [
        {
            "id": "connection-unicef-featured-article-zh-cn",
            "kind": "article",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_and_audience",
            "title": "通过游戏促进宝宝大脑发育",
            "publisher": "联合国儿童基金会",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "source_region": "INTL",
            "script_language": "zh-Hans",
            "description": "把“你来我往”的回应式互动放进喂食、换衣、洗澡和游戏等日常时刻。",
            "trust_note": "联合国儿童基金会育儿内容，由儿童发展专家解释亲子游戏与大脑发育。",
            "recognition": "国际儿童机构 · 简体中文专业导读",
            "selection_reason": "讲解清楚、场景具体，忙碌家长也能立刻挑一个日常片段开始练习。",
            "url": "https://www.unicef.cn/parenting-site/3-ways-parents-can-make-their-babies-smarter",
        },
        {
            "id": "connection-unicef-featured-video-zh-cn",
            "kind": "video",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_and_audience",
            "title": "观察孩子的需求，并给予积极的回应",
            "publisher": "联合国儿童基金会",
            "language": "普通话视频 · 简体中文",
            "locales": ["zh-CN"],
            "source_region": "INTL",
            "script_language": "zh-Hans",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "联合国儿童基金会简体中文发布页及普通话养育照护视频。",
            "description": "用短片说明如何观察婴幼儿的动作、声音与表情，并及时作出积极回应。",
            "trust_note": "联合国儿童基金会养育照护系列视频；普通话与简体中文页面均已核验。",
            "recognition": "国际儿童机构 · 普通话短视频",
            "selection_reason": "短、直观，能先看到回应式陪伴在真实照护动作中是什么样子。",
            "url": "https://www.unicef.cn/videos/how-to-responsive-care",
        },
        {
            "id": "connection-zhang-qin-case-article-zh-cn",
            "kind": "article",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "张琴奶奶的回应性照护实践：忙碌生活里怎样陪三个孩子",
            "publisher": "联合国儿童基金会 · 真实家庭故事",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "source_region": "INTL",
            "script_language": "zh-Hans",
            "description": "一位同时务农并照顾三个孙辈的奶奶，记录她如何把交谈、唱歌、搭积木和具体鼓励放进日常。",
            "trust_note": "联合国儿童基金会记录的真实家庭经历；案例用于理解实践过程，不代表适合所有家庭。",
            "recognition": "经机构采访核实的真实照护者故事",
            "selection_reason": "和“工作忙、陪伴时间少”的情境接近，能看到照护者如何从很小的互动开始改变。",
            "case_evidence": "文章以张琴奶奶及其三个孙辈为主角，记录家庭照护、农活与养育小组中的真实实践。",
            "case_evidence_url": "https://www.unicef.cn/stories/grandmothers-journey-raising-left-behind-children",
            "url": "https://www.unicef.cn/stories/grandmothers-journey-raising-left-behind-children",
        },
        {
            "id": "connection-zhang-qin-case-video-zh-cn",
            "kind": "video",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "张琴奶奶学习回应性照护的真实历程",
            "publisher": "联合国儿童基金会 · 真实家庭视频",
            "language": "普通话视频 · 简体中文",
            "locales": ["zh-CN"],
            "source_region": "INTL",
            "script_language": "zh-Hans",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "联合国儿童基金会中文页面发布的家庭采访视频，主要口语为普通话。",
            "description": "跟随一位贵州奶奶，看她如何在照顾孙辈的日常里练习交谈、鼓励、讲故事和玩耍。",
            "trust_note": "真实家庭采访与项目记录；不是表演示范，也不替代个别发展评估。",
            "recognition": "真实照护者案例 · 普通话视频",
            "selection_reason": "保留了忙碌、疲惫和逐步练习的真实感，比理想化示范更容易代入。",
            "case_evidence": "视频由张琴奶奶与孙辈真实出镜，记录其参加回应性照护支持后的家庭实践。",
            "case_evidence_url": "https://www.unicef.cn/videos/grandmother-zhang-qin-learns-responsive-care",
            "url": "https://www.unicef.cn/videos/grandmother-zhang-qin-learns-responsive-care",
        },
        {
            "id": "connection-cylaw-featured-article",
            "kind": "article",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_reviewed",
            "title": "改變世界的躲貓貓遊戲：理解孩子的回應式互動",
            "publisher": "兒少權益網 · 兒福聯盟",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "以躲貓貓等日常互動解釋 Serve and Return，幫助照顧者理解回應孩子訊號的重要性。",
            "trust_note": "台灣兒少權益倡議平台的專業導讀，並連結原始 TED 內容；不是醫療診斷。",
            "recognition": "兒少專業機構導讀 · 家庭情境清楚",
            "selection_reason": "把抽象的回應式互動轉成家長每天都能辨認和練習的小片段。",
            "url": "https://www.cylaw.org.tw/about/advocacy/10/566",
        },
        {
            "id": "connection-wanling-featured-video",
            "kind": "video",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_and_audience",
            "title": "在家玩什麼？一到六歲孩子發展遊戲",
            "publisher": "育兒教養經 · 創業系媽媽婉翎",
            "language": "普通話視頻 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "已人工聽檢實際音軌，確認為台灣普通話，未發現粵語。",
            "description": "使用家中常見物品，按年齡示範能促進輪流、語言和親子連結的互動遊戲。",
            "trust_note": "長期育兒創作者的實作示範；口語已人工核驗，不作發展診斷。",
            "recognition": "實作型育兒內容 · 約 1.1 萬次觀看（2026-07 核驗）",
            "selection_reason": "示範具體，家長看完就能挑一個遊戲和孩子開始互動。",
            "url": "https://www.youtube.com/watch?v=6oEc7lrSTeA",
        },
        {
            "id": "connection-mommycarry-parent-case-article",
            "kind": "article",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "新手爸媽必學：0–1 歲寶寶親子互動遊戲",
            "publisher": "媽咪凱瑞 MommyCarry",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "description": "母親以自己夫妻與寶寶的經歷，按月齡分享觸摸、聲音、躲貓貓等家庭互動。",
            "trust_note": "公開第一人稱家庭經驗；不作發展評估或普遍效果證據。",
            "recognition": "真實新手父母經驗",
            "selection_reason": "能看到一個家庭如何把互動放進換尿布、玩耍等真實日常。",
            "case_evidence": "作者以母親第一人稱描述自己、丈夫與寶寶按月齡實際玩過的遊戲。",
            "case_evidence_url": "https://www.mommycarry.com/?p=1400",
            "url": "https://www.mommycarry.com/?p=1400",
        },
        {
            "id": "connection-peter-parent-case-video",
            "kind": "video",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "一歲孩子挑戰背後畫畫遊戲：真實親子互動",
            "publisher": "彼得爸與蘇珊媽",
            "language": "普通話視頻 · 台灣",
            "locales": ["zh-TW"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "已人工聽檢實際音軌，確認為台灣普通話，未發現粵語。",
            "description": "一家人實際玩背後畫畫與猜圖遊戲，呈現孩子怎麼觀察、回應和輪流。",
            "trust_note": "公開真實家庭互動；是生活案例，不作發展標準或效果保證。",
            "recognition": "真實家庭頻道 · 約 5.6 萬次觀看（2026-07 核驗）",
            "selection_reason": "保留孩子不按腳本反應的真實感，方便家長理解互動重點而非追求完美。",
            "case_evidence": "影片由父母與孩子共同出鏡，完整呈現家庭遊戲過程。",
            "case_evidence_url": "https://www.youtube.com/watch?v=j50rZljX8XI",
            "url": "https://www.youtube.com/watch?v=j50rZljX8XI",
        },
    ],
    "learn_home_safety_reviewed": [
        {
            "id": "safety-mamilove-featured-article",
            "kind": "article",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_and_audience",
            "title": "兒童六成意外都在家：打造居家安全環境",
            "publisher": "媽咪愛 · 靖娟兒童安全文教基金會專業意見",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "description": "依幼兒常見居家風險逐區檢查跌落、夾傷、燙傷與誤食，並提供環境調整方法。",
            "trust_note": "親子平台採訪整理，引用台灣兒童安全基金會專業意見；不是官方標準原文。",
            "recognition": "專家審閱導向 · 約 5,000 次閱讀（2026-07 核驗）",
            "selection_reason": "按家中空間整理風險，家長可以拿著文章逐區巡一遍。",
            "url": "https://mamilove.com.tw/articles/1252",
        },
        {
            "id": "safety-pwr-featured-video",
            "kind": "video",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_reviewed",
            "title": "打造居家托育空間：實際案例通過安全檢核",
            "publisher": "彭婉如基金會",
            "language": "普通話視頻 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "已人工聽檢實際音軌，確認為台灣普通話，未發現粵語。",
            "description": "以真實空間示範托育環境安全檢核與改善，涵蓋家具固定、動線和危險物收納。",
            "trust_note": "台灣非營利托育專業組織製作，並有配套圖文說明；口語已人工核驗。",
            "recognition": "托育專業機構 · 現場檢核示範",
            "selection_reason": "透過改造前後的畫面，幫助家長辨認容易忽略的環境風險。",
            "url": "https://www.youtube.com/watch?v=ZnoLd3-fCl0",
        },
        {
            "id": "safety-mamibuy-gate-parent-case-article",
            "kind": "article",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "兩款安全門欄實際使用分享",
            "publisher": "MamiBuy · 初熟媽媽 Susan",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "description": "母親按自家樓梯與生活動線，記錄兩款門欄的安裝方式和數月使用經驗。",
            "trust_note": "公開第一人稱產品使用經驗；產品年代較早，應用來理解選擇思路，不替代現行安全標準。",
            "recognition": "約 1.7 萬次瀏覽、260+ 收藏（2026-07 核驗）",
            "selection_reason": "呈現家庭如何依實際格局取捨，而不是只有理想化的安全清單。",
            "case_evidence": "作者以母親第一人稱描述自家格局、安裝過程與長期使用感受。",
            "case_evidence_url": "https://mamibuy.com.tw/talk/article/50059/",
            "url": "https://mamibuy.com.tw/talk/article/50059/",
        },
        {
            "id": "safety-peter-bathroom-parent-case-video",
            "kind": "video",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "孩子浴室跌倒撞到頭：一家人的事故復盤",
            "publisher": "彼得爸與蘇珊媽",
            "language": "普通話視頻 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "已人工聽檢實際音軌，確認為台灣普通話，未發現粵語。",
            "description": "父母記錄孩子在浴室跌倒、就醫與事後反思；涉及受傷時仍應依當地醫療建議處理。",
            "trust_note": "真實家庭事故經驗與警示，不是急救或醫療建議。",
            "recognition": "真實家庭頻道 · 約 20.5 萬次觀看、2,000 次按讚（2026-07 核驗）",
            "selection_reason": "用真實後果提醒家長檢查濕滑地面與浴室動線，同時清楚區分經驗和醫療指引。",
            "case_evidence": "影片由父母記錄自己孩子在浴室跌倒、送醫和家庭復盤的完整經過。",
            "case_evidence_url": "https://www.youtube.com/watch?v=LqOQHq_n18M",
            "url": "https://www.youtube.com/watch?v=LqOQHq_n18M",
        },
    ],
}

_RAISING_CHILDREN_METADATA = {
    "publisher": "Raising Children Network（澳大利亚）",
    "source_tier": "curated",
    "content_category": "featured",
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

_REVIEWED_CHINESE_FALLBACK_RESOURCES_BY_CARD_ID = {
    "learn_sleep_routine": [
        {
            "id": "sleep-parenting-featured-article",
            "kind": "article",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_and_audience",
            "title": "寶寶多大能睡過夜？醫師教如何訓練、詳解嬰兒睡眠時間",
            "publisher": "親子天下",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "description": "由編輯整理兒科醫師與國際醫療來源，說明睡眠節奏、夜醒與睡前儀式。",
            "trust_note": "成熟親子媒體的署名編輯內容，引用兒科醫師與國際醫療來源；不是官方原文。",
            "recognition": "專家資料整理 · 家庭實操導向",
            "selection_reason": "能把睡前節奏與夜醒問題轉成容易執行的家庭步驟。",
            "url": "https://www.parenting.com.tw/article/5096297",
        },
        {
            "id": "sleep-huang-featured-video",
            "kind": "video",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_and_audience",
            "title": "讓寶寶睡好的祕訣是什麼？解答睡眠常見問題！",
            "publisher": "黃瑽寧醫師健康講堂",
            "language": "普通話視頻 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "已人工聽檢開頭音軌，確認為清晰普通話，未發現粵語。",
            "description": "兒科醫師用短講解答幼兒睡眠常見問題，包含作息和全家睡眠安排。",
            "trust_note": "兒科醫師本人講解；影片口語已人工核驗。",
            "recognition": "醫師專業頻道 · 約 23 萬次觀看（2026-07 核驗）",
            "selection_reason": "資訊密度高、容易看完，適合先理解睡眠問題的主要抓手。",
            "url": "https://www.youtube.com/watch?v=CnYahVdAcm0",
        },
        {
            "id": "sleep-ptt-parent-case-article",
            "kind": "article",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "[寶寶] 睡眠習慣建立經驗分享（上）",
            "publisher": "PTT BabyMother · 台灣家長",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "description": "一位母親交代女兒月齡、原始作息與一個月調整過程，並明確聲明只是個人經驗。",
            "trust_note": "公開第一人稱家長經驗；不作醫療或普遍效果證據。",
            "recognition": "真實父母經驗",
            "selection_reason": "可看到一個家庭如何記錄、調整與面對不完美的實際過程。",
            "case_evidence": "作者以母親第一人稱描述女兒的月齡、作息與調整歷程。",
            "case_evidence_url": "https://www.ptt.cc/bbs/BabyMother/M.1632016044.A.AE1.html",
            "url": "https://www.ptt.cc/bbs/BabyMother/M.1632016044.A.AE1.html",
        },
        {
            "id": "sleep-li-parent-case-video",
            "kind": "video",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "育兒心得分享：寶寶的睡眠作息、喝奶與副食品",
            "publisher": "李佳穎 · 台灣家長",
            "language": "普通話視頻 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "已人工聽檢開頭音軌，確認為普通話，未發現粵語。",
            "description": "母親分享孩子九個月時的睡眠、餵奶與副食品作息；影片含商業合作，需把經驗與推廣分開看。",
            "trust_note": "真實家長第一人稱分享，含商業合作；不作醫療結論。",
            "recognition": "公開家長頻道 · 約 1.7 萬次觀看（2026-07 核驗）",
            "selection_reason": "呈現真實家庭如何安排一天節奏，也坦白說明並非育兒專家。",
            "case_evidence": "發布者以母親身份介紹孩子月齡並分享自己的育兒日常。",
            "case_evidence_url": "https://www.youtube.com/watch?v=yxT5cQ_-qaA",
            "url": "https://www.youtube.com/watch?v=yxT5cQ_-qaA",
        },
    ],
    "learn_big_feelings": [
        {
            "id": "emotion-parenting-featured-article",
            "kind": "article",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_reviewed",
            "title": "小孩崩潰尖叫怎麼辦？羅寶鴻：四句訣正確處理幼兒尖叫",
            "publisher": "親子天下 · 羅寶鴻",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "description": "具幼教與正向教養背景的作者，用四個步驟處理幼兒尖叫與崩潰。",
            "trust_note": "署名專家文章；作者具 AMI 與正向教養家長講師背景。",
            "recognition": "專家方法 · 可直接操作",
            "selection_reason": "把情緒接納、界限和家長當下能說的話放在同一套流程裡。",
            "url": "https://www.parenting.com.tw/article/5087348",
        },
        {
            "id": "emotion-parenting-featured-video",
            "kind": "video",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_and_audience",
            "title": "我也知道要正向教養！但就是會有情緒啊！心理師給父母的情緒控制方法",
            "publisher": "親子天下 · 諮商心理師黃之盈",
            "language": "普通話視頻 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "已人工聽檢開頭音軌，確認為普通話，未發現粵語。",
            "description": "心理師從父母先冷靜開始，說明如何在孩子大情緒時避免失控升級。",
            "trust_note": "成熟親子媒體訪談諮商心理師；口語已人工核驗。",
            "recognition": "專業心理師講解 · 親子媒體製作",
            "selection_reason": "先照顧家長的情緒負荷，再談怎麼陪孩子，符合真實使用場景。",
            "url": "https://www.youtube.com/watch?v=mLpWc1mKEUk",
        },
        {
            "id": "emotion-mamibuy-parent-case-article",
            "kind": "article",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "1Y5M 起：邱言言人生第一個叛逆期，老母學會欣賞你的叛逆",
            "publisher": "MamiBuy · 雨立今（邱言言媽咪）",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "description": "母親記錄一歲五個月起的兩個月調整期、多個鬧情緒場景和自己的具體做法。",
            "trust_note": "公開第一人稱母親經驗；不作專業或普遍效果證據。",
            "recognition": "約 6,600 次瀏覽、100+ 收藏（2026-07 核驗）",
            "selection_reason": "能看到家長的情緒、試錯與孩子變化，而不只是抽象技巧。",
            "case_evidence": "作者以孩子母親身份記錄具體年齡、場景與兩個月調整歷程。",
            "case_evidence_url": "https://mamibuy.com.tw/talk/article/2876",
            "url": "https://mamibuy.com.tw/talk/article/2876",
        },
        {
            "id": "emotion-wanling-parent-case-video",
            "kind": "video",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "一到兩歲寶寶：幼兒叛逆期教養方法，面對鬧脾氣與愛說不要",
            "publisher": "創業系媽媽婉翎",
            "language": "普通話視頻 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "已人工聽檢開頭音軌，確認為普通話，未發現粵語。",
            "description": "母親以自己一歲半雙胞胎的哭鬧、躺地與說不要為例，分享家庭做法。",
            "trust_note": "真實母親第一人稱經驗；不作醫療或唯一教養答案。",
            "recognition": "長期育兒創作者 · 約 7,000 次觀看（2026-07 核驗）",
            "selection_reason": "具體呈現家庭衝突場景與家長如何回應，容易對照自己的情況。",
            "case_evidence": "發布者明確以母親身份介紹一歲半雙胞胎的真實行為與做法。",
            "case_evidence_url": "https://www.youtube.com/watch?v=Z8EHP_znnVo",
            "url": "https://www.youtube.com/watch?v=Z8EHP_znnVo",
        },
    ],
    "learn_picky_eating": [
        {
            "id": "food-mombaby-featured-article",
            "kind": "article",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_reviewed",
            "title": "寶寶不愛吃飯的 5 大原因！營養師提供胃口大開 8 招",
            "publisher": "媽媽寶寶 · 營養師徐裴莉",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "description": "由醫院營養師受訪，說明常見原因、降低挑食機會和可執行的用餐方法。",
            "trust_note": "成熟親子媒體的專業營養師訪談；不是醫院官方原文。",
            "recognition": "專業營養師受訪 · 編輯整理",
            "selection_reason": "同時涵蓋原因判斷和八個可操作方法，適合家庭逐項嘗試。",
            "url": "https://www.mombaby.com.tw/articles/5509",
        },
        {
            "id": "food-huang-featured-video",
            "kind": "video",
            "content_category": "featured",
            "source_tier": "curated",
            "selection_basis": "expert_and_audience",
            "title": "小孩不肯乖乖吃飯：挑食、生理問題與化解餐桌衝突的四金句",
            "publisher": "黃瑽寧愛+好醫生",
            "language": "普通話視頻 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "已人工聽檢開頭音軌，確認為普通話，未發現粵語。",
            "description": "兒科醫師與專業來賓討論挑食、生理問題和降低餐桌衝突的方法。",
            "trust_note": "兒科醫師主持並有臨床專業來賓；口語已人工核驗。",
            "recognition": "醫師專業頻道 · 約 1.9 萬次觀看（2026-07 核驗）",
            "selection_reason": "把需要就醫的可能性和一般餐桌衝突分開，避免只靠意志力處理。",
            "url": "https://www.youtube.com/watch?v=O_djZ-0jfAw",
        },
        {
            "id": "food-fishball-parent-case-article",
            "kind": "article",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "魚丸醫師的媽媽經：兒醫媽媽對戰挑食寶寶",
            "publisher": "媽媽寶寶 · 魚丸醫師（兒科醫師、四寶媽）",
            "language": "繁體中文 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "description": "四寶媽以第一人稱記錄孩子成長曲線偏低帶來的焦慮、家庭餵養歷程與後續調整。",
            "trust_note": "作者同時是兒科醫師與母親；本條按家庭親身經驗呈現，不替代個別評估。",
            "recognition": "專業背景家長的第一人稱案例",
            "selection_reason": "呈現即使具專業背景，家長也會焦慮與試錯，適合理解實際取捨。",
            "case_evidence": "作者以四寶媽身份描述自己孩子的體重、挑食與家庭調整。",
            "case_evidence_url": "https://www.mombaby.com.tw/articles/9928389",
            "url": "https://www.mombaby.com.tw/articles/9928389",
        },
        {
            "id": "food-wanling-parent-case-video",
            "kind": "video",
            "content_category": "case",
            "source_tier": "curated",
            "selection_basis": "lived_experience",
            "title": "2～3 歲寶寶：孩子挑食、不愛吃飯，十個家庭方法",
            "publisher": "創業系媽媽婉翎",
            "language": "普通話視頻 · 台灣",
            "locales": ["zh-CN", "zh-TW"],
            "source_region": "TW",
            "spoken_language": "mandarin",
            "spoken_language_status": "verified",
            "language_evidence": "已人工聽檢開頭音軌，確認為普通話，未發現粵語。",
            "description": "母親以自家孩子吃飯慢、挑食的經驗，整理十個實際用過的方法。",
            "trust_note": "真實母親家庭經驗；不作營養醫療結論。",
            "recognition": "長期育兒創作者 · 約 1 萬次觀看（2026-07 核驗）",
            "selection_reason": "可看到家庭如何逐步調整，而不是把單一方法包裝成保證有效。",
            "case_evidence": "發布者以母親身份分享自己孩子的挑食問題與實際做法。",
            "case_evidence_url": "https://www.youtube.com/watch?v=RpYhoFN3dOc",
            "url": "https://www.youtube.com/watch?v=RpYhoFN3dOc",
        },
    ],
}

_LANGUAGE_MILESTONE_FOCUS_TAGS = [
    "语言",
    "沟通",
    "发声",
    "轮流发声",
    "音节",
    "重复音节",
    "模仿音节",
    "学他发音",
    "学她发音",
    "咿呀",
    "语音理解",
    "模仿声音",
    "声音回应",
    "回应名字",
    "名字反应",
    "叫他或她时会回应",
    "叫他时会回应",
    "叫她时会回应",
    "听到名字会回应",
    "短句回应",
]


_REVIEWED_LANGUAGE_MILESTONES_ZH_CN_RESOURCES = [
            {
                "id": "language-fhs-8-12-authority-article-zh-cn",
                "kind": "article",
                "content_category": "authority",
                "source_tier": "authority",
                "selection_basis": "official",
                "title": "儿童发展：八至十二个月大婴儿的语言与沟通",
                "publisher": "香港特别行政区政府卫生署家庭健康服务",
                "language": "简体中文",
                "locales": ["zh-CN"],
                "source_region": "HK",
                "script_language": "zh-Hans",
                "age_range_months": [8, 12],
                "focus_tags": ["语言", "沟通", "牙牙学语", "回应名字"],
                "description": "按八至十二个月的发展阶段说明牙牙学语、模仿单字、手势沟通、回应简单指示及需要留意的信号。",
                "trust_note": "香港卫生署家庭健康服务的阶段发展原始资料，2026 年重印。",
                "recognition": "政府儿童健康机构 · 阶段发展原始资料",
                "selection_reason": "直接覆盖当前月龄，并把语言理解、发声和非语言沟通放在同一阶段观察。",
                "url": "https://www.fhs.gov.hk/sc_chi/health_info/child/15697.html",
            },
            {
                "id": "language-unicef-responsive-authority-video-zh-cn",
                "kind": "video",
                "content_category": "authority",
                "source_tier": "authority",
                "selection_basis": "official",
                "title": "观察孩子的需求，并给予积极的回应",
                "publisher": "联合国儿童基金会",
                "language": "普通话视频 · 简体中文",
                "locales": ["zh-CN"],
                "source_region": "INTL",
                "script_language": "zh-Hans",
                "age_range_months": [0, 36],
                "focus_tags": ["语言", "沟通", "声音", "回应式互动"],
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "联合国儿童基金会简体中文发布页及普通话养育照护视频已核验。",
                "description": "示范怎样观察婴幼儿的动作、声音和表情，并及时回应这些沟通信号。",
                "trust_note": "联合国儿童基金会养育照护系列官方普通话视频。",
                "recognition": "国际儿童机构 · 普通话官方视频",
                "selection_reason": "把还不会说话时的声音、动作和表情也视为沟通，适合对照当前互动。",
                "url": "https://www.unicef.cn/videos/how-to-responsive-care",
            },
            {
                "id": "language-unicef-baby-talk-featured-article-zh-cn",
                "kind": "article",
                "content_category": "featured",
                "source_tier": "curated",
                "selection_basis": "expert_and_audience",
                "title": "如何与宝宝交流：把日常时刻变成语言练习",
                "publisher": "联合国儿童基金会 · 西悉尼大学 MARCS 婴儿研究实验室",
                "language": "简体中文",
                "locales": ["zh-CN"],
                "source_region": "INTL",
                "script_language": "zh-Hans",
                "age_range_months": [0, 12],
                "focus_tags": ["语言", "沟通", "儿向语", "日常互动"],
                "description": "婴儿语言习得研究者解释儿向语，并给出喂食、洗澡、玩耍和看图说话时可直接使用的方法。",
                "trust_note": "联合国儿童基金会发布，由西悉尼大学婴儿语言研究实验室负责人讲解。",
                "recognition": "大学婴儿语言研究者 · 简体中文专业导读",
                "selection_reason": "既解释宝宝为何会关注这种说话方式，也能立刻放进每天已经在做的照护场景。",
                "url": "https://www.unicef.cn/parenting-site/how-talk-your-baby",
            },
            {
                "id": "language-unicef-play-featured-video-zh-cn",
                "kind": "video",
                "content_category": "featured",
                "source_tier": "curated",
                "selection_basis": "expert_and_audience",
                "title": "陪伴孩子、鼓励孩子玩耍",
                "publisher": "联合国儿童基金会",
                "language": "普通话视频 · 简体中文",
                "locales": ["zh-CN"],
                "source_region": "INTL",
                "script_language": "zh-Hans",
                "age_range_months": [0, 36],
                "focus_tags": ["语言", "沟通", "亲子游戏", "日常互动"],
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "联合国儿童基金会简体中文发布页及普通话养育照护视频已核验。",
                "description": "用生活中随手可得的素材陪孩子玩，在来回互动中创造发声、模仿和共同注意的机会。",
                "trust_note": "联合国儿童基金会养育照护系列官方普通话视频。",
                "recognition": "国际儿童机构 · 普通话实操短片",
                "selection_reason": "短而具体，适合从一个日常游戏开始增加有回应的语言互动。",
                "url": "https://www.unicef.cn/videos/how-to-guide-your-children-to-learn-through-play",
            },
            {
                "id": "language-zhang-qin-case-article-zh-cn",
                "kind": "article",
                "content_category": "case",
                "source_tier": "curated",
                "selection_basis": "lived_experience",
                "title": "张琴奶奶的回应性照护实践：从交谈、唱歌和玩耍开始",
                "publisher": "联合国儿童基金会 · 真实家庭故事",
                "language": "简体中文",
                "locales": ["zh-CN"],
                "source_region": "INTL",
                "script_language": "zh-Hans",
                # This lived-experience item is intentionally age-neutral, so
                # it must match the concrete language signal that selected the
                # card instead of borrowing the child's age. Keep these tags
                # aligned with the production language-topic aliases.
                "focus_tags": [
                    *_LANGUAGE_MILESTONE_FOCUS_TAGS,
                    "交谈",
                    "回应式互动",
                ],
                "description": "记录一位照护者怎样把交谈、讲故事、唱歌和玩耍放进家庭日常，以及孩子语言表达逐步变清晰的过程。",
                "trust_note": "联合国儿童基金会记录的第一人称照护经历；案例不作为同月龄里程碑或普遍效果保证。",
                "recognition": "真实照护者经历 · 儿童早期发展项目",
                "selection_reason": "用于理解方法如何落到真实家庭，不用于把案例中的孩子与当前宝宝比较。",
                "case_evidence": "文章记录张琴作为主要照护者参加养育照护活动，并在家练习交谈、唱歌、玩耍和及时回应。",
                "case_evidence_url": "https://www.unicef.cn/stories/grandmothers-journey-raising-left-behind-children",
                "url": "https://www.unicef.cn/stories/grandmothers-journey-raising-left-behind-children",
            },
            {
                "id": "language-zhang-qin-case-video-zh-cn",
                "kind": "video",
                "content_category": "case",
                "source_tier": "curated",
                "selection_basis": "lived_experience",
                "title": "张琴奶奶学习回应性照护的真实历程",
                "publisher": "联合国儿童基金会 · 真实家庭视频",
                "language": "普通话视频 · 简体中文",
                "locales": ["zh-CN"],
                "source_region": "INTL",
                "script_language": "zh-Hans",
                "focus_tags": [
                    *_LANGUAGE_MILESTONE_FOCUS_TAGS,
                    "交谈",
                    "回应式互动",
                ],
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "联合国儿童基金会中文发布页的家庭采访视频，主要口语为普通话。",
                "description": "跟随真实照护者学习观察、交谈、鼓励和回应，并说明这些做法怎样进入每天的家庭互动。",
                "trust_note": "联合国儿童基金会发布的真实家庭记录；案例不代替个别儿童的语言发展评估。",
                "recognition": "儿童早期发展项目 · 普通话家庭案例",
                "selection_reason": "先看真实家庭怎样练习回应，再挑一个适合当前宝宝的互动动作尝试。",
                "case_evidence": "视频由张琴本人和参与项目的家庭出镜，记录其学习并实践回应性照护的过程。",
                "case_evidence_url": "https://www.unicef.cn/videos/grandmother-zhang-qin-learns-responsive-care",
                "url": "https://www.unicef.cn/videos/grandmother-zhang-qin-learns-responsive-care",
            },
]

_REVIEWED_CHINESE_FALLBACK_RESOURCES_BY_CARD_ID.update(
    {
        "learn_development_milestones": [
            {
                "id": "development-mama-cn-featured-article",
                "kind": "article",
                "content_category": "featured",
                "source_tier": "curated",
                "selection_basis": "expert_and_audience",
                "title": "别卷了！0 到 12 月宝宝大运动发育指南",
                "publisher": "妈妈网",
                "language": "简体中文",
                "locales": ["zh-CN"],
                "source_region": "CN",
                "script_language": "zh-Hans",
                "age_range_months": [10, 12],
                "focus_tags": ["关键期", "大运动", "发育"],
                "description": "按 0—4、5—9、10—12 月拆解动作发展，重点说明扶站、侧移、半蹲、安全边界与个体差异。",
                "trust_note": "妈妈网编辑内容；适合转化为家庭活动，应与权威里程碑和孩子自身表现一起阅读。",
                "recognition": "主流母婴内容平台 · 2026 年更新",
                "selection_reason": "正好回应 10 月龄和『关键期』焦虑，把笼统阶段转成当天可做的低压力活动。",
                "url": "https://www.mama.cn/baby/yinger/article/793653.html",
            },
            {
                "id": "development-guoma-featured-video",
                "kind": "video",
                "content_category": "featured",
                "source_tier": "curated",
                "selection_basis": "expert_and_audience",
                "title": "10 个月宝宝早教怎么做？带娃多玩这 8 个游戏",
                "publisher": "果妈的双倍幸福 · 双胞胎妈妈",
                "language": "普通话视频 · 简体中文",
                "locales": ["zh-CN"],
                "source_region": "CN",
                "script_language": "zh-Hans",
                "age_range_months": [10, 10],
                "focus_tags": ["亲子游戏", "高质量陪伴", "时间少"],
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "已人工听检视频前 60 秒，确认是连续普通话口播。",
                "description": "用 3 分 33 秒示范 8 个适合 10 月龄宝宝的低门槛亲子游戏，覆盖动作、互动和探索。",
                "trust_note": "双胞胎母亲的实操分享；活动建议不替代发育评估，应以孩子兴趣和安全为先。",
                "recognition": "约 2.8 万关注 · 约 6.2 万次观看（2026-08 核验）",
                "selection_reason": "年龄精确、短而具体，适合工作忙的父母挑一个游戏马上陪孩子做。",
                "url": "https://www.bilibili.com/video/BV17r4y1x7Hu/",
            },
            {
                "id": "development-sina-parent-case-article",
                "kind": "article",
                "content_category": "case",
                "source_tier": "curated",
                "selection_basis": "lived_experience",
                "title": "十个月成长记：动作、表达、陪玩和一拖二的真实一天",
                "publisher": "波希米亚檬檬 · 新浪博客家长记录",
                "language": "简体中文",
                "locales": ["zh-CN"],
                "source_region": "CN",
                "script_language": "zh-Hans",
                "age_range_months": [10, 10],
                "focus_tags": ["成长记录", "陪玩", "真实家庭"],
                "description": "一位母亲记录孩子 10 月龄时爬、扶走、表达需求、独立玩与需要陪玩的真实变化。",
                "trust_note": "公开第一人称家庭记录；只作为生活参照，不作为医学标准或训练要求。",
                "recognition": "长期公开家庭成长记录",
                "selection_reason": "让用户看到同月龄家庭的日常节奏，也明确个体经历不等于每个孩子都要达到的标准。",
                "case_evidence": "作者以母亲第一人称描述自己独自照顾两个孩子以及 10 月龄孩子的具体日常表现。",
                "case_evidence_url": "https://blog.sina.com.cn/s/blog_5de106b10101m3y8.html",
                "url": "https://blog.sina.com.cn/s/blog_5de106b10101m3y8.html",
            },
            {
                "id": "development-ahnian-parent-case-video",
                "kind": "video",
                "content_category": "case",
                "source_tier": "curated",
                "selection_basis": "lived_experience",
                "title": "独自带娃也要工作：新手妈妈的时间管理实录",
                "publisher": "找阿年 · 新手妈妈家庭 Vlog",
                "language": "普通话视频 · 简体中文",
                "locales": ["zh-CN"],
                "source_region": "CN",
                "script_language": "zh-Hans",
                "focus_tags": ["工作忙", "创业", "时间管理", "陪伴少"],
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "已人工听检 60—90 秒连续音轨，确认是普通话家庭口播。",
                "description": "用 8 分 22 秒记录新手妈妈独自带娃、处理工作和安排日常时间的真实过程。",
                "trust_note": "真实家长自制生活记录；孩子月龄不同，只借鉴忙碌家庭的时间安排，不用于比较发育。",
                "recognition": "约 3 万关注 · 约 6,100 次观看（2026-08 核验）",
                "selection_reason": "直接回应『工作忙、陪伴时间少』，让用户看到另一位家长怎样把工作和陪伴放进同一天。",
                "case_evidence": "发布者以新手妈妈第一人称记录自己独自带娃、继续工作和安排时间的真实一天。",
                "case_evidence_url": "https://www.bilibili.com/video/BV1U84y1271F/",
                "url": "https://www.bilibili.com/video/BV1U84y1271F/",
            },
            {
                "id": "development-parenting-featured-article",
                "kind": "article",
                "content_category": "featured",
                "source_tier": "curated",
                "selection_basis": "expert_reviewed",
                "title": "兒童發展篩檢怎麼做？掌握里程碑與需要求助的訊號",
                "publisher": "親子天下",
                "language": "繁體中文 · 台灣",
                "locales": ["zh-TW"],
                "source_region": "TW",
                "description": "由親子媒體整理兒童發展篩檢、觀察重點與何時尋求專業評估。",
                "trust_note": "成熟親子媒體的專業編輯內容；應與官方里程碑一起閱讀，不替代個別評估。",
                "recognition": "專業資料整理 · 家長決策導向",
                "selection_reason": "能把里程碑轉成日常觀察，也清楚說明發現疑問後的下一步。",
                "url": "https://www.parenting.com.tw/article/6002372",
            },
            {
                "id": "development-huang-featured-video",
                "kind": "video",
                "content_category": "featured",
                "source_tier": "curated",
                "selection_basis": "expert_and_audience",
                "title": "未滿七歲兒童發展篩檢：兒科與早療醫師完整說明",
                "publisher": "黃瑽寧醫師健康講堂 · 陳慧如醫師",
                "language": "普通話視頻 · 台灣",
                "locales": ["zh-TW"],
                "source_region": "TW",
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "YouTube 提供 zh-TW 字幕軌，台灣兒科與早療醫師以普通話對談，未發現粵語。",
                "description": "兒科醫師與早療中心醫師說明發展篩檢項目、流程和家長可如何準備。",
                "trust_note": "兒科醫師與早療專科醫師對談；普通話與繁體字幕已核驗。",
                "recognition": "醫師專業頻道 · 約 6.4 萬次觀看（2026-07 核驗）",
                "selection_reason": "能先降低家長對篩檢的未知感，再帶著具體觀察與醫師討論。",
                "url": "https://www.youtube.com/watch?v=z9216PI2Okw",
            },
            {
                "id": "development-kidaid-parent-case-article",
                "kind": "article",
                "content_category": "case",
                "source_tier": "curated",
                "selection_basis": "lived_experience",
                "title": "早療家庭故事：在孩子自己的步調裡看見進步",
                "publisher": "兒童發展資源網 · 台灣家庭故事",
                "language": "繁體中文 · 台灣",
                "locales": ["zh-TW"],
                "source_region": "TW",
                "description": "家長分享從發現發展疑問、尋求早療到陪孩子逐步練習的家庭歷程。",
                "trust_note": "公開家庭親身經驗；不作診斷或療效保證，需搭配專業評估。",
                "recognition": "真實早療家庭故事",
                "selection_reason": "讓家長看到求助並不等於替孩子貼標籤，而是多一份支持。",
                "case_evidence": "資源頁以照顧者第一人稱呈現家庭發現、求助與陪伴早療的歷程。",
                "case_evidence_url": "https://kidaid.org.tw/Experience/Story/1",
                "url": "https://kidaid.org.tw/Experience/Story/1",
            },
            {
                "id": "development-maria-parent-case-video",
                "kind": "video",
                "content_category": "case",
                "source_tier": "curated",
                "selection_basis": "lived_experience",
                "title": "漫漫早療路，陪你慢慢走：一位母親的真實歷程",
                "publisher": "瑪利亞社會福利基金會 · 早療家庭",
                "language": "普通話視頻 · 台灣",
                "locales": ["zh-TW"],
                "source_region": "TW",
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "已人工檢查前兩分鐘實際音軌；中文識別信心 0.9975，確認為台灣普通話，未發現粵語。",
                "description": "母親講述孩子從六個月起反覆就醫、尋找早療資源與逐步適應專業支持的過程。",
                "trust_note": "由台灣早療非營利機構發布的真實家庭案例；不替代個別醫療評估。",
                "recognition": "早療機構發布 · 真實家庭敘事",
                "selection_reason": "保留家長從擔心、找資料到接受幫助的真實過程，能降低孤單感。",
                "case_evidence": "母親第一人稱描述孩子發作、住院、搜尋資源及接受早療的完整經歷。",
                "case_evidence_url": "https://www.youtube.com/watch?v=XvPY_hKafUc",
                "url": "https://www.youtube.com/watch?v=XvPY_hKafUc",
            },
        ],
        "learn_language_milestones": [
            *_REVIEWED_CHINESE_FALLBACK_RESOURCES_BY_CARD_ID.get(
                "learn_language_milestones", []
            ),
            *_REVIEWED_LANGUAGE_MILESTONES_ZH_CN_RESOURCES,
            {
                "id": "language-parenting-featured-article",
                "kind": "article",
                "content_category": "featured",
                "source_tier": "curated",
                "selection_basis": "expert_reviewed",
                "title": "孩子語言發展怎麼觀察？理解里程碑與親子對話方法",
                "publisher": "親子天下",
                "language": "繁體中文 · 台灣",
                "locales": ["zh-TW"],
                "source_region": "TW",
                "description": "整理幼兒理解、表達與互動的發展線索，並提供日常可使用的語言刺激方法。",
                "trust_note": "成熟親子媒體的專業編輯內容；應與官方里程碑及專業評估一起使用。",
                "recognition": "專業資料整理 · 日常互動導向",
                "selection_reason": "不只看會說幾個字，也提醒家長觀察理解、手勢與來回互動。",
                "url": "https://www.parenting.com.tw/article/5086092",
            },
            {
                "id": "language-huang-featured-video",
                "kind": "video",
                "content_category": "featured",
                "source_tier": "curated",
                "selection_basis": "expert_and_audience",
                "title": "超過兩歲不說話，送幼兒園就會好？幼兒語言發展解析",
                "publisher": "黃瑽寧醫師健康講堂",
                "language": "普通話視頻 · 台灣",
                "locales": ["zh-TW"],
                "source_region": "TW",
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "YouTube 提供 zh-TW 字幕軌，台灣兒科醫師以普通話講解，未發現粵語。",
                "description": "兒科醫師解釋語言發展常見迷思、需留意的訊號和何時尋求評估。",
                "trust_note": "兒科醫師本人講解；普通話與繁體字幕已核驗。",
                "recognition": "醫師專業頻道 · 約 16.5 萬次觀看（2026-07 核驗）",
                "selection_reason": "直接處理家長最常見的『再等等就好嗎』疑問，並提供下一步。",
                "url": "https://www.youtube.com/watch?v=-d0DmEv8qVs",
            },
            {
                "id": "language-ptt-parent-case-article",
                "kind": "article",
                "content_category": "case",
                "source_tier": "curated",
                "selection_basis": "lived_experience",
                "title": "[寶寶] 語言發展較慢的就醫與家庭陪伴經驗",
                "publisher": "PTT BabyMother · 台灣家長",
                "language": "繁體中文 · 台灣",
                "locales": ["zh-TW"],
                "source_region": "TW",
                "description": "家長以第一人稱分享發現孩子較少說話、尋求評估及在家陪伴練習的經驗。",
                "trust_note": "公開第一人稱家長經驗；不作診斷、療效或普遍發展標準。",
                "recognition": "真實父母經驗",
                "selection_reason": "呈現家長怎麼從擔心走到採取行動，也保留每個孩子進度不同的現實。",
                "case_evidence": "作者以照顧者第一人稱描述孩子的語言情況、求助與家庭做法。",
                "case_evidence_url": "https://www.ptt.cc/bbs/BabyMother/M.1427736608.A.7D6.html",
                "url": "https://www.ptt.cc/bbs/BabyMother/M.1427736608.A.7D6.html",
            },
            {
                "id": "language-mosen-parent-case-video",
                "kind": "video",
                "content_category": "case",
                "source_tier": "curated",
                "selection_basis": "lived_experience",
                "title": "帶兩歲半兒子看醫師：不說話背後的家庭觀察",
                "publisher": "默森夫妻 · 台灣父母",
                "language": "普通話視頻 · 台灣",
                "locales": ["zh-TW"],
                "source_region": "TW",
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "已人工檢查實際音軌；中文識別信心 0.9981，確認為台灣普通話，未發現粵語。",
                "description": "父母記錄孩子理解很多但較少開口的觀察，以及帶孩子就醫了解原因的過程。",
                "trust_note": "真實家庭第一人稱記錄；個別結果不可推廣為診斷或固定處理方式。",
                "recognition": "真實家庭頻道 · 約 15.6 萬次觀看（2026-07 核驗）",
                "selection_reason": "讓家長看到如何把日常觀察整理後帶給專業人員，而不是自行下結論。",
                "case_evidence": "父母直接描述兩歲半兒子的理解、說話情況與就醫經過。",
                "case_evidence_url": "https://www.youtube.com/watch?v=vcjbqp3K-fM",
                "url": "https://www.youtube.com/watch?v=vcjbqp3K-fM",
            },
        ],
        "learn_tantrum_boundaries": [
            {
                "id": "behavior-parenting-featured-article",
                "kind": "article",
                "content_category": "featured",
                "source_tier": "curated",
                "selection_basis": "expert_reviewed",
                "title": "孩子情緒失控怎麼辦？理解發脾氣並守住界限",
                "publisher": "親子天下",
                "language": "繁體中文 · 台灣",
                "locales": ["zh-CN", "zh-TW"],
                "source_region": "TW",
                "description": "從孩子發展與家長情緒出發，整理同理、界限和事後修復的可行做法。",
                "trust_note": "成熟親子媒體的專業編輯內容；不是心理或醫療診斷。",
                "recognition": "專業資料整理 · 家庭場景導向",
                "selection_reason": "不把同理誤解成放任，也不把界限等同懲罰，適合對照日常衝突。",
                "url": "https://www.parenting.com.tw/article/6002157",
            },
            {
                "id": "behavior-huang-featured-video",
                "kind": "video",
                "content_category": "featured",
                "source_tier": "curated",
                "selection_basis": "expert_reviewed",
                "title": "面對孩子失控會生氣：用情緒釐清自己的界線",
                "publisher": "黃瑽寧醫師的暢所育言 · 諮商心理師周慕姿",
                "language": "普通話視頻 · 台灣",
                "locales": ["zh-CN", "zh-TW"],
                "source_region": "TW",
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "YouTube 提供 zh-TW 字幕軌，台灣兒科醫師與諮商心理師以普通話對談，未發現粵語。",
                "description": "兒科醫師與心理師討論父母生氣背後的界限，及如何避免在孩子失控時互相升級。",
                "trust_note": "兒科醫師與諮商心理師專業對談；普通話與繁體字幕已核驗。",
                "recognition": "醫師與心理師專業對談",
                "selection_reason": "先理解家長自己的觸發點，再用穩定而清楚的方式守住界限。",
                "url": "https://www.youtube.com/watch?v=Zf-bnmxe2GE",
            },
            {
                "id": "behavior-mummy-parent-case-article",
                "kind": "article",
                "content_category": "case",
                "source_tier": "curated",
                "selection_basis": "lived_experience",
                "title": "家有愛發脾氣的孩子：一個家庭的試錯與調整",
                "publisher": "Mummy 媽咪 · 台灣家長",
                "language": "繁體中文 · 台灣",
                "locales": ["zh-CN", "zh-TW"],
                "source_region": "TW",
                "description": "家長記錄自家孩子發脾氣的場景、自己的反應和後續調整；文中部分處罰觀點需批判閱讀。",
                "trust_note": "公開第一人稱家庭經驗，含可能過時或不適合所有家庭的處罰觀點；不可當作專業建議。",
                "recognition": "真實家庭經驗 · 供比較反思",
                "selection_reason": "案例價值在於辨認升級過程與家長試錯，不代表 NURI 認可文中每個做法。",
                "case_evidence": "作者明確以自己家庭為例，描述孩子發脾氣與家長回應的實際經過。",
                "case_evidence_url": "https://mummy.com.tw/archives/27329",
                "url": "https://mummy.com.tw/archives/27329",
            },
            {
                "id": "behavior-mothers-parent-case-video",
                "kind": "video",
                "content_category": "case",
                "source_tier": "curated",
                "selection_basis": "lived_experience",
                "title": "小孩壞脾氣到底誰的錯？多位媽媽的真實討論",
                "publisher": "東森超視 · 媽媽好神",
                "language": "普通話視頻 · 台灣",
                "locales": ["zh-CN", "zh-TW"],
                "source_region": "TW",
                "spoken_language": "mandarin",
                "spoken_language_status": "verified",
                "language_evidence": "已人工檢查兩段實際音軌；中文識別信心 0.9987/0.9999，確認為台灣普通話，未發現粵語。",
                "description": "多位母親以真實家庭衝突為例，搭配專業來賓討論孩子打人、摔東西與家長回應。",
                "trust_note": "電視談話節目中的家庭經驗與討論；不可替代個別心理或醫療評估。",
                "recognition": "多位家長案例 · 約 4 萬次觀看（2026-07 核驗）",
                "selection_reason": "能比較不同家庭的觸發情境和反應，也提醒觀眾分辨經驗與專業原則。",
                "case_evidence": "節目由多位母親分享自己孩子發脾氣、打人或摔東西的家庭情境。",
                "case_evidence_url": "https://www.youtube.com/watch?v=0ViH51hnaKg",
                "url": "https://www.youtube.com/watch?v=0ViH51hnaKg",
            },
        ],
    }
)

_DELIVERY_SOURCE_CONTRACT_VERSION = "source-lanes-v1"
_NURI_GUIDE_DISCLAIMER = (
    "外部内容为英文原文；中文内容由 NURI 导读，不是发布机构的官方翻译；"
    "重要结论请以原文为准。"
)


def _reviewed_delivery_resource(resource: dict) -> dict:
    """Mark an exact, manually opened URL as an instant delivery candidate."""

    category = str(resource["content_category"])
    kind = str(resource["kind"])
    value = {
        "source_tier": "authority" if category == "authority" else "curated",
        "selection_basis": {
            "authority": "official",
            "featured": "expert_and_audience",
            "case": "lived_experience",
        }[category],
        "source_quality_lane": {
            "authority": "primary_evidence",
            "featured": "high_readability",
            "case": "lived_experience",
        }[category],
        "source_language": "en",
        "display_locale": "zh-CN",
        "language": "英文原文 · NURI 中文导读",
        "locales": ["zh-CN", "en"],
        "translation_type": "nuri_guide",
        "translation_disclaimer": _NURI_GUIDE_DISCLAIMER,
        "research_source": "reviewed_whitelist",
        "delivery_source_contract": _DELIVERY_SOURCE_CONTRACT_VERSION,
        "link_health_status": "manual_verified",
        "content_page_type": kind,
        "commercial_risk": "clear",
        **resource,
    }
    value["chinese_guide"] = str(value.get("description") or "")
    if kind == "video":
        value.update(
            {
                "spoken_language": "english",
                "spoken_language_status": "verified",
                "spoken_language_evidence": "已核验为英文原声的具体视频播放页。",
                "spoken_language_evidence_url": value["url"],
                "video_page_evidence": "已核验为具体视频播放页，不是频道、合集或广告落地页。",
                "video_page_evidence_url": value["url"],
            }
        )
    return value


# A small, exact-URL MVP baseline keeps the product usable when live web search
# is rate-limited.  It is deliberately separate from the legacy static library:
# every entry was opened on 2026-08-04, the three editorial lanes use different
# sources, and English destinations are always labelled as NURI-guided originals.
_REVIEWED_DELIVERY_RESOURCES_BY_CARD_ID = {
    "learn_language_milestones": [
        _reviewed_delivery_resource(
            {
                "id": "language-asha-authority-article-reviewed-v1",
                "kind": "article",
                "content_category": "authority",
                "title": "Communication Milestones: Birth to 1 Year",
                "publisher": "American Speech-Language-Hearing Association",
                "description": "按 7–12 个月整理听力、手势、声音模仿与轮流交流信号，并给家长日常互动方法。",
                "trust_note": "美国言语语言听力专业协会的分龄原始资料。",
                "recognition": "专业协会 · 7–12 个月沟通里程碑",
                "selection_reason": "与 11 个月宝宝的回应名字、模仿音节和来回发声直接对应。",
                "age_range_months": [7, 12],
                "focus_tags": ["语言", "沟通", "模仿音节", "回应名字"],
                "url": "https://www.asha.org/public/developmental-milestones/communication-milestones-birth-to-1-year/",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "language-cdc-authority-video-reviewed-v1",
                "kind": "video",
                "content_category": "authority",
                "title": "1 Year – Calls a parent ‘mama’ or ‘dada’ or another special name",
                "publisher": "CDC",
                "description": "CDC 用真实短片展示一岁左右宝宝有意义地称呼主要照顾者这一语言里程碑。",
                "trust_note": "美国 CDC 官方一岁发展里程碑示例视频。",
                "recognition": "CDC 官方短片 · 具体行为示例",
                "selection_reason": "六秒画面让家长迅速看懂一个具体沟通信号，而不是只读抽象清单。",
                "age_range_months": [10, 14],
                "focus_tags": ["语言", "沟通", "称呼", "发声"],
                "evidence_url": "https://www.cdc.gov/act-early/milestones/1-year.html",
                "url": "https://www.youtube.com/watch?v=zQafMJwPzKQ",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "language-cdc-9m-authority-video-reviewed-v1",
                "kind": "video",
                "content_category": "authority",
                "title": "9 Months – Makes different sounds like ‘mamamama’ and ‘babababa’",
                "publisher": "CDC",
                "description": "CDC 用真实短片展示九月龄宝宝连续发出不同音节这一语言与沟通里程碑。",
                "trust_note": "美国 CDC 官方九月龄发展里程碑示例视频。",
                "recognition": "CDC 官方短片 · 九月龄具体行为示例",
                "selection_reason": "直接对应孩子目前反复发出“爸爸爸爸”“妈妈妈妈”等音节的表现。",
                "age_range_months": [8, 10],
                "focus_tags": ["语言", "沟通", "模仿音节", "连续发声"],
                "evidence_url": "https://www.cdc.gov/act-early/milestones-in-action/9-months.html",
                "url": "https://www.youtube.com/watch?v=ah7h8pz02NY",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "language-asha-authority-video-reviewed-v1",
                "kind": "video",
                "content_category": "authority",
                "title": "ASHA's Developmental Milestones: Communication",
                "publisher": "American Speech-Language-Hearing Association",
                "description": "ASHA 用四分钟把听力、语音、语言理解和来回交流的发展路径连起来。",
                "trust_note": "美国言语语言听力专业协会官方频道发布。",
                "recognition": "ASHA 官方讲解 · 4:25 · 约 8,700 次观看",
                "selection_reason": "作为 CDC 月龄短片的备选，它更完整地解释了家长应该怎么连续观察，而不是只看一个动作。",
                "age_range_months": [7, 12],
                "focus_tags": ["语言", "沟通", "听力", "咿呀", "来回互动"],
                "evidence_url": "https://www.asha.org/public/developmental-milestones/communication-milestones-birth-to-1-year/",
                "url": "https://www.youtube.com/watch?v=1JpCAB-4iCw",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "language-weetalkers-featured-article-reviewed-v1",
                "kind": "article",
                "content_category": "featured",
                "title": "A New Parent’s Guide to Teaching Baby Their First Words",
                "publisher": "Wee Talkers · 儿童言语语言治疗师",
                "description": "两位儿童言语语言治疗师把共同注意、理解词语、模仿声音和第一词拆成家长能在日常里直接使用的方法。",
                "trust_note": "作者 Katie Sterbenz 与 Carly Tulloch 均为专业言语语言治疗师，合计拥有 25 年以上经验。正文后有作者自有课程入口，NURI 只推荐免费文章内容。",
                "recognition": "两位 SLP 专业创作者 · 25+ 年经验 · 高可读性指南",
                "selection_reason": "没有把九月龄发音当作考试，而是用短段落和真实日常例子告诉家长今天可以怎样回应。",
                "age_range_months": [0, 12],
                "focus_tags": ["语言", "沟通", "共同注意", "模仿声音", "第一词"],
                "publisher_evidence_url": "https://www.weetalkers.com/about",
                "commercial_risk": "creator_self_promo",
                "url": "https://www.weetalkers.com/blog/a-new-parents-guide-to-teaching-baby-their-first-words",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "language-pedsdoctalk-featured-video-reviewed-v1",
                "kind": "video",
                "content_category": "featured",
                "title": "Baby Speech Milestones: First Year Language Skills and Tips for Parents",
                "publisher": "Dr. Mona Amin · PedsDocTalk",
                "description": "儿科医生用十三分钟讲清首年语言基础、零至十二月龄变化、唱歌、停顿等待、手势和轮流对话。",
                "trust_note": "Mona Amin 是美国执业儿科医生、认证儿科专科医师与 IBCLC，拥有十年以上临床经验。视频说明区含创作者自有免费资料和产品入口，主体视频不是品牌赞助广告。",
                "recognition": "专业育儿创作者 · 跨平台 150 万+ 社区 · 约 5.6 万次观看",
                "selection_reason": "既解释九月龄连续音节意味着什么，也给出马上能做的互动方法和需要咨询专业人员的边界。",
                "age_range_months": [0, 12],
                "focus_tags": ["语言", "沟通", "音节", "手势", "轮流对话", "何时求助"],
                "publisher_evidence_url": "https://pedsdoctalk.com/about/",
                "commercial_risk": "creator_self_promo",
                "url": "https://www.youtube.com/watch?v=6B4IHAXY7hc",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "language-emma-hubbard-featured-video-reviewed-v1",
                "kind": "video",
                "content_category": "featured",
                "title": "Best Ways To Teach Your Baby to Talk (Simple, Stress-Free Strategies)",
                "publisher": "Emma Hubbard · Brightest Beginning",
                "description": "儿科职能治疗师用真实宝宝画面演示怎么跟随孩子注意、留停顿、模仿声音并把单词放进日常。",
                "trust_note": "Emma Hubbard 是儿科职能治疗师，拥有十二年以上经验；频道有创作者自有资源入口，这条视频主体是免费实操讲解。",
                "recognition": "专业育儿创作者 · 约 55.6 万次观看 · 10:08",
                "selection_reason": "换一组时提供不同的专业创作者，重点是家长马上能照做的互动动作。",
                "age_range_months": [6, 12],
                "focus_tags": ["语言", "沟通", "停顿等待", "模仿声音", "日常练习"],
                "publisher_evidence_url": "https://brightestbeginning.com/about/",
                "commercial_risk": "creator_self_promo",
                "url": "https://www.youtube.com/watch?v=yksO0xiW9DY",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "language-todays-parent-case-article-reviewed-v1",
                "kind": "article",
                "content_category": "case",
                "title": "她听到宝宝叫‘mum-mum’：第一词到底怎么算？",
                "publisher": "Today's Parent · 真实家庭经历与 SLP 解读",
                "description": "以 Yvonne Edwards 和女儿 Bronwen 的第一词亲历开场，再由两位言语语言治疗师说清六至十月龄音节、重复咿呀和真正“第一词”的区别。",
                "trust_note": "编辑采访的真实家庭经历，配合言语语言治疗师解读；不用单个孩子作发育标准。",
                "recognition": "真实家庭开场 · 两位 SLP 解读 · 6–10 月龄直接相关",
                "selection_reason": "比只有几句的旧日记更完整：既有家长当时的感受，也能帮你理解现在的‘妈妈妈妈’是否已经有意义。",
                "age_range_months": [6, 12],
                "focus_tags": ["语言", "沟通", "重复咿呀", "第一词", "真实家庭"],
                "case_evidence": "文章具体记录 Yvonne Edwards 听到女儿 Bronwen 在婴儿床里发出‘mum-mum’，并交代孩子后续的词语。",
                "case_evidence_url": "https://www.todaysparent.com/baby/baby-development/what-you-need-to-know-about-babys-first-words/",
                "url": "https://www.todaysparent.com/baby/baby-development/what-you-need-to-know-about-babys-first-words/",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "language-kancha-case-video-reviewed-v1",
                "kind": "video",
                "content_category": "case",
                "title": "9 Months Babbling：一分半真实家庭记录",
                "publisher": "Kancha · 真实家庭频道",
                "description": "一分三十四秒的未摆拍家庭片段，完整保留九月龄宝宝连续咿呀、停顿、看人和再次发声的自然节奏。",
                "trust_note": "家长原始发布的真实宝宝记录；无商品、课程或赞助内容。片中孩子为 9 月龄，只作 9–12 月这一阶段的互动案例，不作发育诊断或比较标准。",
                "recognition": "9 月龄原始家庭片段 · 1:34 · 约 12.3 万次观看",
                "selection_reason": "用户能看到一段足够长的自然过程，而不再是原来仅十一秒、几乎没有上下文的片段。",
                "age_range_months": [9, 12],
                "focus_tags": ["语言", "沟通", "重复咿呀", "自然发声", "真实家庭"],
                "case_evidence": "视频由家庭频道 Kancha 原始发布，标题和画面均明确为九月龄宝宝的家庭日常咿呀记录。",
                "case_evidence_url": "https://www.youtube.com/watch?v=EdN_R86SPB4",
                "url": "https://www.youtube.com/watch?v=EdN_R86SPB4",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "language-todays-parent-babble-case-article-reviewed-v1",
                "kind": "article",
                "content_category": "case",
                "title": "9 月龄 Gemma 的‘papa’：家长怎么听懂宝宝咿呀",
                "publisher": "Today's Parent · 真实家庭与专家解读",
                "description": "以 Kristina Phillips 和九月龄女儿 Gemma 的‘papa’经历为线索，解释婴儿如何从发音过渡到词义。",
                "trust_note": "真实母亲观察与专业解读并列；不把单个宝宝的时间表当作标准。",
                "recognition": "9 月龄家庭故事 · 专家解读咿呀阶段",
                "selection_reason": "作为换一组的案例文章，它继续聚焦九月龄，但从‘如何理解咿呀’而不是‘第一词算不算’切入。",
                "age_range_months": [6, 12],
                "focus_tags": ["语言", "沟通", "咿呀", "词义", "真实家庭"],
                "case_evidence": "文章记录 Kristina Phillips 观察九月龄女儿 Gemma 反复用‘papa’称呼外公的具体经历。",
                "case_evidence_url": "https://www.todaysparent.com/baby/baby-development/baby-babble/",
                "url": "https://www.todaysparent.com/baby/baby-development/baby-babble/",
            }
        ),
    ],
    "learn_serve_and_return": [
        _reviewed_delivery_resource(
            {
                "id": "connection-harvard-authority-article-reviewed-v1",
                "kind": "article",
                "content_category": "authority",
                "title": "Serve and Return",
                "publisher": "Harvard Center on the Developing Child",
                "description": "哈佛用清晰网页解释婴幼儿发出信号、照顾者回应的来回互动，以及它为何支持语言和大脑发展。",
                "trust_note": "哈佛大学发展中儿童中心的 Serve and Return 官方专题页。",
                "recognition": "哈佛官方 · 可直接阅读的专题页",
                "selection_reason": "先理解核心原理，再把观察和回应放进换尿布、吃饭或等候等零碎时间。",
                "age_range_months": [0, 36],
                "focus_tags": ["陪伴", "亲子互动", "回应式互动", "时间少"],
                "url": "https://developingchild.harvard.edu/key-concept/serve-and-return/",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "connection-harvard-authority-video-reviewed-v1",
                "kind": "video",
                "content_category": "authority",
                "title": "5 Steps for Brain-Building Serve and Return",
                "publisher": "Harvard Center on the Developing Child",
                "description": "哈佛官方视频用成人与婴幼儿互动的真实画面演示来回回应五步法。",
                "trust_note": "哈佛大学发展中儿童中心官方视频。",
                "recognition": "哈佛官方示范视频",
                "selection_reason": "先看具体动作，再在换尿布、吃饭或散步时只练其中一步。",
                "age_range_months": [0, 36],
                "focus_tags": ["陪伴", "亲子互动", "回应式互动"],
                "evidence_url": "https://developingchild.harvard.edu/key-concept/serve-and-return/",
                "url": "https://www.youtube.com/watch?v=KNrnZag17Ek",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "connection-vroom-featured-article-reviewed-v1",
                "kind": "article",
                "content_category": "featured",
                "title": "Ready, Set, Vroom: Brain Building for New Parents",
                "publisher": "Vroom · Bezos Family Foundation",
                "description": "面向忙碌新父母，把等候、吃饭、换尿布和出门等已有日常转化为短而有效的互动。",
                "trust_note": "Vroom 的家庭友好型脑发展内容，强调无需额外器材或大段时间。",
                "recognition": "高可读性 · 忙碌父母场景",
                "selection_reason": "直接回应“创业忙、陪伴时间少”，重点不是增加任务，而是提高已有片刻的质量。",
                "age_range_months": [0, 36],
                "focus_tags": ["高质量陪伴", "时间少", "亲子互动", "日常片刻"],
                "url": "https://www.vroom.org/new-parents",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "connection-vroom-featured-video-reviewed-v1",
                "kind": "video",
                "content_category": "featured",
                "title": "Brain Building Basics",
                "publisher": "Vroom · Bezos Family Foundation",
                "description": "三分钟示范观察、跟随、交谈、轮流和延伸，帮助父母把日常片刻变成高质量互动。",
                "trust_note": "Vroom 官方家庭教育视频；不是产品广告。",
                "recognition": "三分钟实操视频",
                "selection_reason": "结构清楚、容易看完，适合先学一个动作并立即尝试。",
                "age_range_months": [0, 36],
                "focus_tags": ["高质量陪伴", "亲子互动", "时间少"],
                "url": "https://www.youtube.com/watch?v=WQNm4ASB7iY",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "connection-meghan-working-mom-case-article-reviewed-v1",
                "kind": "article",
                "content_category": "case",
                "title": "10 Things I’ve Learned So Far As a Working Mom",
                "publisher": "Meghan Moloney · 真实职场母亲记录",
                "description": "一位母亲记录产后三个月复工后，在工作、喂养、陪玩、内疚与有限时间之间的真实取舍。",
                "trust_note": "第一人称家庭经验；不把个人安排当作每个家庭都应采用的方案。",
                "recognition": "职场母亲真实经历",
                "selection_reason": "与忙碌创业父母的时间冲突直接相关，也呈现试错和不完美，而不是标准答案。",
                "age_range_months": [3, 24],
                "focus_tags": ["工作忙", "陪伴时间少", "职场父母", "内疚"],
                "case_evidence": "作者以职场母亲第一人称回顾产后三个月复工及家庭时间安排。",
                "case_evidence_url": "https://www.meghanmoloney.com/10-things-ive-learned-so-far-as-a-working-mom/",
                "url": "https://www.meghanmoloney.com/10-things-ive-learned-so-far-as-a-working-mom/",
            }
        ),
        _reviewed_delivery_resource(
            {
                "id": "connection-unicef-grandfather-case-video-reviewed-v1",
                "kind": "video",
                "content_category": "case",
                "title": "Raising Parents: How a Ghanaian grandfather is challenging gender stereotypes",
                "publisher": "UNICEF · 真实家庭纪录",
                "description": "真实家庭纪录：祖父支持女儿兼顾工作、教育与育儿，让孩子持续得到照顾和互动。",
                "trust_note": "UNICEF 发布的家庭纪录；案例用于理解支持网络，不代表唯一家庭分工方式。",
                "recognition": "真实家庭纪录",
                "selection_reason": "把“父母时间不够”从个人内疚转向可协商的家庭支持与稳定回应。",
                "age_range_months": [0, 72],
                "focus_tags": ["工作忙", "陪伴时间少", "家庭支持", "共同照护"],
                "case_evidence": "视频记录一位祖父和女儿如何在真实家庭中共同承担照护与工作压力。",
                "case_evidence_url": "https://www.youtube.com/watch?v=FZcAZ0i9KnA",
                "url": "https://www.youtube.com/watch?v=FZcAZ0i9KnA",
            }
        ),
    ],
}


_AUTHORITY_RESOURCE_DEFAULTS = {
    "source_tier": "authority",
    "content_category": "authority",
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
    merged = {**defaults, **resource}
    if org_id := resource_parent_org_id(merged):
        # Domain/evidence mapping wins over mutable publisher spelling so the
        # same institution keeps one identity across languages and subdomains.
        merged["parent_org_id"] = org_id
    if not merged.get("content_category"):
        merged["content_category"] = (
            "featured" if merged.get("source_tier") == "curated" else "authority"
        )
    if merged.get("kind") == "video" and not merged.get("spoken_language"):
        locales = merged.get("locales") or []
        merged["spoken_language"] = (
            "mandarin" if any(locale in {"zh-CN", "zh-TW"} for locale in locales) else "english"
        )
        merged["spoken_language_status"] = "verified"
        merged["language_evidence"] = "该审核资源的主要口语语言已人工确认。"
    if merged.get("kind") == "video":
        merged.setdefault(
            "spoken_language_evidence",
            merged.get("language_evidence")
            or "该审核资源的主要口语语言已人工确认。",
        )
        merged.setdefault("spoken_language_evidence_url", merged.get("url"))
    return merged


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
            *_LOCALIZED_RESOURCES_BY_CARD_ID.get(
                f"{_card['id']}_reviewed", []
            ),
            *_REVIEWED_DELIVERY_RESOURCES_BY_CARD_ID.get(_card["id"], []),
            *_reviewed_english_resources,
            *_CURATED_RESOURCES_BY_CARD_ID.get(_card["id"], []),
            *_REVIEWED_CHINESE_FALLBACK_RESOURCES_BY_CARD_ID.get(_card["id"], []),
        ]
    ]


# Creator/social-platform and curated editorial hosts are not trusted as whole
# sites. Every URL already stored in the reviewed fallback library is admitted
# individually; a newly discovered page on the same host must pass dynamic
# validation or be added through an explicit review.
REVIEWED_LIBRARY_RESOURCE_URLS = frozenset(
    str(resource.get("url") or "").split("#", 1)[0].rstrip("/")
    for card in LEARNING_CONTENT_CARDS
    for resource in card.get("resources", [])
    if str(resource.get("url") or "").startswith("https://")
)


LEARNING_CONTENT_BY_ID = {card["id"]: card for card in LEARNING_CONTENT_CARDS}
